import type { AgentState, TasteSynthesis } from '$lib/context/types';
import { context } from '$lib/server/context';
import {
	emitAgentStatus,
	emitFacadeStale,
	emitSessionReady,
	emitStageChanged,
	emitSynthesisUpdated,
	emitError,
	classifyErrorCode,
	onSwipeResult
} from '$lib/server/bus';
import { stopAllScouts } from './scout';
import { buildRevealDraft } from './builder';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { debugLog } from '$lib/server/debug-log';
import { FAST_MODEL } from '$lib/server/ai';

// ── Constants ────────────────────────────────────────────────────────

const ORACLE_AGENT_ID = 'oracle';
const REVEAL_THRESHOLD = 15;
const SYNTHESIS_CADENCE = 4;

// ── Synthesis schema (snake_case — matches spec + Zod output) ────────

const emergentAxisSchema = z.object({
	label: z.string(),
	poleA: z.string(),
	poleB: z.string(),
	confidence: z.enum(['unprobed', 'exploring', 'leaning', 'resolved']),
	leaning_toward: z.string().nullable(),
	evidence_basis: z.string()
});

const paletteSchema = z.object({
	bg: z.string(),       // background — e.g. "#FFF8F0"
	card: z.string(),     // card/surface — e.g. "#FFFFFF"
	accent: z.string(),   // primary accent — e.g. "#FF8C69"
	text: z.string(),     // main text — e.g. "#4A3E38"
	muted: z.string(),    // secondary text — e.g. "#A1887F"
	radius: z.string(),   // border-radius — e.g. "16px"
});

const synthesisSchema = z.object({
	axes: z.array(emergentAxisSchema),
	edge_case_flags: z.array(z.string()),
	palette: paletteSchema,  // derived from accepted evidence — consistent across all agent output
	scout_assignments: z.array(
		z.object({
			scout: z.string(),
			probe_axis: z.string(),
			reason: z.string()
		})
	),
	persona_anima_divergence: z.string().nullable()
});

const SYNTHESIS_PROMPT = `You are the Oracle — the strategic brain of a taste discovery system.

The user said they want to build: "{intent}"

FULL EVIDENCE (accept/reject + latency only — no user reasoning):

{evidence}

Analyze the evidence and produce EMERGENT TASTE AXES — dimensions that
have revealed themselves through the user's choices. These are NOT
pre-seeded. They are DISCOVERED from patterns in the evidence.

For each axis:
- label: short name for the taste dimension
- poleA / poleB: the two ends discovered from evidence
- confidence: unprobed | exploring | leaning | resolved
- leaning_toward: which pole (null if exploring/unprobed)
- evidence_basis: which accepts/rejects support this

Also produce:
- edge_case_flags: patterns needing special handling ("user accepts everything", "axis X contradictory", "all hesitant")
- palette: derive a 6-value design system from the evidence:
  - bg: background color (from accepted warmth/coolness evidence)
  - card: card/surface color
  - accent: primary accent color (from accepted visual direction)
  - text: main text color (ensure contrast against bg)
  - muted: secondary text color
  - radius: border-radius value (from accepted shape evidence — "16px" if rounded, "4px" if sharp)
  NEVER use blue (#0066CC, #2196F3, indigo) or purple unless evidence demands it.
  Ground every color choice in specific accepted/rejected evidence.
- scout_assignments: for 6 scouts (Iris, Prism, Lumen, Aura, Facet, Echo), assign each a DIFFERENT axis to probe next
- persona_anima_divergence: where revealed taste diverges from stated intent (null if none detected)`;

// ── Cold-start schema + prompt ───────────────────────────────────────

const coldStartSchema = z.array(
	z.object({
		scout: z.enum(['Iris', 'Prism', 'Lumen', 'Aura', 'Facet', 'Echo']),
		hypothesis: z.string(),
		word_probe: z.string()
	})
);

const COLD_START_PROMPT = `You are the Oracle. A user just started a session.

INTENT: "{INTENT}"

Produce 6 FIRST QUESTIONS — one for each scout. These are the opening
Akinator moves. Each question should probe a different taste dimension
that matters specifically for THIS product.

For each:
- scout: Iris | Prism | Lumen | Aura | Facet | Echo
- hypothesis: what accept vs reject would reveal
- word_probe: the 1-3 word label the user will see (PLAIN LANGUAGE, not jargon)

Iris probes look and feel. Prism probes layout and interaction. Lumen probes voice and personality.
Aura probes mood and atmosphere. Facet probes information design. Echo probes motion and behavior.

RULES:
- Questions must be INTENT-SPECIFIC, not generic design axes
- word_probe must be understandable in 1 second by a normal person
- Each question should target a DIFFERENT dimension
- Good: "Dark workspace" (tests atmosphere), "Sidebar tools" (tests layout), "Friendly helper" (tests personality)
- Bad: "Biophilic brutalism" (jargon), "Ephemeral layering" (nonsense), "Synaptic echo" (pretentious)`;

// ── Agent state ──────────────────────────────────────────────────────

const ORACLE_AGENT: AgentState = {
	id: ORACLE_AGENT_ID,
	name: 'Oracle',
	role: 'oracle',
	status: 'idle',
	focus: 'monitoring'
};

let cleanup: Array<() => void> = [];
let synthesisRunId = 0;
let busy = false;
let pendingSynthesis = false;
let revealFired = false;

// ── Helpers ──────────────────────────────────────────────────────────

function setOracleStatus(status: AgentState['status'], focus: string) {
	const next: AgentState = { ...ORACLE_AGENT, status, focus };
	context.agents.set(ORACLE_AGENT_ID, next);
	emitAgentStatus({ agent: next });
}

// ── Concreteness floor ───────────────────────────────────────────────

let lastFloor: 'word' | 'mockup' = 'word';

function checkFloor() {
	const floor = context.concretenessFloor;
	if (floor !== lastFloor) {
		lastFloor = floor;
		// Map floor to Stage for stage-changed event
		const stageMap = { word: 'words', mockup: 'mockups' } as const;
		context.stage = stageMap[floor];
		emitStageChanged({ stage: context.stage, swipeCount: context.swipeCount });
		console.log(`[oracle] concreteness floor → ${floor} (evidence: ${context.evidence.length})`);
	}
}

// ── Synthesis (async, non-blocking) ──────────────────────────────────

let lastSynthesizedAt = -1;

async function runSynthesis() {
	// Dedup: HMR can register multiple listeners — only synthesize once per evidence count
	if (context.evidence.length === lastSynthesizedAt) return;
	lastSynthesizedAt = context.evidence.length;

	const myRunId = ++synthesisRunId;
	busy = true;
	const capturedSessionId = context.sessionId;
	const evidenceSnapshot = context.toEvidencePrompt();

	setOracleStatus('thinking', 'synthesizing evidence');

	try {
		const prompt = SYNTHESIS_PROMPT
			.replace('{intent}', context.intent)
			.replace('{evidence}', evidenceSnapshot);

		const result = await generateText({
			model: FAST_MODEL,
			output: Output.object({ schema: synthesisSchema }),
			temperature: 0,
			prompt
		});

		// Session staleness guard — check before mutation AND emit
		if (context.sessionId !== capturedSessionId) {
			console.log('[oracle] session changed during synthesis, discarding');
			return;
		}

		if (result.output) {
			context.synthesis = result.output;

			// Derive CSS variable block from palette
			if (result.output.palette) {
				const p = result.output.palette;
				context.palette = `:root { --bg: ${p.bg}; --card: ${p.card}; --accent: ${p.accent}; --text: ${p.text}; --muted: ${p.muted}; --radius: ${p.radius}; }`;
			}

			emitSynthesisUpdated({ synthesis: result.output });
			debugLog('Oracle', 'synthesis', {
				evidence: context.evidence.length,
				axes: result.output.axes.map((a) => `${a.label} [${a.confidence}]`),
				assignments: result.output.scout_assignments.map((a) => `${a.scout}→${a.probe_axis}`),
				flags: result.output.edge_case_flags,
				divergence: result.output.persona_anima_divergence
			});
		}
	} catch (err) {
		debugLog('Oracle', 'synthesis-error', { error: String(err) });
		console.error('[oracle] synthesis failed:', err);
		emitError({
			source: 'oracle',
			code: classifyErrorCode(err),
			agentId: ORACLE_AGENT_ID,
			message: err instanceof Error ? err.message : String(err)
		});
	} finally {
		// Only clear the gate if this run still owns it
		if (synthesisRunId === myRunId) {
			busy = false;
			setOracleStatus('idle', 'monitoring');
			// Drain pending — catch up after burst of swipes
			if (pendingSynthesis) {
				pendingSynthesis = false;
				runSynthesis();
			}
		}
	}
}

// ── Session seed (cold-start intent analysis) ────────────────────────

export async function seedSession(intent: string): Promise<{ sessionId: string }> {
	debugLog('Oracle', 'session-start', { intent: intent.trim() });
	context.reset();
	context.intent = intent;
	context.sessionId = crypto.randomUUID();
	lastFloor = 'word';
	lastSynthesizedAt = -1;
	revealFired = false;
	synthesisRunId++;
	busy = false;
	pendingSynthesis = false;

	emitSessionReady({ intent });

	// Fire-and-forget: awaiting the cold-start LLM call would block POST
	// /api/session for ~2-3s under healthy auth. Scouts fall back to
	// self-assignment via getAxisAssignment() until synthesis lands.
	// runColdStart has its own sessionId staleness guards.
	void runColdStart(intent, context.sessionId);

	console.log(`[oracle] session created for "${intent}"`);
	return { sessionId: context.sessionId };
}

async function runColdStart(intent: string, capturedSessionId: string) {
	setOracleStatus('thinking', 'cold-start analysis');
	try {
		const result = await generateText({
			model: FAST_MODEL,
			output: Output.object({ schema: coldStartSchema }),
			temperature: 0,
			prompt: COLD_START_PROMPT.replace('{INTENT}', intent)
		});

		if (context.sessionId !== capturedSessionId) return;

		// Don't overwrite evidence-backed synthesis with stale cold-start
		if (context.synthesis && context.evidence.length > 0) {
			debugLog('Oracle', 'cold-start-skipped', { reason: 'real synthesis already landed' });
			return;
		}

		if (result.output) {
			context.synthesis = {
				axes: result.output.map((h) => ({
					label: h.hypothesis,
					poleA: h.word_probe,
					poleB: '(unknown)',
					confidence: 'unprobed' as const,
					leaning_toward: null,
					evidence_basis: 'intent analysis (no evidence yet)'
				})),
				edge_case_flags: [],
				scout_assignments: result.output.map((h) => ({
					scout: h.scout,
					probe_axis: h.hypothesis,
					reason: `Cold start: first question for ${h.scout}`
				})),
				persona_anima_divergence: null
			};
			emitSynthesisUpdated({ synthesis: context.synthesis });
			debugLog('Oracle', 'cold-start', {
				hypotheses: result.output.map((h) => `${h.scout}: "${h.word_probe}"`)
			});
		}
	} catch (err) {
		console.error('[oracle] cold-start failed, scouts will self-assign:', err);
		const code = classifyErrorCode(err);
		emitError({
			source: 'oracle',
			code,
			agentId: ORACLE_AGENT_ID,
			message: err instanceof Error ? err.message : String(err)
		});
		// Parallel to iter-23's scout.ts auth-break path: preserve the
		// diagnostic focus instead of falling through to the trailing
		// setOracleStatus('idle', 'monitoring') which would overwrite it.
		if (code === 'provider_auth_failure' && context.sessionId === capturedSessionId) {
			setOracleStatus('idle', 'provider auth failed');
			return;
		}
	}
	if (context.sessionId === capturedSessionId) {
		setOracleStatus('idle', 'monitoring');
	}
}

// ── Start oracle (idempotent) ────────────────────────────────────────

export function startOracle(): void {
	if (cleanup.length > 0) {
		cleanup.forEach((fn) => fn());
		cleanup = [];
	}

	busy = false;
	lastFloor = 'word';
	setOracleStatus('idle', 'monitoring');

	cleanup.push(
		onSwipeResult(() => {
			// Session freshness — ignore events if no active session
			if (!context.sessionId) return;

			// 1. Concreteness floor (synchronous)
			checkFloor();

			// 2. Reveal trigger (async — builder must finish before client sees reveal)
			if (!revealFired && context.stage !== 'reveal' && context.evidence.length >= REVEAL_THRESHOLD) {
				revealFired = true;
				context.stage = 'reveal';

				// Stale all queued facades so no more swipes are accepted
				for (const facade of [...context.facades]) {
					emitFacadeStale({ facadeId: facade.id });
				}
				context.facades.length = 0;

				// Stop all scouts — they'll see stage=reveal via alive() check
				stopAllScouts();

				setOracleStatus('thinking', 'building final prototype');
				console.log(`[oracle] reveal at ${context.evidence.length} evidence — awaiting builder`);

				// Builder does final synthesis FIRST, then we tell the client
				buildRevealDraft().finally(() => {
					emitStageChanged({ stage: 'reveal', swipeCount: context.swipeCount });
					setOracleStatus('idle', 'reveal complete');
					console.log('[oracle] reveal ready — client notified');
				});

				return;
			}

			// 3. Synthesis every N swipes (async, non-blocking)
			if (
				context.evidence.length > 0 &&
				context.evidence.length % SYNTHESIS_CADENCE === 0
			) {
				if (!busy) {
					runSynthesis();
				} else {
					// Burst of swipes — queue synthesis to run after current completes
					pendingSynthesis = true;
				}
			}
		})
	);

	console.log('[oracle] started');
}
