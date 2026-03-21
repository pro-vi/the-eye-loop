import type { AgentState } from '$lib/context/types';
import { context } from '$lib/server/context';
import {
	emitAgentStatus,
	emitSessionReady,
	emitStageChanged,
	onSwipeResult
} from '$lib/server/bus';

const ORACLE_AGENT_ID = 'oracle';
const REVEAL_THRESHOLD = 15;

const ORACLE_AGENT: AgentState = {
	id: ORACLE_AGENT_ID,
	name: 'Oracle',
	role: 'oracle',
	status: 'idle',
	focus: 'monitoring'
};

let cleanup: Array<() => void> = [];

// ── Helpers ──────────────────────────────────────────────────────────

function setOracleStatus(status: AgentState['status'], focus: string) {
	const next: AgentState = { ...ORACLE_AGENT, status, focus };
	context.agents.set(ORACLE_AGENT_ID, next);
	emitAgentStatus({ agent: next });
}

// ── Session seed (no LLM — first probes ARE the seed) ────────────────

export function seedSession(intent: string): { sessionId: string } {
	context.reset();
	context.intent = intent;
	context.sessionId = crypto.randomUUID();

	setOracleStatus('thinking', 'session init');
	emitSessionReady({ intent });
	setOracleStatus('idle', 'monitoring');

	console.log(`[oracle] session created for "${intent}"`);
	// Scouts fill the queue — started by session endpoint, not here
	return { sessionId: context.sessionId };
}

// ── Start oracle (idempotent) ────────────────────────────────────────

export function startOracle(): void {
	if (cleanup.length > 0) {
		cleanup.forEach((fn) => fn());
		cleanup = [];
	}

	setOracleStatus('idle', 'monitoring');

	// Reveal trigger — evidence depth threshold only.
	// Concreteness is emergent (scout chooses format), not oracle-staged.
	cleanup.push(
		onSwipeResult(() => {
			if (context.stage === 'reveal') return;

			if (context.evidence.length >= REVEAL_THRESHOLD) {
				context.stage = 'reveal';
				emitStageChanged({ stage: 'reveal', swipeCount: context.swipeCount });
				setOracleStatus('thinking', 'reveal triggered');
				console.log(`[oracle] reveal triggered at ${context.evidence.length} evidence`);
			}
		})
	);

	console.log('[oracle] started');
}
