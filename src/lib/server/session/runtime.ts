import { generateText, Output } from 'ai';
import { z } from 'zod';
import type {
	AgentState,
	Facade,
	PrototypeDraft,
	SessionBootstrapResponse,
	SwipeRecord,
	TasteSynthesis
} from '$lib/context/types';
import { SCOUT_MODEL, ORACLE_MODEL, BUILDER_MODEL, REVEAL_MODEL } from '$lib/server/ai';
import { classifyErrorCode } from '$lib/server/provider-errors';
import { debugLog } from '$lib/server/debug-log';
import { HTML_QUALITY_RULES } from '$lib/server/prompts';
import {
	AUTO_REVEAL_SWIPE_THRESHOLD,
	BUILDER_MODEL_ID,
	REVEAL_MAX_OUTPUT_TOKENS,
	REVEAL_MODEL_ID
} from '$lib/server/runtime-config';
import { createSession, getSession } from './registry';
import { EyeLoopSession } from './eye-loop-session';
import {
	RESERVOIR_LOW_WATER,
	RESERVOIR_MIN_READY,
	RESERVOIR_TARGET_READY
} from './types';

const SYNTHESIS_CADENCE = 4;
const REVEAL_PREP_START = 8;
const REVEAL_FORCE_PREP_AT = Math.max(1, AUTO_REVEAL_SWIPE_THRESHOLD - 6);
const WARMUP_TIMEOUT_MS = 45_000;
const MAX_CONCURRENT_SCOUTS = 6;
const MAX_REFILL_BATCHES_WITHOUT_PROGRESS = 2;

const SCOUT_ROSTER = [
	{ id: 'scout-01', name: 'Iris' },
	{ id: 'scout-02', name: 'Prism' },
	{ id: 'scout-03', name: 'Lumen' },
	{ id: 'scout-04', name: 'Aura' },
	{ id: 'scout-05', name: 'Facet' },
	{ id: 'scout-06', name: 'Echo' }
] as const;

const SCOUT_LENSES: Record<string, string> = {
	Iris: 'LOOK AND FEEL: colors, shapes, light vs dark, rounded vs sharp, photos vs illustrations.',
	Prism: 'LAYOUT AND INTERACTION: sidebar vs tabs, cards vs lists, dense vs spacious, scroll vs pages.',
	Aura: 'MOOD AND ATMOSPHERE: warm vs cool, calm vs energetic, intimate vs expansive, organic vs digital.',
	Facet: 'INFORMATION DESIGN: charts vs text, numbers vs narrative, dense data vs key metrics, tables vs cards.',
	Echo: 'MOTION AND BEHAVIOR: animated vs static, transitions vs instant, gesture vs click, fluid vs snappy.',
	Lumen: 'VOICE AND PERSONALITY: friendly vs professional, playful vs serious, branded vs neutral.'
};

const ScoutOutputSchemaWord = z.object({
	label: z.string(),
	hypothesis: z.string(),
	axis_targeted: z.string(),
	accept_implies: z.string(),
	reject_implies: z.string()
});

const ScoutOutputSchemaMockup = z.object({
	label: z.string(),
	hypothesis: z.string(),
	axis_targeted: z.string(),
	content: z.string(),
	accept_implies: z.string(),
	reject_implies: z.string()
});

const emergentAxisSchema = z.object({
	label: z.string(),
	poleA: z.string(),
	poleB: z.string(),
	confidence: z.enum(['unprobed', 'exploring', 'leaning', 'resolved']),
	leaning_toward: z.string().nullable(),
	evidence_basis: z.string()
});

const paletteSchema = z.object({
	bg: z.string(),
	card: z.string(),
	accent: z.string(),
	text: z.string(),
	muted: z.string(),
	radius: z.string()
});

const SynthesisSchema = z.object({
	axes: z.array(emergentAxisSchema),
	edge_case_flags: z.array(z.string()),
	palette: paletteSchema,
	scout_assignments: z.array(
		z.object({
			scout: z.enum(['Iris', 'Prism', 'Lumen', 'Aura', 'Facet', 'Echo']),
			probe_axis: z.string(),
			reason: z.string()
		})
	),
	persona_anima_divergence: z.string().nullable()
});

const ColdStartSchema = z.array(
	z.object({
		scout: z.enum(['Iris', 'Prism', 'Lumen', 'Aura', 'Facet', 'Echo']),
		hypothesis: z.string(),
		word_probe: z.string()
	})
);

const DraftUpdateSchema = z.object({
	title: z.string(),
	summary: z.string(),
	html: z.string(),
	changeNote: z.string(),
	acceptedPatterns: z.array(z.string()),
	rejectedPatterns: z.array(z.string()),
	probeBriefs: z.array(
		z.object({
			source: z.literal('builder'),
			priority: z.enum(['high', 'normal']),
			brief: z.string(),
			context: z.string(),
			heldConstant: z.array(z.string())
		})
	),
	nextHint: z.string().nullable()
});

const DraftCoreSchema = z.object({
	title: z.string(),
	summary: z.string(),
	html: z.string()
});

const FORMAT_INSTRUCTIONS: Record<Facade['format'], string> = {
	word:
		'FORMAT: word. Output one evocative word or a 2-4 word plain-language phrase. The label is the content.',
	mockup:
		'FORMAT: mockup. Describe a specific mobile UI screen with layout, components, colors, and typography.'
};

const SCOUT_PROMPT = `You are {SCOUT_NAME}, a taste scout in The Eye Loop.
Lens: {SCOUT_LENS}

The user wants to build: "{INTENT}"

Evidence:
{EVIDENCE}

Emergent axes:
{EMERGENT_AXES}

Assignment:
{AXIS_ASSIGNMENT}

Already queued:
{QUEUE_CONTENTS}

Anti-patterns:
{ANTI_PATTERNS}

Builder brief:
{PROBE_BRIEF}

{FORMAT_INSTRUCTION}

Rules:
- Make the label understandable in one second.
- Probe a real product-design choice, not an abstract art phrase.
- Do not duplicate queued axes or labels.
- Rejected patterns are hard constraints.
- A slightly difficult choice is more useful than an obvious one.`;

const SYNTHESIS_PROMPT = `You are the Oracle, the strategic brain of a taste discovery system.

The user said they want to build: "{intent}"

Evidence:
{evidence}

Produce emergent taste axes discovered from choices, not from the stated intent alone.
Also derive a six-token CSS palette and assign each scout a different next probe axis.`;

const COLD_START_PROMPT = `You are the Oracle. A user just started a session.

Intent: "{INTENT}"

Produce 6 first questions, one for each scout: Iris, Prism, Lumen, Aura, Facet, Echo.
Each question should probe a different taste dimension for this specific product.
The word_probe must be plain language and readable in one second.`;

const SCAFFOLD_PROMPT = `You are the Builder agent in The Eye Loop.

The user just started a session. Generate an initial draft prototype scaffold.

User intent: "{intent}"

${HTML_QUALITY_RULES}

Output title, summary, and concise mobile HTML+CSS. This is a starting point that will evolve through swipes.`;

const SWIPE_PROMPT = `You are the Builder. Patch the prototype from observed choices.

Intent: "{intent}"

Evidence:
{evidence}

Synthesis:
{synthesis}

Palette:
{palette}

Current draft title: {draft_title}
Current draft summary: {draft_summary}
Current draft HTML:
{draft_html}

Accepted patterns: {accepted_patterns}
Rejected patterns: {rejected_patterns}
Anti-patterns:
{anti_patterns}

Last swipe:
{last_swipe}

Recent builder changes:
{builder_notes}

Rules:
- Make the smallest useful HTML change.
- Accept means reinforce or add one element from the accepted facade.
- Reject means remove or avoid one rejected pattern.
- Preserve settled design language.
- Emit a builder probe brief only if construction is genuinely blocked.

${HTML_QUALITY_RULES}`;

interface BuilderNote {
	swipe: number;
	decision: 'accept' | 'reject';
	label: string;
	change: string;
}

interface BuilderQueue {
	busy: boolean;
	pendingRecord: SwipeRecord | null;
	notes: BuilderNote[];
	scaffoldStarted: boolean;
	revealPrepStartedFor: number;
}

const builderQueues = new WeakMap<EyeLoopSession, BuilderQueue>();
const refillRuns = new WeakMap<EyeLoopSession, Promise<void>>();
const synthesisRuns = new WeakMap<EyeLoopSession, Promise<void>>();
const revealRuns = new WeakMap<EyeLoopSession, Promise<void>>();

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBuilderQueue(session: EyeLoopSession): BuilderQueue {
	let queue = builderQueues.get(session);
	if (!queue) {
		queue = {
			busy: false,
			pendingRecord: null,
			notes: [],
			scaffoldStarted: false,
			revealPrepStartedFor: -1
		};
		builderQueues.set(session, queue);
	}
	return queue;
}

function setAgent(
	session: EyeLoopSession,
	id: string,
	name: string,
	role: AgentState['role'],
	status: AgentState['status'],
	focus: string
) {
	session.setAgent({ id, name, role, status, focus });
}

function emitError(session: EyeLoopSession, source: 'scout' | 'oracle' | 'builder', err: unknown, agentId?: string) {
	const code = classifyErrorCode(err);
	session.emit('error', {
		source,
		code,
		agentId,
		message: err instanceof Error ? err.message : String(err)
	});
}

function getSynthesisText(session: EyeLoopSession): string {
	if (!session.synthesis) return 'Not yet available.';
	const axes = session.synthesis.axes
		.map((a) => `${a.label}: ${a.poleA} vs ${a.poleB} [${a.confidence}]`)
		.join('\n');
	const flags = session.synthesis.edge_case_flags.length
		? `\nFlags: ${session.synthesis.edge_case_flags.join(', ')}`
		: '';
	const divergence = session.synthesis.persona_anima_divergence
		? `\nDivergence: ${session.synthesis.persona_anima_divergence}`
		: '';
	return `${axes || 'No axes yet.'}${flags}${divergence}`;
}

function getAxisAssignment(session: EyeLoopSession, scoutName: string): string {
	const assignment = session.synthesis?.scout_assignments.find((a) => a.scout === scoutName);
	if (!assignment) return 'Self-assign from the most uncertain gap.';
	return `Probe "${assignment.probe_axis}": ${assignment.reason}`;
}

function getQueueContents(session: EyeLoopSession): string {
	if (!session.facades.length) return '(empty)';
	return session.facades
		.map((f) => `- "${f.label}" (${f.agentId}) testing ${f.axisTargeted ?? f.hypothesis}`)
		.join('\n');
}

function getAntiPatterns(session: EyeLoopSession): string {
	return session.antiPatterns.length
		? session.antiPatterns.map((p) => `- ${p}`).join('\n')
		: '(none)';
}

function getProbeBrief(session: EyeLoopSession): string {
	const probe = session.getNextProbe();
	if (!probe) return 'None.';
	return `${probe.brief}\nContext: ${probe.context}`;
}

function shouldAggressivelyRefill(session: EyeLoopSession): boolean {
	return session.facades.length < RESERVOIR_LOW_WATER;
}

function isRevealStage(session: EyeLoopSession): boolean {
	return session.stage === 'reveal';
}

function pruneStaleFacades(session: EyeLoopSession) {
	if (session.facades.length <= RESERVOIR_LOW_WATER) return;
	for (const facade of [...session.facades]) {
		if (session.facades.length <= RESERVOIR_LOW_WATER) return;
		if (session.isFacadeStale(facade)) session.removeFacade(facade.id);
	}
}

async function generateScoutFacade(session: EyeLoopSession, scout: (typeof SCOUT_ROSTER)[number], reason: string) {
	session.pendingFacadeJobs++;
	session.emit('queue-updated', { queueStats: session.queueStats });
	setAgent(session, scout.id, scout.name, 'scout', 'thinking', reason);
	let idleFocus = 'waiting';
	try {
		const format = session.concretenessFloor;
		const schema = format === 'word' ? ScoutOutputSchemaWord : ScoutOutputSchemaMockup;
		const system = SCOUT_PROMPT.replace('{SCOUT_NAME}', scout.name)
			.replace('{SCOUT_LENS}', SCOUT_LENSES[scout.name] ?? '')
			.replace('{INTENT}', session.intent)
			.replace('{EVIDENCE}', session.toEvidencePrompt())
			.replace('{EMERGENT_AXES}', getSynthesisText(session))
			.replace('{AXIS_ASSIGNMENT}', getAxisAssignment(session, scout.name))
			.replace('{QUEUE_CONTENTS}', getQueueContents(session))
			.replace('{ANTI_PATTERNS}', getAntiPatterns(session))
			.replace('{PROBE_BRIEF}', getProbeBrief(session))
			.replace('{FORMAT_INSTRUCTION}', FORMAT_INSTRUCTIONS[format]);

		const result = await generateText({
			model: SCOUT_MODEL,
			output: Output.object({ schema }),
			temperature: 1,
			system,
			prompt: 'Generate one next taste probe.'
		});
		const output = result.output;
		if (!output) {
			idleFocus = 'no usable facade';
			return;
		}
		if (session.stage === 'reveal') {
			idleFocus = 'session already revealed';
			return;
		}

		const axisLower = output.axis_targeted.toLowerCase();
		const labelLower = output.label.toLowerCase();
		const duplicate = session.facades.some(
			(f) =>
				f.axisTargeted?.toLowerCase() === axisLower ||
				f.label.toLowerCase() === labelLower
		);
		if (duplicate) {
			idleFocus = 'duplicate skipped';
			return;
		}

		const content =
			'content' in output && typeof output.content === 'string'
				? output.content
				: output.label;
		session.addFacade(
			{
				id: crypto.randomUUID(),
				agentId: scout.id,
				hypothesis: output.hypothesis,
				axisTargeted: output.axis_targeted,
				label: output.label,
				content,
				format,
				acceptImplies: output.accept_implies,
				rejectImplies: output.reject_implies
			},
			reason
		);
		idleFocus = `"${output.label}" ready`;
	} catch (err) {
		emitError(session, 'scout', err, scout.id);
		idleFocus = 'provider call failed';
	} finally {
		session.pendingFacadeJobs--;
		setAgent(session, scout.id, scout.name, 'scout', 'idle', idleFocus);
		session.emit('queue-updated', { queueStats: session.queueStats });
	}
}

async function runRefill(
	session: EyeLoopSession,
	reason: string,
	minReady = RESERVOIR_LOW_WATER,
	targetReady = RESERVOIR_TARGET_READY
) {
	if (refillRuns.has(session)) return refillRuns.get(session);
	const run = (async () => {
		pruneStaleFacades(session);
		let noProgressBatches = 0;
		while (
			!isRevealStage(session) &&
			(session.facades.length < minReady || session.facades.length + session.pendingFacadeJobs < targetReady)
		) {
			const readyBefore = session.facades.length;
			const slots = Math.max(
				0,
				Math.min(
					MAX_CONCURRENT_SCOUTS,
					targetReady - session.facades.length - session.pendingFacadeJobs
				)
			);
			if (slots === 0) break;
			const scouts = Array.from({ length: slots }, (_, index) => {
				const scout = SCOUT_ROSTER[(session.swipeCount + session.facades.length + index) % SCOUT_ROSTER.length];
				return generateScoutFacade(session, scout, reason);
			});
			await Promise.allSettled(scouts);
			if (isRevealStage(session)) break;
			if (session.facades.length <= readyBefore) {
				noProgressBatches++;
				if (noProgressBatches >= MAX_REFILL_BATCHES_WITHOUT_PROGRESS) break;
			} else {
				noProgressBatches = 0;
			}
			if (session.facades.length >= targetReady) break;
			if (slots < MAX_CONCURRENT_SCOUTS && session.facades.length >= minReady) break;
		}
	})();
	refillRuns.set(session, run);
	try {
		await run;
	} finally {
		refillRuns.delete(session);
	}
}

function scheduleRefill(session: EyeLoopSession, reason: string) {
	const minReady = shouldAggressivelyRefill(session) ? RESERVOIR_MIN_READY : RESERVOIR_LOW_WATER;
	void runRefill(session, reason, minReady);
}

async function runColdStart(session: EyeLoopSession) {
	setAgent(session, 'oracle', 'Oracle', 'oracle', 'thinking', 'cold-start analysis');
	try {
		const result = await generateText({
			model: ORACLE_MODEL,
			output: Output.object({ schema: ColdStartSchema }),
			temperature: 0,
			prompt: COLD_START_PROMPT.replace('{INTENT}', session.intent)
		});
		if (!result.output) return;
		session.synthesis = {
			axes: result.output.map((h) => ({
				label: h.hypothesis,
				poleA: h.word_probe,
				poleB: '(unknown)',
				confidence: 'unprobed',
				leaning_toward: null,
				evidence_basis: 'intent analysis before evidence'
			})),
			edge_case_flags: [],
			scout_assignments: result.output.map((h) => ({
				scout: h.scout,
				probe_axis: h.hypothesis,
				reason: `Cold start question for ${h.scout}`
			})),
			persona_anima_divergence: null
		};
		session.emit('synthesis-updated', { synthesis: session.synthesis });
	} catch (err) {
		emitError(session, 'oracle', err, 'oracle');
	} finally {
		setAgent(session, 'oracle', 'Oracle', 'oracle', 'idle', 'monitoring');
	}
}

async function runSynthesis(session: EyeLoopSession) {
	if (synthesisRuns.has(session)) return synthesisRuns.get(session);
	const run = (async () => {
		setAgent(session, 'oracle', 'Oracle', 'oracle', 'thinking', 'synthesizing evidence');
		try {
			const prompt = SYNTHESIS_PROMPT.replace('{intent}', session.intent).replace(
				'{evidence}',
				session.toEvidencePrompt()
			);
			const result = await generateText({
				model: ORACLE_MODEL,
				output: Output.object({ schema: SynthesisSchema }),
				temperature: 0,
				prompt
			});
			if (!result.output) return;
			session.synthesis = result.output;
			session.tasteVersion++;
			const p = result.output.palette;
			session.palette = `:root { --bg: ${p.bg}; --card: ${p.card}; --accent: ${p.accent}; --text: ${p.text}; --muted: ${p.muted}; --radius: ${p.radius}; }`;
			session.emit('synthesis-updated', { synthesis: result.output });
			pruneStaleFacades(session);
			scheduleRefill(session, 'taste update refill');
		} catch (err) {
			emitError(session, 'oracle', err, 'oracle');
		} finally {
			setAgent(session, 'oracle', 'Oracle', 'oracle', 'idle', 'monitoring');
		}
	})();
	synthesisRuns.set(session, run);
	try {
		await run;
	} finally {
		synthesisRuns.delete(session);
	}
}

async function buildScaffold(session: EyeLoopSession) {
	const queue = getBuilderQueue(session);
	if (queue.scaffoldStarted) return;
	queue.scaffoldStarted = true;
	session.setPlaceholderDraft();
	setAgent(session, 'builder-01', 'Meridian', 'builder', 'thinking', 'generating initial scaffold');
	try {
		const result = await generateText({
			model: BUILDER_MODEL,
			output: Output.object({ schema: DraftCoreSchema }),
			temperature: 0,
			system: SCAFFOLD_PROMPT.replace('{intent}', session.intent),
			prompt: 'Generate the initial draft scaffold for this session.'
		});
		if (!result.output) return;
		session.draft = {
			...session.draft,
			title: result.output.title,
			summary: result.output.summary,
			html: result.output.html
		};
		session.emit('draft-updated', { draft: session.draft });
	} catch (err) {
		emitError(session, 'builder', err, 'builder-01');
	} finally {
		setAgent(session, 'builder-01', 'Meridian', 'builder', 'idle', 'watching for swipes');
	}
}

function summarizeFacade(facade: Facade): string {
	return facade.format === 'word' ? facade.label : facade.content.slice(0, 1500);
}

function getBuilderNotesText(notes: BuilderNote[]): string {
	if (!notes.length) return '(none)';
	return notes
		.slice(0, 8)
		.map((n, i) => `${i + 1}. Swipe ${n.swipe} (${n.decision} "${n.label}"): ${n.change}`)
		.join('\n');
}

async function patchDraft(session: EyeLoopSession, record: SwipeRecord) {
	const queue = getBuilderQueue(session);
	if (queue.busy) {
		queue.pendingRecord = record;
		return;
	}
	const facade = session.findFacade(record.facadeId);
	if (!facade || session.stage === 'reveal') return;

	queue.busy = true;
	queue.pendingRecord = null;
	setAgent(session, 'builder-01', 'Meridian', 'builder', 'thinking', `patching "${facade.label}"`);
	try {
		const antiPatterns = getAntiPatterns(session);
		const prompt = SWIPE_PROMPT.replace('{intent}', session.intent)
			.replace('{evidence}', session.toEvidencePrompt())
			.replace('{synthesis}', getSynthesisText(session))
			.replace('{palette}', session.palette || 'Use warm neutral defaults.')
			.replace('{draft_title}', session.draft.title || '(empty)')
			.replace('{draft_summary}', session.draft.summary || '(empty)')
			.replace('{draft_html}', session.draft.html || '(empty)')
			.replace('{accepted_patterns}', JSON.stringify(session.draft.acceptedPatterns))
			.replace('{rejected_patterns}', JSON.stringify(session.draft.rejectedPatterns))
			.replace('{anti_patterns}', antiPatterns)
			.replace(
				'{last_swipe}',
				`${record.decision} "${facade.label}"\nHypothesis: ${facade.hypothesis}\nContent: ${summarizeFacade(facade)}`
			)
			.replace('{builder_notes}', getBuilderNotesText(queue.notes));
		const result = await generateText({
			model: BUILDER_MODEL,
			output: Output.object({ schema: DraftUpdateSchema }),
			temperature: 0,
			system: prompt,
			prompt: `Swipe #${session.swipeCount}: patch the draft.`
		});
		const output = result.output;
		if (!output) return;
		queue.notes.unshift({
			swipe: session.swipeCount,
			decision: record.decision,
			label: facade.label,
			change: output.changeNote
		});
		if (queue.notes.length > 8) queue.notes.pop();
		session.draft.title = output.title;
		session.draft.summary = output.summary;
		session.draft.html = output.html;
		session.draft.nextHint = output.nextHint ?? undefined;
		for (const p of output.acceptedPatterns) {
			if (!session.draft.acceptedPatterns.includes(p)) session.draft.acceptedPatterns.push(p);
		}
		let antiChanged = false;
		for (const p of output.rejectedPatterns) {
			if (!session.draft.rejectedPatterns.includes(p)) session.draft.rejectedPatterns.push(p);
			if (!session.antiPatterns.includes(p)) {
				session.antiPatterns.push(p);
				antiChanged = true;
			}
		}
		const brief = output.probeBriefs.find((p) => p.brief.length > 20);
		if (brief && session.probes.length < 3) session.probes.push(brief);
		session.emit('draft-updated', { draft: session.draft });
		if (output.nextHint) session.emit('builder-hint', { hint: output.nextHint });
		if (antiChanged) {
			session.emit('evidence-updated', {
				evidence: [...session.evidence],
				antiPatterns: session.antiPatterns
			});
		}
	} catch (err) {
		emitError(session, 'builder', err, 'builder-01');
	} finally {
		queue.busy = false;
		setAgent(session, 'builder-01', 'Meridian', 'builder', 'idle', 'watching for swipes');
		if (queue.pendingRecord) {
			const pending = queue.pendingRecord;
			queue.pendingRecord = null;
			void patchDraft(session, pending);
		}
	}
}

function isRateLimitError(err: unknown): boolean {
	if (typeof err === 'object' && err !== null && 'statusCode' in err) {
		const status = err.statusCode;
		if (status === 429) return true;
	}
	const text = err instanceof Error ? err.message : String(err);
	return /rate_limit_error|429|too many requests/i.test(text);
}

async function buildReveal(session: EyeLoopSession, final: boolean) {
	const queue = getBuilderQueue(session);
	if (!final && queue.revealPrepStartedFor === session.swipeCount) return;
	const existingRun = revealRuns.get(session);
	if (existingRun) {
		if (!final) return;
		await existingRun;
		if (session.reveal.draft) return;
	}
	if (!final) queue.revealPrepStartedFor = session.swipeCount;

	const run = (async () => {
		session.reveal.preparing = !final;
		session.reveal.finalizing = final;
		setAgent(
			session,
			'builder-01',
			'Meridian',
			'builder',
			'thinking',
			final ? 'final prototype synthesis' : 'preparing reveal'
		);
		try {
			const finalPrompt = `You are the Builder. Produce the ${final ? 'final' : 'prepared'} reveal prototype.

Intent: "${session.intent}"

Evidence:
${session.toEvidencePrompt()}

Synthesis:
${getSynthesisText(session)}

Palette:
${session.palette || 'Use warm neutral defaults.'}

Anti-patterns:
${getAntiPatterns(session)}

Current draft:
${session.draft.html}

${HTML_QUALITY_RULES}

Output title, summary, and complete mobile HTML.`;

			const runModel = async (model: typeof REVEAL_MODEL) =>
				generateText({
					model,
					output: Output.object({ schema: DraftCoreSchema }),
					temperature: 0,
					system: finalPrompt,
					prompt: final ? 'Generate the final reveal.' : 'Prepare the reveal draft.',
					maxOutputTokens: REVEAL_MAX_OUTPUT_TOKENS
				});
			let result;
			try {
				result = await runModel(final ? REVEAL_MODEL : BUILDER_MODEL);
			} catch (err) {
				if (final && isRateLimitError(err) && REVEAL_MODEL_ID !== BUILDER_MODEL_ID) {
					result = await runModel(BUILDER_MODEL);
				} else {
					throw err;
				}
			}
			if (!result.output) return;
			const draft: PrototypeDraft = {
				...session.draft,
				title: result.output.title,
				summary: result.output.summary,
				html: result.output.html,
				nextHint: undefined
			};
			session.markRevealPrepared(final ? 'final' : 'shadow', draft);
			debugLog('Builder', final ? 'reveal-final' : 'reveal-prep', {
				sessionId: session.sessionId,
				swipe: session.swipeCount,
				model: final ? REVEAL_MODEL_ID : BUILDER_MODEL_ID
			});
		} catch (err) {
			emitError(session, 'builder', err, 'builder-01');
		} finally {
			session.reveal.preparing = false;
			session.reveal.finalizing = false;
			setAgent(session, 'builder-01', 'Meridian', 'builder', 'idle', 'watching for swipes');
		}
	})();
	revealRuns.set(session, run);
	try {
		await run;
	} finally {
		if (revealRuns.get(session) === run) revealRuns.delete(session);
	}
}

function applyRevealDraft(session: EyeLoopSession): boolean {
	if (!session.reveal.draft) return false;
	session.draft = session.reveal.draft;
	session.emit('draft-updated', { draft: session.draft });
	return true;
}

function maybePrepareReveal(session: EyeLoopSession) {
	if (session.swipeCount < REVEAL_PREP_START) return;
	if (revealRuns.has(session)) return;
	if (session.swipeCount >= REVEAL_FORCE_PREP_AT || session.swipeCount % SYNTHESIS_CADENCE === 0) {
		void buildReveal(session, false);
	}
}

async function enterReveal(session: EyeLoopSession) {
	if (session.stage === 'reveal') return;
	session.setState('revealing');
	if (!session.reveal.draft) {
		await buildReveal(session, true);
	}
	applyRevealDraft(session);
	session.stage = 'reveal';
	session.clearReadyFacades();
	session.emit('stage-changed', { stage: 'reveal', swipeCount: session.swipeCount });
	session.setState('revealed');
}

export async function bootstrapSession(intent: string): Promise<SessionBootstrapResponse> {
	const session = createSession(intent);
	session.setState('warming');
	session.emit('session-ready', { intent, revealThreshold: AUTO_REVEAL_SWIPE_THRESHOLD });
	setAgent(session, 'oracle', 'Oracle', 'oracle', 'idle', 'monitoring');
	setAgent(session, 'builder-01', 'Meridian', 'builder', 'idle', 'waiting for session');
	for (const scout of SCOUT_ROSTER) {
		setAgent(session, scout.id, scout.name, 'scout', 'idle', 'warming');
	}

	const scaffold = buildScaffold(session);
	const coldStart = runColdStart(session);
	const refill = runRefill(session, 'bootstrap', RESERVOIR_MIN_READY, RESERVOIR_MIN_READY);
	const deadline = Date.now() + WARMUP_TIMEOUT_MS;
	while (session.facades.length < RESERVOIR_MIN_READY && Date.now() < deadline) {
		await sleep(250);
	}
	await Promise.allSettled([scaffold, coldStart, refill]);
	session.setState('ready');
	scheduleRefill(session, 'post-bootstrap top-off');
	return session.getBootstrapResponse(AUTO_REVEAL_SWIPE_THRESHOLD);
}

export async function handleSessionSwipe(session: EyeLoopSession, record: SwipeRecord) {
	const facade = session.findFacade(record.facadeId);
	if (!facade || !session.facades.some((f) => f.id === record.facadeId)) {
		return { ok: false as const, status: 404, error: 'Facade not found' };
	}
	if (record.decision === 'reject' && !session.antiPatterns.includes(facade.hypothesis)) {
		session.antiPatterns.push(facade.hypothesis);
	}
	session.consumeFacade(record.facadeId);
	session.addEvidence(record);

	const nextStage = session.concretenessFloor === 'mockup' ? 'mockups' : 'words';
	if (session.stage !== nextStage && session.stage !== 'reveal') {
		session.stage = nextStage;
		session.emit('stage-changed', { stage: session.stage, swipeCount: session.swipeCount });
	}

	void patchDraft(session, record);
	if (session.swipeCount > 0 && session.swipeCount % SYNTHESIS_CADENCE === 0) {
		void runSynthesis(session);
	}
	maybePrepareReveal(session);
	scheduleRefill(session, 'post-swipe refill');
	if (session.swipeCount >= AUTO_REVEAL_SWIPE_THRESHOLD) {
		await enterReveal(session);
	}
	return {
		ok: true as const,
		status: 200,
		swipeCount: session.swipeCount,
		stage: session.stage,
		queueStats: session.queueStats,
		revealPrepared: session.reveal.prepared
	};
}

export function findSession(sessionId: string | null | undefined): EyeLoopSession | null {
	return getSession(sessionId);
}
