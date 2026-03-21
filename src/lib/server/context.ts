import type {
	Stage,
	TasteAxis,
	Facade,
	SwipeRecord,
	AgentState,
	PrototypeDraft,
	ProbeBrief
} from '$lib/context/types';
import { emitFacadeReady, emitSwipeResult, emitAnimaUpdated } from './bus';

// ── Confidence threshold ──────────────────────────────────────────────

const RESOLVED_THRESHOLD = 0.8;
const QUEUE_MIN = 3;
const QUEUE_MAX = 5;

// ── EyeLoopContext ────────────────────────────────────────────────────

class EyeLoopContext {
	intent = '';
	swipeCount = 0;
	stage: Stage = 'words';
	axes: Map<string, TasteAxis> = new Map();
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

	// ── Getters ─────────────────────────────────────────────────────

	get sessionMedianLatency(): number {
		if (this.swipeLatencies.length === 0) return 0;
		const sorted = [...this.swipeLatencies].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	}

	// ── Methods ─────────────────────────────────────────────────────

	seedAxes(axes: TasteAxis[]) {
		this.axes.clear();
		for (const axis of axes) {
			this.axes.set(axis.id, axis);
		}
	}

	addEvidence(record: SwipeRecord) {
		this.swipeCount++;
		this.swipeLatencies.push(record.latencyMs);

		// Compute latency bucket
		const median = this.sessionMedianLatency;
		record.latencyBucket = median > 0 && record.latencyMs < median ? 'fast' : 'slow';

		// Update axis
		const axis = this.axes.get(record.axisId);
		if (axis) {
			axis.evidenceCount++;
			const delta = record.latencyBucket === 'fast' ? 0.15 : 0.1;

			if (record.decision === 'accept') {
				// Reinforce the hypothesis direction
				axis.confidence = Math.min(1, axis.confidence + delta);
			} else {
				// Reject nudges confidence toward the other pole
				axis.confidence = Math.min(1, axis.confidence + delta * 0.6);
			}

			// Set leaning based on the facade's hypothesis
			const facade = this.facades.find((f) => f.id === record.facadeId)
				?? this.consumedFacades.find((f) => f.id === record.facadeId);

			if (facade && axis.options.length === 2) {
				if (record.decision === 'accept') {
					// Lean toward whichever pole the hypothesis was testing
					const hypLower = facade.hypothesis.toLowerCase();
					axis.leaning = axis.options.find((o: string) => hypLower.includes(o.toLowerCase()))
						?? axis.leaning;
				} else {
					// Lean away from the hypothesis
					const hypLower = facade.hypothesis.toLowerCase();
					const rejected = axis.options.find((o: string) => hypLower.includes(o.toLowerCase()));
					axis.leaning = axis.options.find((o: string) => o !== rejected) ?? axis.leaning;
				}
			}

			// Emit updates
			emitSwipeResult({ record, axisUpdate: axis });
			emitAnimaUpdated({ axes: [...this.axes.values()], antiPatterns: this.antiPatterns });
		}

		// NOTE: stage advancement is NOT done here — owned by oracle (07)
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
		// Sort by priority, pop highest
		const highIdx = this.probes.findIndex((p) => p.priority === 'high');
		if (highIdx !== -1) return this.probes.splice(highIdx, 1)[0];
		return this.probes.shift();
	}

	getMostUncertainAxis(): TasteAxis | undefined {
		let most: TasteAxis | undefined;
		for (const axis of this.axes.values()) {
			if (axis.confidence >= RESOLVED_THRESHOLD) continue;
			if (!most || axis.confidence < most.confidence) {
				most = axis;
			}
		}
		return most;
	}

	queueHealthy(): boolean {
		return this.facades.length >= QUEUE_MIN && this.facades.length <= QUEUE_MAX;
	}

	reset() {
		this.intent = '';
		this.swipeCount = 0;
		this.stage = 'words';
		this.axes.clear();
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
	}

	// ── Anima YAML serializer ───────────────────────────────────────

	toAnimaYAML(): string {
		const resolved: string[] = [];
		const exploring: string[] = [];
		const unprobed: string[] = [];

		for (const axis of this.axes.values()) {
			if (axis.evidenceCount === 0) {
				unprobed.push(`  - ${axis.label}`);
			} else if (axis.confidence >= RESOLVED_THRESHOLD && axis.leaning) {
				resolved.push(
					`  ${axis.label}:\n` +
					`    value: ${axis.leaning}\n` +
					`    confidence: ${axis.confidence.toFixed(2)}`
				);
			} else {
				const [a, b] = axis.options;
				const pA = axis.leaning === a
					? axis.confidence.toFixed(2)
					: (1 - axis.confidence).toFixed(2);
				const pB = (1 - parseFloat(pA)).toFixed(2);
				exploring.push(
					`  ${axis.label}:\n` +
					`    hypotheses: [${a}, ${b}]\n` +
					`    distribution: [${pA}, ${pB}]\n` +
					`    probes_spent: ${axis.evidenceCount}`
				);
			}
		}

		const antiLines = this.antiPatterns.map((p) => `  - ${p}`);

		return [
			`# Anima | ${this.swipeCount} swipes | stage: ${this.stage}`,
			`intent: "${this.intent}"`,
			'',
			'resolved:',
			resolved.length ? resolved.join('\n') : '  {}',
			'',
			'exploring:',
			exploring.length ? exploring.join('\n') : '  {}',
			'',
			'unprobed:',
			unprobed.length ? unprobed.join('\n') : '  []',
			'',
			'anti_patterns:',
			antiLines.length ? antiLines.join('\n') : '  []'
		].join('\n');
	}
}

// ── Module-level singleton ────────────────────────────────────────────

export const context = new EyeLoopContext();
