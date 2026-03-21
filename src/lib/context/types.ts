// V0 Data Contract — Akinator pattern.
// Evidence-based taste discovery. No explicit axes.
// No runtime imports. No Zod. No classes. No z.union().

export type Stage = 'words' | 'images' | 'mockups' | 'reveal';

export interface SwipeEvidence {
	facadeId: string;
	content: string;
	hypothesis: string;
	decision: 'accept' | 'reject';
	latencySignal: 'fast' | 'slow';
}

export interface Facade {
	id: string;
	agentId: string;
	hypothesis: string;
	axisTargeted?: string;
	label: string;
	content: string;
	format: 'word' | 'image' | 'mockup';
	imageDataUrl?: string;
}

export interface SwipeRecord {
	facadeId: string;
	agentId: string;
	decision: 'accept' | 'reject';
	latencyMs: number;
	latencyBucket?: 'fast' | 'slow';
}

export interface AgentState {
	id: string;
	name: string;
	role: 'scout' | 'builder' | 'oracle';
	status: 'idle' | 'thinking' | 'queued' | 'waiting';
	focus: string;
	lastFacadeId?: string;
}

export interface PrototypeDraft {
	title: string;
	summary: string;
	html: string;
	acceptedPatterns: string[];
	rejectedPatterns: string[];
	nextHint?: string;
}

export interface ProbeBrief {
	source: string;
	priority: 'high' | 'normal';
	brief: string;
	context: string;
	heldConstant: string[];
}

export interface EmergentAxis {
	label: string;
	poleA: string;
	poleB: string;
	confidence: 'unprobed' | 'exploring' | 'leaning' | 'resolved';
	leaning_toward: string | null;
	evidence_basis: string;
}

export interface TasteSynthesis {
	axes: EmergentAxis[];
	edge_case_flags: string[];
	scout_assignments: Array<{ scout: string; probe_axis: string; reason: string }>;
	persona_anima_divergence: string | null;
}

export type SSEEvent =
	| { type: 'facade-ready'; facade: Facade }
	| { type: 'facade-stale'; facadeId: string }
	| { type: 'swipe-result'; record: SwipeRecord }
	| { type: 'evidence-updated'; evidence: SwipeEvidence[]; antiPatterns: string[] }
	| { type: 'agent-status'; agent: AgentState }
	| { type: 'draft-updated'; draft: PrototypeDraft }
	| { type: 'builder-hint'; hint: string }
	| { type: 'stage-changed'; stage: Stage; swipeCount: number }
	| { type: 'synthesis-updated'; synthesis: TasteSynthesis }
	| { type: 'session-ready'; intent: string }
	| { type: 'error'; message: string };

// Derive event map from SSEEvent — bus helpers and SSE forwarding use this
// to stay aligned with the union above at compile time.
type SSEEventByType<T extends SSEEvent['type']> = Extract<SSEEvent, { type: T }>;
export type SSEEventMap = {
	[E in SSEEvent as E['type']]: Omit<E, 'type'>;
};
export type SSEEventType = SSEEvent['type'];
