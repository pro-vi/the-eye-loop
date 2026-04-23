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

export const emitSynthesisUpdated: (p: SSEEventMap['synthesis-updated']) => void =
	(p) => emit('synthesis-updated', p);

export const emitSessionReady: (p: SSEEventMap['session-ready']) => void =
	(p) => emit('session-ready', p);

// Suppress repeat error spam: same (source, code, agentId) within the window
// is dropped. 401 loops across 6 scouts would otherwise dominate the bus.
// The map is cleared on every session-ready so a fresh session always emits
// its own errors even when they are identical to the previous session's —
// parallel class to context.ts:reset() clearing palette in iter-19.
const ERROR_EMIT_DEDUP_MS = 5_000;
const lastErrorEmit = new Map<string, number>();

export const emitError: (p: SSEEventMap['error']) => void = (p) => {
	const key = `${p.source}:${p.code}:${p.agentId ?? ''}`;
	const now = Date.now();
	const last = lastErrorEmit.get(key) ?? 0;
	if (now - last < ERROR_EMIT_DEDUP_MS) return;
	lastErrorEmit.set(key, now);
	emit('error', p);
};

// Session-scoped dedup reset: session N+1 starts with a fresh map so
// identical (source, code, agentId) failures surface even within the
// ERROR_EMIT_DEDUP_MS window. Registered at module load so it runs before
// any agent's session-ready subscriber — bus clears, then agents' async
// generateText fires, then 401 emits land on an empty map.
emitter.on('session-ready', () => lastErrorEmit.clear());

export function classifyErrorCode(err: unknown): SSEEventMap['error']['code'] {
	const s = err instanceof Error ? `${err.message}` : String(err);
	if (/401|Invalid bearer|authentication_error|x-api-key/i.test(s)) {
		return 'provider_auth_failure';
	}
	if (/AI_APICall|fetch failed|ECONNREFUSED|timeout/i.test(s)) {
		return 'provider_error';
	}
	return 'generation_error';
}

// ── Listen helpers ────────────────────────────────────────────────────

export const onSwipeResult = (cb: (p: SSEEventMap['swipe-result']) => void) =>
	on('swipe-result', cb);

export const onStageChanged = (cb: (p: SSEEventMap['stage-changed']) => void) =>
	on('stage-changed', cb);

export const onSessionReady = (cb: (p: SSEEventMap['session-ready']) => void) =>
	on('session-ready', cb);

// ── Facade visibility (client → server signal) ──────────────────────

export function emitFacadeVisible(facadeId: string) {
	emitter.emit(`visible:${facadeId}`);
}

// ── Scout blocking pattern ────────────────────────────────────────────

export function awaitFacadeSwipe(
	facadeId: string,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<SwipeRecord | 'timeout' | 'aborted' | 'stale'> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const settle = (v: SwipeRecord | 'timeout' | 'aborted' | 'stale') => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			emitter.off(`swipe:${facadeId}`, onSwipe);
			emitter.off(`visible:${facadeId}`, onVisible);
			emitter.off('facade-stale', onStale);
			signal?.removeEventListener('abort', onAbort);
			resolve(v);
		};
		const onSwipe = (e: { record: SwipeRecord }) => settle(e.record);
		const onStale = (e: { facadeId: string }) => {
			if (e.facadeId === facadeId) settle('stale');
		};
		const onAbort = () => settle('aborted');

		// Timeout starts only when the facade becomes visible (top card)
		const onVisible = () => {
			if (!settled) timer = setTimeout(() => settle('timeout'), timeoutMs);
		};

		emitter.once(`swipe:${facadeId}`, onSwipe);
		emitter.once(`visible:${facadeId}`, onVisible);
		emitter.on('facade-stale', onStale);
		if (signal) {
			if (signal.aborted) { settle('aborted'); return; }
			signal.addEventListener('abort', onAbort, { once: true });
		}
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
	'synthesis-updated',
	'session-ready',
	'error'
];

export function onAny(cb: <K extends SSEEventType>(event: K, payload: SSEEventMap[K]) => void) {
	const cleanups = SSE_EVENTS.map((name) => {
		const handler = (payload: SSEEventMap[typeof name]) => cb(name, payload);
		emitter.on(name, handler);
		return () => emitter.off(name, handler);
	});

	return () => cleanups.forEach((fn) => fn());
}
