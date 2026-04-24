import type {
	AgentState,
	Facade,
	PrototypeDraft,
	QueueStats,
	Stage,
	SwipeEvidence,
	TasteSynthesis
} from '$lib/context/types';

export const RESERVOIR_MIN_READY = 12;
export const RESERVOIR_TARGET_READY = 20;
export const RESERVOIR_MAX_READY = 24;
export const RESERVOIR_LOW_WATER = 8;
export const RESERVOIR_STALE_VERSION_LAG = 2;

export type SessionRuntimeState =
	| 'creating'
	| 'warming'
	| 'ready'
	| 'swiping'
	| 'reveal-prepared'
	| 'revealing'
	| 'revealed';

export interface QueuedFacade extends Facade {
	tasteVersion: number;
	createdAt: number;
	generationReason: string;
	stale?: boolean;
}

export interface RevealState {
	prepared: boolean;
	preparing: boolean;
	finalizing: boolean;
	draft: PrototypeDraft | null;
	preparedAtSwipe: number | null;
	lastReason: string | null;
}

export interface SessionSnapshot {
	sessionId: string;
	intent: string;
	state: SessionRuntimeState;
	stage: Stage;
	swipeCount: number;
	tasteVersion: number;
	evidence: SwipeEvidence[];
	antiPatterns: string[];
	facades: QueuedFacade[];
	agents: AgentState[];
	draft: PrototypeDraft;
	synthesis: TasteSynthesis | null;
	queueStats: QueueStats;
	reveal: RevealState;
}
