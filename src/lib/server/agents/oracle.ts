import type { AgentState, TasteSynthesis } from '$lib/context/types';
import { context } from '$lib/server/context';
import {
	emitAgentStatus,
	emitSessionReady,
	emitStageChanged,
	emitSynthesisUpdated,
	onSwipeResult
} from '$lib/server/bus';
import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { GEMINI_API_KEY } from '$env/static/private';

// ── Constants ────────────────────────────────────────────────────────

const ORACLE_AGENT_ID = 'oracle';
const REVEAL_THRESHOLD = 15;
const SYNTHESIS_CADENCE = 4;

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
const MODEL = google('gemini-3.1-flash-lite-preview');

// ── Synthesis schema (snake_case — matches spec + Zod output) ────────

const synthesisSchema = z.object({
	known: z.array(z.string()),
	unknown: z.array(z.string()),
	contradictions: z.array(z.string()),
	scout_guidance: z.string(),
	persona_anima_divergence: z.string().nullable()
});

const SYNTHESIS_PROMPT = `You are the Oracle — the strategic brain of a taste discovery system.

The user said they want to build: "{intent}"

FULL EVIDENCE (accept/reject + latency only — no user reasoning):

{evidence}

Produce a strategic synthesis:
1. KNOWN — consistent patterns in accepts and rejects
2. UNKNOWN — gaps where we have no evidence or mixed signals
3. CONTRADICTIONS — hesitant swipes or mixed signals
4. SCOUT GUIDANCE — what should scouts probe NEXT? Be specific.
5. PERSONA-ANIMA DIVERGENCE — does revealed taste diverge from stated intent?`;

// ── Agent state ──────────────────────────────────────────────────────

const ORACLE_AGENT: AgentState = {
	id: ORACLE_AGENT_ID,
	name: 'Oracle',
	role: 'oracle',
	status: 'idle',
	focus: 'monitoring'
};

let cleanup: Array<() => void> = [];
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
		busy = false;
		setOracleStatus('idle', 'monitoring');
	}
}

// ── Session seed (no LLM — first probes ARE the seed) ────────────────

export function seedSession(intent: string): { sessionId: string } {
	context.reset();
	context.intent = intent;
	context.sessionId = crypto.randomUUID();
	lastFloor = 'word';

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
