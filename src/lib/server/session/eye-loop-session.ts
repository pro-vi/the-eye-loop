import { EventEmitter } from 'node:events';
import type {
	AgentState,
	Facade,
	PrototypeDraft,
	QueueStats,
	SessionBootstrapResponse,
	SSEEventMap,
	SSEEventType,
	Stage,
	SwipeEvidence,
	SwipeRecord,
	TasteSynthesis,
	ProbeBrief
} from '$lib/context/types';
import {
	RESERVOIR_LOW_WATER,
	RESERVOIR_MAX_READY,
	RESERVOIR_MIN_READY,
	RESERVOIR_STALE_VERSION_LAG,
	RESERVOIR_TARGET_READY,
	type QueuedFacade,
	type RevealState,
	type SessionRuntimeState,
	type SessionSnapshot
} from './types';

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
	'queue-updated',
	'reveal-prepared',
	'error'
];

function emptyDraft(): PrototypeDraft {
	return {
		title: '',
		summary: '',
		html: '',
		acceptedPatterns: [],
		rejectedPatterns: []
	};
}

function defaultRevealState(): RevealState {
	return {
		prepared: false,
		preparing: false,
		finalizing: false,
		draft: null,
		preparedAtSwipe: null,
		lastReason: null
	};
}

function escapeHtml(input: string): string {
	return input.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
}

function isErrorEmission(emission: {
	event: SSEEventType;
	payload: SSEEventMap[SSEEventType];
}): emission is { event: 'error'; payload: SSEEventMap['error'] } {
	return emission.event === 'error';
}

export class EyeLoopSession {
	readonly sessionId = crypto.randomUUID();
	readonly createdAt = Date.now();
	readonly events = new EventEmitter();

	intent: string;
	state: SessionRuntimeState = 'creating';
	stage: Stage = 'words';
	tasteVersion = 0;
	swipeCount = 0;
	evidence: SwipeEvidence[] = [];
	synthesis: TasteSynthesis | null = null;
	facades: QueuedFacade[] = [];
	consumedFacades: QueuedFacade[] = [];
	probes: ProbeBrief[] = [];
	agents: Map<string, AgentState> = new Map();
	draft: PrototypeDraft = emptyDraft();
	antiPatterns: string[] = [];
	swipeLatencies: number[] = [];
	palette = '';
	reveal: RevealState = defaultRevealState();
	lastError: SSEEventMap['error'] | null = null;
	pendingFacadeJobs = 0;

	constructor(intent: string) {
		this.intent = intent;
		this.events.setMaxListeners(100);
	}

	get sessionMedianLatency(): number {
		if (this.swipeLatencies.length === 0) return 0;
		const sorted = [...this.swipeLatencies].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	}

	get concretenessFloor(): Facade['format'] {
		return this.evidence.length < 4 ? 'word' : 'mockup';
	}

	get queueStats(): QueueStats {
		const stale = this.facades.filter((f) => this.isFacadeStale(f)).length;
		return {
			ready: this.facades.length,
			target: RESERVOIR_TARGET_READY,
			min: RESERVOIR_MIN_READY,
			max: RESERVOIR_MAX_READY,
			lowWater: RESERVOIR_LOW_WATER,
			pending: this.pendingFacadeJobs,
			stale
		};
	}

	emit<K extends SSEEventType>(event: K, payload: SSEEventMap[K]) {
		const emission: { event: SSEEventType; payload: SSEEventMap[SSEEventType] } = {
			event,
			payload
		};
		if (isErrorEmission(emission)) this.lastError = emission.payload;
		this.events.emit(event, payload);
	}

	on<K extends SSEEventType>(event: K, cb: (payload: SSEEventMap[K]) => void) {
		this.events.on(event, cb);
		return () => this.events.off(event, cb);
	}

	onAny(cb: <K extends SSEEventType>(event: K, payload: SSEEventMap[K]) => void) {
		const cleanups = SSE_EVENTS.map((name) => {
			const handler = (payload: SSEEventMap[typeof name]) => cb(name, payload);
			this.events.on(name, handler);
			return () => this.events.off(name, handler);
		});
		return () => cleanups.forEach((fn) => fn());
	}

	setState(state: SessionRuntimeState) {
		this.state = state;
	}

	setPlaceholderDraft() {
		const safeIntent = escapeHtml(this.intent);
		this.draft = {
			title: this.intent,
			summary: 'Drafting your prototype from the swipes...',
			html:
				'<div style="padding:2rem;text-align:center;color:var(--muted,#8a7f78);opacity:0.75">' +
				`<h2 style="margin:0 0 1rem;font-weight:400">${safeIntent}</h2>` +
				'<p style="margin:0">Building your first draft...</p>' +
				'</div>',
			acceptedPatterns: [],
			rejectedPatterns: []
		};
		this.emit('draft-updated', { draft: this.draft });
	}

	setAgent(agent: AgentState) {
		this.agents.set(agent.id, agent);
		this.emit('agent-status', { agent });
	}

	addFacade(facade: Facade, generationReason: string): QueuedFacade {
		const queued: QueuedFacade = {
			...facade,
			tasteVersion: this.tasteVersion,
			createdAt: Date.now(),
			generationReason
		};
		this.facades.push(queued);
		this.emit('facade-ready', { facade: queued });
		this.emit('queue-updated', { queueStats: this.queueStats });
		return queued;
	}

	removeFacade(facadeId: string) {
		const idx = this.facades.findIndex((f) => f.id === facadeId);
		if (idx === -1) return;
		this.facades.splice(idx, 1);
		this.emit('facade-stale', { facadeId });
		this.emit('queue-updated', { queueStats: this.queueStats });
	}

	clearReadyFacades() {
		for (const facade of [...this.facades]) {
			this.emit('facade-stale', { facadeId: facade.id });
		}
		this.facades = [];
		this.emit('queue-updated', { queueStats: this.queueStats });
	}

	consumeFacade(facadeId: string): QueuedFacade | null {
		const idx = this.facades.findIndex((f) => f.id === facadeId);
		if (idx === -1) return null;
		const [facade] = this.facades.splice(idx, 1);
		this.consumedFacades.push(facade);
		this.emit('queue-updated', { queueStats: this.queueStats });
		return facade;
	}

	findFacade(facadeId: string): QueuedFacade | undefined {
		return (
			this.facades.find((f) => f.id === facadeId) ??
			this.consumedFacades.find((f) => f.id === facadeId)
		);
	}

	addEvidence(record: SwipeRecord): SwipeEvidence {
		this.swipeCount++;
		const median = this.sessionMedianLatency;
		record.latencyBucket = median > 0 && record.latencyMs < median ? 'fast' : 'slow';
		this.swipeLatencies.push(record.latencyMs);

		const facade = this.findFacade(record.facadeId);
		const implication =
			record.decision === 'accept' ? facade?.acceptImplies : facade?.rejectImplies;
		const entry: SwipeEvidence = {
			facadeId: record.facadeId,
			content: facade?.label ?? facade?.content ?? record.facadeId,
			hypothesis: facade?.hypothesis ?? '',
			decision: record.decision,
			latencySignal: record.latencyBucket,
			format: facade?.format ?? 'word',
			implication: implication ?? ''
		};
		this.evidence.push(entry);
		this.emit('swipe-result', { record });
		this.emit('evidence-updated', {
			evidence: [...this.evidence],
			antiPatterns: this.antiPatterns
		});
		return entry;
	}

	getNextProbe(): ProbeBrief | undefined {
		const highIdx = this.probes.findIndex((p) => p.priority === 'high');
		if (highIdx !== -1) return this.probes.splice(highIdx, 1)[0];
		return this.probes.shift();
	}

	markRevealPrepared(reason: string, draft: PrototypeDraft) {
		this.reveal = {
			prepared: true,
			preparing: false,
			finalizing: false,
			draft,
			preparedAtSwipe: this.swipeCount,
			lastReason: reason
		};
		this.emit('reveal-prepared', { ready: true });
	}

	toEvidencePrompt(): string {
		if (this.evidence.length === 0) return 'No evidence yet.';
		return this.evidence
			.map((e, i) => {
				const tag = e.decision === 'accept' ? 'ACCEPT' : 'REJECT';
				const hesitant = e.latencySignal === 'slow' ? ' (hesitant)' : '';
				const impl = e.implication ? `\n   Design signal: ${e.implication}` : '';
				return (
					`${i + 1}. [${tag}${hesitant}] (${e.format}) "${e.content}"\n` +
					`   Hypothesis: ${e.hypothesis}${impl}`
				);
			})
			.join('\n\n');
	}

	isFacadeStale(facade: QueuedFacade): boolean {
		return this.tasteVersion - facade.tasteVersion > RESERVOIR_STALE_VERSION_LAG;
	}

	getBootstrapResponse(revealThreshold: number): SessionBootstrapResponse {
		return {
			intent: this.intent,
			sessionId: this.sessionId,
			revealThreshold,
			facades: [...this.facades],
			evidence: [...this.evidence],
			antiPatterns: [...this.antiPatterns],
			agents: [...this.agents.values()],
			draft: this.draft,
			synthesis: this.synthesis,
			stage: this.stage,
			queueStats: this.queueStats,
			revealPrepared: this.reveal.prepared
		};
	}

	getSnapshot(): SessionSnapshot {
		return {
			sessionId: this.sessionId,
			intent: this.intent,
			state: this.state,
			stage: this.stage,
			swipeCount: this.swipeCount,
			tasteVersion: this.tasteVersion,
			evidence: [...this.evidence],
			antiPatterns: [...this.antiPatterns],
			facades: [...this.facades],
			agents: [...this.agents.values()],
			draft: this.draft,
			synthesis: this.synthesis,
			queueStats: this.queueStats,
			reveal: { ...this.reveal }
		};
	}
}
