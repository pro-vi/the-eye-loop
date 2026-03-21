import { EventEmitter } from 'node:events';
import type {
	SwipeRecord,
	SSEEventMap,
	SSEEventType
} from '$lib/context/types';

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

// ── Typed emit/listen derived from SSEEventMap ────────────────────────

function emit<K extends SSEEventType>(event: K, payload: SSEEventMap[K]) {
	emitter.emit(event, payload);
}

function on<K extends SSEEventType>(event: K, cb: (payload: SSEEventMap[K]) => void) {
	emitter.on(event, cb);
	return () => emitter.off(event, cb);
}

// ── Emit helpers ──────────────────────────────────────────────────────

export const emitFacadeReady: (p: SSEEventMap['facade-ready']) => void =
	(p) => emit('facade-ready', p);

export const emitFacadeStale: (p: SSEEventMap['facade-stale']) => void =
	(p) => emit('facade-stale', p);

export const emitSwipeResult: (p: SSEEventMap['swipe-result']) => void =
	(p) => {
		emit('swipe-result', p);
		emitter.emit(`swipe:${p.record.facadeId}`, { record: p.record });
	};

export const emitEvidenceUpdated: (p: SSEEventMap['evidence-updated']) => void =
	(p) => emit('evidence-updated', p);

export const emitAgentStatus: (p: SSEEventMap['agent-status']) => void =
	(p) => emit('agent-status', p);

export const emitBuilderHint: (p: SSEEventMap['builder-hint']) => void =
	(p) => emit('builder-hint', p);

export const emitStageChanged: (p: SSEEventMap['stage-changed']) => void =
	(p) => emit('stage-changed', p);

export const emitDraftUpdated: (p: SSEEventMap['draft-updated']) => void =
	(p) => emit('draft-updated', p);

export const emitSessionReady: (p: SSEEventMap['session-ready']) => void =
	(p) => emit('session-ready', p);

// ── Listen helpers ────────────────────────────────────────────────────

export const onFacadeReady = (cb: (p: SSEEventMap['facade-ready']) => void) =>
	on('facade-ready', cb);

export const onFacadeStale = (cb: (p: SSEEventMap['facade-stale']) => void) =>
	on('facade-stale', cb);

export const onSwipeResult = (cb: (p: SSEEventMap['swipe-result']) => void) =>
	on('swipe-result', cb);

export const onEvidenceUpdated = (cb: (p: SSEEventMap['evidence-updated']) => void) =>
	on('evidence-updated', cb);

export const onAgentStatus = (cb: (p: SSEEventMap['agent-status']) => void) =>
	on('agent-status', cb);

export const onBuilderHint = (cb: (p: SSEEventMap['builder-hint']) => void) =>
	on('builder-hint', cb);

export const onStageChanged = (cb: (p: SSEEventMap['stage-changed']) => void) =>
	on('stage-changed', cb);

export const onDraftUpdated = (cb: (p: SSEEventMap['draft-updated']) => void) =>
	on('draft-updated', cb);

export const onSessionReady = (cb: (p: SSEEventMap['session-ready']) => void) =>
	on('session-ready', cb);

// ── Scout blocking pattern ────────────────────────────────────────────

export function onceFacadeSwipe(facadeId: string): Promise<SwipeRecord> {
	return new Promise((resolve) => {
		emitter.once(`swipe:${facadeId}`, (e: { record: SwipeRecord }) => {
			resolve(e.record);
		});
	});
}

// ── Generic listener for SSE forwarding ───────────────────────────────

const SSE_EVENTS: SSEEventType[] = [
	'facade-ready',
	'facade-stale',
	'swipe-result',
	'evidence-updated',
	'agent-status',
	'builder-hint',
	'stage-changed',
	'draft-updated',
	'session-ready'
];

export function onAny(cb: <K extends SSEEventType>(event: K, payload: SSEEventMap[K]) => void) {
	const cleanups = SSE_EVENTS.map((name) => {
		const handler = (payload: SSEEventMap[typeof name]) => cb(name, payload);
		emitter.on(name, handler);
		return () => emitter.off(name, handler);
	});

	return () => cleanups.forEach((fn) => fn());
}
