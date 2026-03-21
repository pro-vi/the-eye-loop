// V0 Data Contract — single source of truth for all shared types.
// No runtime imports. No Zod. No classes. No z.union().

export type Stage = 'words' | 'images' | 'mockups' | 'reveal';

export interface TasteAxis {
	id: string;
	label: string;
	options: [string, string];
	confidence: number;
	leaning?: string;
	evidenceCount: number;
}

export interface Facade {
	id: string;
	agentId: string;
	stage: Stage;
	hypothesis: string;
	axisId: string;
	content: string;
	imageDataUrl?: string;
}

export interface SwipeRecord {
	facadeId: string;
	agentId: string;
	axisId: string;
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

export type SSEEvent =
	| { type: 'facade-ready'; facade: Facade }
	| { type: 'facade-stale'; facadeId: string }
	| { type: 'swipe-result'; record: SwipeRecord; axisUpdate: TasteAxis }
	| { type: 'anima-updated'; axes: TasteAxis[]; antiPatterns: string[] }
	| { type: 'agent-status'; agent: AgentState }
	| { type: 'draft-updated'; draft: PrototypeDraft }
	| { type: 'builder-hint'; hint: string }
	| { type: 'stage-changed'; stage: Stage; swipeCount: number }
	| { type: 'session-ready'; intent: string; axes: TasteAxis[] }
	| { type: 'error'; message: string };

// Derive event map from SSEEvent — bus helpers and SSE forwarding use this
// to stay aligned with the union above at compile time.
type SSEEventByType<T extends SSEEvent['type']> = Extract<SSEEvent, { type: T }>;
export type SSEEventMap = {
	[E in SSEEvent as E['type']]: Omit<E, 'type'>;
};
export type SSEEventType = SSEEvent['type'];
