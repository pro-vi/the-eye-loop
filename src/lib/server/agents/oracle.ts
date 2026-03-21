import type { AgentState, TasteSynthesis } from '$lib/context/types';
import { context } from '$lib/server/context';
import {
	emitAgentStatus,
	emitFacadeStale,
	emitSessionReady,
	emitStageChanged,
	emitSynthesisUpdated,
	onSwipeResult
} from '$lib/server/bus';
import { stopAllScouts } from './scout';
import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { GEMINI_API_KEY } from '$env/static/private';

// ── Constants ────────────────────────────────────────────────────────

const ORACLE_AGENT_ID = 'oracle';
const REVEAL_THRESHOLD = 15;
const SYNTHESIS_CADENCE = 4;

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
const MODEL = google('gemini-3.1-pro-preview');

// ── Synthesis schema (snake_case — matches spec + Zod output) ────────

const emergentAxisSchema = z.object({
	label: z.string(),
	poleA: z.string(),
	poleB: z.string(),
	confidence: z.enum(['unprobed', 'exploring', 'leaning', 'resolved']),
	leaning_toward: z.string().nullable(),
	evidence_basis: z.string()
});

const synthesisSchema = z.object({
	axes: z.array(emergentAxisSchema),
	edge_case_flags: z.array(z.string()),
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
- scout_assignments: for 3 scouts (Iris, Prism, Lumen), assign each a DIFFERENT axis to probe next
- persona_anima_divergence: where revealed taste diverges from stated intent (null if none detected)`;

// ── Agent state ──────────────────────────────────────────────────────

const ORACLE_AGENT: AgentState = {
	id: ORACLE_AGENT_ID,
	name: 'Oracle',
	role: 'oracle',
	status: 'idle',
	focus: 'monitoring'
};

let cleanup: Array<() => void> = [];
let synthesisRunId = 0; // ownership token — only the owning run can clear the gate
let busy = false;

// ── Helpers ──────────────────────────────────────────────────────────

function setOracleStatus(status: AgentState['status'], focus: string) {
	const next: AgentState = { ...ORACLE_AGENT, status, focus };
	context.agents.set(ORACLE_AGENT_ID, next);
	emitAgentStatus({ agent: next });
}

// ── Concreteness floor ───────────────────────────────────────────────

let lastFloor: 'word' | 'image' | 'mockup' = 'word';

function checkFloor() {
	const floor = context.concretenessFloor;
	if (floor !== lastFloor) {
		lastFloor = floor;
		// Map floor to Stage for stage-changed event
		const stageMap = { word: 'words', image: 'images', mockup: 'mockups' } as const;
		context.stage = stageMap[floor];
		emitStageChanged({ stage: context.stage, swipeCount: context.swipeCount });
		console.log(`[oracle] concreteness floor → ${floor} (evidence: ${context.evidence.length})`);
	}
}

// ── Synthesis (async, non-blocking) ──────────────────────────────────

async function runSynthesis() {
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
			model: MODEL,
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
			emitSynthesisUpdated({ synthesis: result.output });
			console.log(`[oracle] synthesis complete (${context.evidence.length} evidence)`);
		}
	} catch (err) {
		console.error('[oracle] synthesis failed:', err);
	} finally {
		// Only clear the gate if this run still owns it
		if (synthesisRunId === myRunId) {
			busy = false;
			setOracleStatus('idle', 'monitoring');
		}
	}
}

// ── Session seed (no LLM — first probes ARE the seed) ────────────────

export function seedSession(intent: string): { sessionId: string } {
	context.reset();
	context.intent = intent;
	context.sessionId = crypto.randomUUID();
	lastFloor = 'word';
	synthesisRunId++; // invalidate any in-flight synthesis from previous session
	busy = false;

	setOracleStatus('thinking', 'session init');
	emitSessionReady({ intent });
	setOracleStatus('idle', 'monitoring');

	console.log(`[oracle] session created for "${intent}"`);
	return { sessionId: context.sessionId };
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

			// 2. Reveal trigger (synchronous)
			if (context.stage !== 'reveal' && context.evidence.length >= REVEAL_THRESHOLD) {
				context.stage = 'reveal';
				emitStageChanged({ stage: 'reveal', swipeCount: context.swipeCount });

				// Stale all queued facades so no more swipes are accepted
				for (const facade of [...context.facades]) {
					emitFacadeStale({ facadeId: facade.id });
				}
				context.facades.length = 0;

				// Stop all scouts — they'll see stage=reveal via alive() check
				stopAllScouts();

				setOracleStatus('thinking', 'reveal triggered');
				console.log(`[oracle] reveal at ${context.evidence.length} evidence`);
				return;
			}

			// 3. Synthesis every N swipes (async, non-blocking)
			if (
				context.evidence.length > 0 &&
				context.evidence.length % SYNTHESIS_CADENCE === 0 &&
				!busy
			) {
				runSynthesis();
			}
		})
	);

	console.log('[oracle] started');
}
