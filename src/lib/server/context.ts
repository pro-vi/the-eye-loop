import type {
	Stage,
	SwipeEvidence,
	TasteSynthesis,
	Facade,
	SwipeRecord,
	AgentState,
	PrototypeDraft,
	ProbeBrief
} from '$lib/context/types';
import { emitFacadeReady, emitSwipeResult, emitEvidenceUpdated } from './bus';

// ── Queue thresholds ─────────────────────────────────────────────────

const QUEUE_MIN = 3;
const QUEUE_MAX = 8;

// ── EyeLoopContext ────────────────────────────────────────────────────

class EyeLoopContext {
	intent = '';
	sessionId = ''; // V0: invalidation token, not a routing boundary
	swipeCount = 0;
	stage: Stage = 'words';
	evidence: SwipeEvidence[] = [];
	synthesis: TasteSynthesis | null = null;
	facades: Facade[] = [];
	consumedFacades: Facade[] = [];
	probes: ProbeBrief[] = [];
	agents: Map<string, AgentState> = new Map();
	draft: PrototypeDraft = {
		title: '',
		summary: '',
		html: '',
		acceptedPatterns: [],
		rejectedPatterns: []
	};
	antiPatterns: string[] = [];
	swipeLatencies: number[] = [];
	palette: string = '';  // CSS variable block derived from evidence by oracle

	// ── Getters ─────────────────────────────────────────────────────

	get sessionMedianLatency(): number {
		if (this.swipeLatencies.length === 0) return 0;
		const sorted = [...this.swipeLatencies].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	}

	get queuePressure(): 'hungry' | 'healthy' | 'full' {
		if (this.facades.length < QUEUE_MIN) return 'hungry';
		if (this.facades.length > QUEUE_MAX) return 'full';
		return 'healthy';
	}

	get concretenessFloor(): 'word' | 'mockup' {
		if (this.evidence.length < 4) return 'word';
		return 'mockup';
	}

	// ── Methods ─────────────────────────────────────────────────────

	addEvidence(record: SwipeRecord) {
		this.swipeCount++;

		// Compute latency bucket from session median
		const median = this.sessionMedianLatency;
		record.latencyBucket = median > 0 && record.latencyMs < median ? 'fast' : 'slow';
		this.swipeLatencies.push(record.latencyMs);

		// Build evidence entry from facade + record
		const facade = this.facades.find((f) => f.id === record.facadeId)
			?? this.consumedFacades.find((f) => f.id === record.facadeId);

		const implication = record.decision === 'accept'
			? facade?.acceptImplies
			: facade?.rejectImplies;

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

		// Emit updates
		emitSwipeResult({ record });
		emitEvidenceUpdated({ evidence: [...this.evidence], antiPatterns: this.antiPatterns });
	}

	pushFacade(facade: Facade) {
		this.facades.push(facade);
		emitFacadeReady({ facade });
	}

	markFacadeConsumed(facadeId: string) {
		const idx = this.facades.findIndex((f) => f.id === facadeId);
		if (idx !== -1) {
			const [facade] = this.facades.splice(idx, 1);
			this.consumedFacades.push(facade);
		}
	}

	getNextProbe(): ProbeBrief | undefined {
		const highIdx = this.probes.findIndex((p) => p.priority === 'high');
		if (highIdx !== -1) return this.probes.splice(highIdx, 1)[0];
		return this.probes.shift();
	}

	reset() {
		this.intent = '';
		this.sessionId = '';
		this.swipeCount = 0;
		this.stage = 'words';
		this.evidence = [];
		this.synthesis = null;
		this.facades = [];
		this.consumedFacades = [];
		this.probes = [];
		this.agents.clear();
		this.draft = {
			title: '',
			summary: '',
			html: '',
			acceptedPatterns: [],
			rejectedPatterns: []
		};
		this.antiPatterns = [];
		this.swipeLatencies = [];
		this.palette = '';
	}

	// ── Evidence serializer for agent prompts ────────────────────────

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
}

// ── Module-level singleton ────────────────────────────────────────────

export const context = new EyeLoopContext();
