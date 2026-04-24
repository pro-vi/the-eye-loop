import type {
	AgentState,
	EmergentAxis,
	Facade,
	PrototypeDraft,
	QueueStats,
	SessionBootstrapResponse,
	Stage,
	SwipeEvidence,
	TasteSynthesis
} from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isStage(value: unknown): value is Stage {
	return value === 'words' || value === 'mockups' || value === 'reveal';
}

export function isFacade(value: unknown): value is Facade {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.agentId === 'string' &&
		typeof value.hypothesis === 'string' &&
		typeof value.label === 'string' &&
		typeof value.content === 'string' &&
		(value.format === 'word' || value.format === 'mockup')
	);
}

export function isSwipeEvidence(value: unknown): value is SwipeEvidence {
	return (
		isRecord(value) &&
		typeof value.facadeId === 'string' &&
		typeof value.content === 'string' &&
		typeof value.hypothesis === 'string' &&
		(value.decision === 'accept' || value.decision === 'reject') &&
		(value.latencySignal === 'fast' || value.latencySignal === 'slow') &&
		(value.format === 'word' || value.format === 'mockup') &&
		typeof value.implication === 'string'
	);
}

export function isAgentState(value: unknown): value is AgentState {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.name === 'string' &&
		(value.role === 'scout' || value.role === 'builder' || value.role === 'oracle') &&
		(value.status === 'idle' ||
			value.status === 'thinking' ||
			value.status === 'queued' ||
			value.status === 'waiting') &&
		typeof value.focus === 'string'
	);
}

export function isPrototypeDraft(value: unknown): value is PrototypeDraft {
	return (
		isRecord(value) &&
		typeof value.title === 'string' &&
		typeof value.summary === 'string' &&
		typeof value.html === 'string' &&
		isStringArray(value.acceptedPatterns) &&
		isStringArray(value.rejectedPatterns) &&
		(value.nextHint === undefined || typeof value.nextHint === 'string')
	);
}

function isEmergentAxis(value: unknown): value is EmergentAxis {
	return (
		isRecord(value) &&
		typeof value.label === 'string' &&
		typeof value.poleA === 'string' &&
		typeof value.poleB === 'string' &&
		(value.confidence === 'unprobed' ||
			value.confidence === 'exploring' ||
			value.confidence === 'leaning' ||
			value.confidence === 'resolved') &&
		(value.leaning_toward === null || typeof value.leaning_toward === 'string') &&
		typeof value.evidence_basis === 'string'
	);
}

function isScoutAssignment(value: unknown): value is TasteSynthesis['scout_assignments'][number] {
	return (
		isRecord(value) &&
		(value.scout === 'Iris' ||
			value.scout === 'Prism' ||
			value.scout === 'Lumen' ||
			value.scout === 'Aura' ||
			value.scout === 'Facet' ||
			value.scout === 'Echo') &&
		typeof value.probe_axis === 'string' &&
		typeof value.reason === 'string'
	);
}

export function isTasteSynthesis(value: unknown): value is TasteSynthesis {
	return (
		isRecord(value) &&
		Array.isArray(value.axes) &&
		value.axes.every(isEmergentAxis) &&
		isStringArray(value.edge_case_flags) &&
		Array.isArray(value.scout_assignments) &&
		value.scout_assignments.every(isScoutAssignment) &&
		(value.persona_anima_divergence === null ||
			typeof value.persona_anima_divergence === 'string')
	);
}

export function isQueueStats(value: unknown): value is QueueStats {
	return (
		isRecord(value) &&
		typeof value.ready === 'number' &&
		typeof value.target === 'number' &&
		typeof value.min === 'number' &&
		typeof value.max === 'number' &&
		typeof value.lowWater === 'number' &&
		typeof value.pending === 'number' &&
		typeof value.stale === 'number'
	);
}

export function isSessionBootstrapResponse(value: unknown): value is SessionBootstrapResponse {
	return (
		isRecord(value) &&
		typeof value.intent === 'string' &&
		typeof value.sessionId === 'string' &&
		Array.isArray(value.facades) &&
		value.facades.every(isFacade) &&
		Array.isArray(value.evidence) &&
		value.evidence.every(isSwipeEvidence) &&
		isStringArray(value.antiPatterns) &&
		Array.isArray(value.agents) &&
		value.agents.every(isAgentState) &&
		isPrototypeDraft(value.draft) &&
		(value.synthesis === null || isTasteSynthesis(value.synthesis)) &&
		isStage(value.stage) &&
		isQueueStats(value.queueStats) &&
		typeof value.revealPrepared === 'boolean'
	);
}
