import { generateText, Output } from 'ai';
import { z } from 'zod';
import { context } from '$lib/server/context';
import {
	awaitFacadeSwipe,
	emitFacadeStale,
	emitAgentStatus,
	emitError,
	classifyErrorCode
} from '$lib/server/bus';
import type { Facade, AgentState } from '$lib/context/types';
import { debugLog } from '$lib/server/debug-log';
import { HTML_QUALITY_RULES } from '$lib/server/prompts';
import { SCOUT_MODEL } from '$lib/server/ai';

// ── Constants ────────────────────────────────────────────────────────
// 30s from when user SEES the card (top of stack), not from queue push.
// Visibility signal sent by client via POST /api/facade-visible.
const SWIPE_TIMEOUT_MS = 30_000;
const MAX_HISTORY = 8;
// Retry strategy under provider failure:
// - provider_auth_failure: zero retries (401 never recovers mid-session; a
//   token rotation needs a server restart). Scout exits cleanly and the
//   iter-8 client banner surfaces the env var to the user.
// - provider_error / generation_error: exponential backoff 1s→2s→4s→8s→16s
//   cap preserves first-retry latency for transient network/schema errors.
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 16_000;
const RETRY_EXP_CAP = 4; // shift cap: 2^4 = 16
// ── Scout roster ────────────────────────────────────────────────────

const SCOUT_ROSTER = [
	{ id: 'scout-01', name: 'Iris' },
	{ id: 'scout-02', name: 'Prism' },
	{ id: 'scout-03', name: 'Lumen' },
	{ id: 'scout-04', name: 'Aura' },
	{ id: 'scout-05', name: 'Facet' },
	{ id: 'scout-06', name: 'Echo' }
] as const;

const SCOUT_LENSES: Record<string, string> = {
	Iris: 'Your lens: LOOK AND FEEL — colors, shapes, light vs dark, rounded vs sharp, photos vs illustrations.',
	Prism: 'Your lens: LAYOUT AND INTERACTION — sidebar vs tabs, cards vs lists, dense vs spacious, scroll vs pages.',
	Aura: 'Your lens: MOOD AND ATMOSPHERE — warm vs cool, calm vs energetic, intimate vs expansive, organic vs digital.',
	Facet: 'Your lens: INFORMATION DESIGN — charts vs text, numbers vs narrative, dense data vs key metrics, tables vs cards.',
	Echo: 'Your lens: MOTION AND BEHAVIOR — animated vs static, transitions vs instant, gesture vs click, fluid vs snappy.',
	Lumen: 'Your lens: VOICE AND PERSONALITY — friendly vs professional, playful vs serious, branded vs neutral.'
};

// ── Zod schemas ─────────────────────────────────────────────────────
// iter-79: split the single 7-field ScoutOutputSchema into floor-specific
// schemas, applying iter-71/77's asymmetric-schema-per-callsite pattern to
// the scout path. Two field-level redundancies motivated the split:
//   (a) `format`: the consumer at line ~289 does
//       `ALLOWED[floor].includes(output.format) ? output.format : floor`
//       where ALLOWED.word = ['word'] and ALLOWED.mockup = ['mockup'] — so
//       the ternary resolves to `floor` in every code path, making the
//       emitted format field pure tool-definition + output overhead.
//   (b) `content` (word-floor only): the consumer at line ~307 does
//       `format === 'word' ? output.label : output.content`, so for the
//       word floor the LLM emits a content string that is NEVER read
//       (label is re-used as content). Under a 12s validator window every
//       scout call runs at concretenessFloor = 'word' (evidence<4), so
//       this redundancy fires on the critical time_to_first_facade path.
// Mockup floor retains `content` because the consumer reads output.content
// (and the mockup-HTML-rendering fallback at line ~317 also reads it).
// Forward-deploy: preserves facade_format_valid_count union-membership
// identity (iter-67) by construction — format is always set from `floor`
// which is typed as Facade['format'] (∈ {word, mockup}).
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

// ── Concreteness floor ──────────────────────────────────────────────

const FORMAT_INSTRUCTIONS: Record<Facade['format'], string> = {
	word: 'FORMAT: word. Output a single evocative word or 2-3 word phrase. The label IS the content. Examples: "Warm glow", "Sharp edges", "Cozy nook", "Open sky". NOT: "Biophilic brutalism", "Synaptic Echo", "Tectonic Granularity".',
	mockup: 'FORMAT: mockup. Describe a specific UI screen with layout, components, colors, and typography. Be a DESIGNER, not a philosopher. Good: "Mobile screen with top balance card ($2,400), 3 spending category pills below, warm cream background, Georgia font". Bad: "The Monolithic Monolith vs. The Fractal Lattice".'
};

function getFormatInstruction(): { floor: Facade['format']; instruction: string } {
	const floor = context.concretenessFloor;
	return { floor, instruction: FORMAT_INSTRUCTIONS[floor] };
}

// ── Prompt ───────────────────────────────────────────────────────────

const SCOUT_PROMPT = `You are {SCOUT_NAME} — a taste scout. You show the user one thing and they swipe accept or reject. That's it.
{SCOUT_LENS}

The user wants to build: "{INTENT}"

EVIDENCE:
{EVIDENCE}

EMERGENT AXES:
{EMERGENT_AXES}

YOUR ASSIGNMENT: {AXIS_ASSIGNMENT}

ALREADY QUEUED (don't duplicate): {QUEUE_CONTENTS}

ANTI-PATTERNS (NEVER use): {ANTI_PATTERNS}

RECENT PROBES (don't repeat): {RECENT_HYPOTHESES}

BUILDER BRIEF: {PROBE_BRIEF}

{FORMAT_INSTRUCTION}

CRITICAL — LABEL RULES:
- The label is what the user SEES on the swipe card
- It must be understandable in 1 SECOND by a normal person
- 1-4 words max. Plain language. No jargon. No philosophy.
- GOOD labels: "Dark mode", "Friendly cards", "Clean grid", "Sidebar nav", "Playful icons"
- BAD labels: "Synaptic Echo", "Tectonic Granularity", "Ephemeral Layering", "Biophilic brutalism"
- Think app store screenshot caption, NOT art exhibition title

RULES:
- Follow your assignment or pick the most uncertain axis
- Don't duplicate what's queued
- Don't repeat rejected patterns
- A probe the user would HESITATE on is most informative
- Be a DESIGNER showing options, not a philosopher naming concepts`;

// ── Local history ────────────────────────────────────────────────────

interface HistoryEntry {
	label: string;
	hypothesis: string;
	decision: 'accept' | 'reject';
	latency_signal: string;
	lesson: string;
}

function serializeHistory(entries: HistoryEntry[]): string {
	if (!entries.length) return '(none yet)';
	return entries
		.map((e, i) => `${i + 1}. [${e.decision.toUpperCase()}] "${e.label}" — ${e.lesson}`)
		.join('\n');
}

function recentHypotheses(entries: HistoryEntry[]): string {
	if (!entries.length) return '(none yet — this is your first probe)';
	return entries
		.slice(0, 3)
		.map((e) => `"${e.hypothesis}"`)
		.join(', ');
}

function getEmergentAxes(): string {
	const s = context.synthesis;
	if (!s) return 'Not yet available (need 4+ swipes).';
	const parts: string[] = [];
	if (s.axes.length) {
		parts.push(
			s.axes
				.map((a) => {
					const leaning = a.leaning_toward ? ` → ${a.leaning_toward}` : '';
					return `  - ${a.label} [${a.confidence}${leaning}]: ${a.poleA} vs ${a.poleB}\n    Evidence: ${a.evidence_basis}`;
				})
				.join('\n')
		);
	} else {
		parts.push('  (no axes discovered yet)');
	}
	if (s.edge_case_flags.length) {
		parts.push(`Flags: ${s.edge_case_flags.join(', ')}`);
	}
	if (s.persona_anima_divergence) {
		parts.push(`Divergence: ${s.persona_anima_divergence}`);
	}
	return parts.join('\n');
}

function getAxisAssignment(scoutName: string): string {
	if (!context.synthesis?.scout_assignments?.length) return 'No assignment yet — self-assign from most uncertain gap.';
	const assignment = context.synthesis.scout_assignments.find((a) => a.scout === scoutName);
	if (!assignment) return 'No assignment for you — pick the most uncertain axis not already queued.';
	return `Probe "${assignment.probe_axis}" — ${assignment.reason}`;
}

function getQueueContents(): string {
	if (!context.facades.length) return '(queue empty)';
	return context.facades
		.map((f) => `  - "${f.label}" (${f.agentId}) — hypothesis: ${f.hypothesis}`)
		.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────

function setStatus(agent: AgentState, status: AgentState['status'], focus: string) {
	agent.status = status;
	agent.focus = focus;
	emitAgentStatus({ agent });
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Run tracking ─────────────────────────────────────────────────────

const activeRuns = new Map<string, () => void>();

// ── Public API ───────────────────────────────────────────────────────

function startScout(agentId: string, name: string): () => void {
	activeRuns.get(agentId)?.();

	const controller = new AbortController();
	const { signal } = controller;
	const capturedSessionId = context.sessionId;
	const history: HistoryEntry[] = [];

	const agent: AgentState = {
		id: agentId,
		name,
		role: 'scout',
		status: 'idle',
		focus: ''
	};
	context.agents.set(agentId, agent);

	const stop = () => {
		controller.abort();
		activeRuns.delete(agentId);
	};
	activeRuns.set(agentId, stop);

	const alive = () =>
		!signal.aborted &&
		context.sessionId === capturedSessionId &&
		context.stage !== 'reveal';

	(async () => {
		let consecutiveFailures = 0;
		while (alive()) {
			try {
				if (context.queuePressure === 'full') {
					setStatus(agent, 'queued', 'queue full');
					await sleep(2000);
					continue;
				}

				setStatus(agent, 'thinking', 'generating probe');

				debugLog(name, 'iter', {
					evidence: context.evidence.length,
					queue: context.facades.map((f) => `${f.label} (${f.agentId})`),
					probes: context.probes.length,
					synthesis: context.synthesis ? `${context.synthesis.axes.length} axes` : 'none',
					antiPatterns: context.antiPatterns.length
				});

				const probe = context.getNextProbe();
				const probeBrief = probe
					? `${probe.brief}\nContext: ${probe.context}`
					: 'None — self-assign from most uncertain gap';

				let facadeQueued = false;
				try {
					const antiStr = context.antiPatterns.length
						? context.antiPatterns.map((p) => `  - ${p}`).join('\n')
						: '  (none yet)';

					const { floor, instruction } = getFormatInstruction();

					const system = SCOUT_PROMPT.replace('{SCOUT_NAME}', name)
						.replace('{SCOUT_LENS}', SCOUT_LENSES[name] ?? '')
						.replace('{INTENT}', context.intent)
						.replace('{EVIDENCE}', context.toEvidencePrompt())
						.replace('{EMERGENT_AXES}', getEmergentAxes())
						.replace('{AXIS_ASSIGNMENT}', getAxisAssignment(name))
						.replace('{QUEUE_CONTENTS}', getQueueContents())
						.replace('{ANTI_PATTERNS}', antiStr)
						.replace('{RECENT_HYPOTHESES}', recentHypotheses(history))
						.replace('{PROBE_BRIEF}', probeBrief)
						.replace('{FORMAT_INSTRUCTION}', instruction);

					// iter-79: schema chosen per floor; see ScoutOutputSchemaWord/
					// Mockup at top of file. format is always set from `floor` below,
					// so the LLM no longer emits a redundant format field.
					const scoutSchema =
						floor === 'word' ? ScoutOutputSchemaWord : ScoutOutputSchemaMockup;
					const result = await generateText({
						model: SCOUT_MODEL,
						output: Output.object({ schema: scoutSchema }),
						temperature: 1.0,
						system,
						prompt: 'Generate the next taste probe. Follow the format instruction.',
						abortSignal: signal
					});
					consecutiveFailures = 0;

					if (!alive()) break;

					const output = result.output;
					if (!output) continue;

					// iter-79: format is determined by floor (not by LLM output). The
					// previous ALLOWED[floor].includes(output.format) ? output.format :
					// floor expression always resolved to floor because ALLOWED.word =
					// ['word'] and ALLOWED.mockup = ['mockup'] — a no-op that now
					// collapses to the direct assignment with the redundant schema
					// field removed.
					const format: Facade['format'] = floor;

					// iter-79: content narrowing. Mockup schema carries a `content`
					// string; word schema drops it (unused when format === 'word' at
					// the consumer). 'content' in output narrows the schema union to
					// the mockup variant, giving type-safe access without a cast.
					const mockupContent =
						'content' in output && typeof output.content === 'string'
							? output.content
							: '';

					// Dedup: skip if another scout already queued the same axis
					const axisLower = output.axis_targeted.toLowerCase();
					const isDuplicate = context.facades.some(
						(f) => f.axisTargeted?.toLowerCase() === axisLower
					);
					if (isDuplicate) {
						debugLog(name, 'dedup-skip', { axis: output.axis_targeted, label: output.label });
						continue;
					}

					const facade: Facade = {
						id: crypto.randomUUID(),
						agentId,
						hypothesis: output.hypothesis,
						axisTargeted: output.axis_targeted,
						label: output.label,
						content: format === 'word' ? output.label : mockupContent,
						format,
						acceptImplies: output.accept_implies,
						rejectImplies: output.reject_implies
					};

					// ── Mockup rendering ────────────────────────────────
					// Ensure mockup content is renderable HTML. If the
					// LLM returned a description, generate actual HTML.

					if (format === 'mockup' && !/<div|<html|<section/i.test(mockupContent)) {
						setStatus(agent, 'thinking', `generating mockup HTML: "${facade.label}"`);
						try {
							const antiStr = context.antiPatterns.length
								? context.antiPatterns.join(', ')
								: 'none yet';
							const acceptedStr = context.draft.acceptedPatterns.length
								? context.draft.acceptedPatterns.join(', ')
								: 'none yet';

							const draftHtml = context.draft.html;
						const hasDraft = draftHtml && draftHtml.length > 50;

						const mockupPrompt = `Generate complete HTML+CSS that VISUALLY DEMONSTRATES this hypothesis.
The user will swipe accept/reject — they should tell what it tests by LOOKING at it.

Hypothesis: ${output.hypothesis}
Visual direction: ${mockupContent}
Anti-patterns (NEVER use): ${antiStr}
Accepted patterns (respect these): ${acceptedStr}

${hasDraft ? `BUILDER'S CURRENT DRAFT (use as gravity well, not template):
${draftHtml.slice(0, 1500)}

The builder has an evolving prototype above. Your mockup should feel like
it BELONGS in the same product — same color palette, same typography, same
visual language. But you are testing something NEW within that world.
Don't copy the draft — RIFF on it. Keep what's settled, explore what's open.
Change the thing your hypothesis tests. Be creative with HOW you show it.` : `No builder draft yet — generate a fresh mockup from evidence.`}

${HTML_QUALITY_RULES}

Output ONLY the HTML — no markdown fences, no explanation.
Mobile viewport 375x667. No scripts. No external resources.`;

							const htmlResult = await generateText({
								model: SCOUT_MODEL,
								prompt: mockupPrompt,
								maxOutputTokens: 10000,
								abortSignal: signal
							});

							if (!alive()) break;

							const text = htmlResult.text ?? '';
							const htmlMatch = text.match(/```html?\n?([\s\S]*?)```/);
							const html = htmlMatch ? htmlMatch[1] : text;

							if (/<div|<html|<section/i.test(html)) {
								facade.content = html;
							} else {
								debugLog(name, 'mockup-fallback-word', { label: facade.label });
								facade.format = 'word';
								facade.content = facade.label;
							}
						} catch (err) {
							if (!alive()) break;
							debugLog(name, 'mockup-fallback-word', { label: facade.label, err: String(err) });
							facade.format = 'word';
							facade.content = facade.label;
						}
					}

					context.pushFacade(facade);
					facadeQueued = true;
					agent.lastFacadeId = facade.id;

					debugLog(name, 'push', {
						label: facade.label,
						content: facade.content.slice(0, 200),
						format,
						axis: output.axis_targeted,
						hypothesis: output.hypothesis,
						accept_implies: output.accept_implies,
						reject_implies: output.reject_implies,
						probe: probe ? 'from builder' : 'self-assigned'
					});

					setStatus(agent, 'waiting', `"${facade.label}"`);

					const outcome = await awaitFacadeSwipe(facade.id, SWIPE_TIMEOUT_MS, signal);

					const outcomeType = typeof outcome === 'string' ? outcome : outcome.decision;
					debugLog(name, 'swipe', { label: facade.label, outcome: outcomeType });

					if (!alive() || outcome === 'aborted') {
						if (probe) context.probes.unshift(probe);
						break;
					}
					if (outcome === 'timeout') {
						if (probe) context.probes.unshift(probe);
						const idx = context.facades.findIndex((f) => f.id === facade.id);
						if (idx !== -1) context.facades.splice(idx, 1);
						emitFacadeStale({ facadeId: facade.id });
						continue;
					}
					if (outcome === 'stale') {
						if (probe) context.probes.unshift(probe);
						continue;
					}

					history.unshift({
						label: facade.label,
						hypothesis: output.hypothesis,
						decision: outcome.decision,
						latency_signal: outcome.latencyBucket ?? 'slow',
						lesson:
							outcome.decision === 'accept'
								? output.accept_implies
								: output.reject_implies
					});
					if (history.length > MAX_HISTORY) history.pop();
				} finally {
					// Requeue claimed probe if we failed before queuing the facade
					if (probe && !facadeQueued) {
						context.probes.unshift(probe);
					}
				}
			} catch (err) {
				if (!alive()) break;
				console.error(`[scout:${agentId}]`, err);
				const code = classifyErrorCode(err);
				emitError({
					source: 'scout',
					code,
					agentId,
					message: err instanceof Error ? err.message : String(err)
				});
				if (code === 'provider_auth_failure') {
					// Return directly from the IIFE so the post-loop cleanup's
					// setStatus('idle', '') cannot overwrite this diagnostic focus
					// ~1ms later — without this, the UX agent rail loses the
					// "provider auth failed" signal that iter-13 specifically
					// added to tell operators which scouts died of auth.
					setStatus(agent, 'idle', 'provider auth failed');
					if (activeRuns.get(agentId) === stop) {
						activeRuns.delete(agentId);
					}
					return;
				}
				consecutiveFailures++;
				const backoffMs = Math.min(
					RETRY_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, RETRY_EXP_CAP),
					RETRY_MAX_MS
				);
				await sleep(backoffMs);
			}
		}

		if (activeRuns.get(agentId) === stop) {
			setStatus(agent, 'idle', '');
			activeRuns.delete(agentId);
		}
	})();

	return stop;
}

// Scout starts are simultaneous. The historical 500ms inter-scout stagger
// (specs/ANNOUNCEMENT-scout-dedup.md) assumed LLM-probe latency < 500ms so
// scout-N's prompt would read scout-(N-1)'s just-pushed facade; that premise
// no longer holds with the current scout tier at ~1-2s per call. The real dedup is the
// post-generateText axis-targeted isDuplicate check at line ~292, reinforced
// by distinct SCOUT_LENSES biasing each scout toward a different probe axis.
// Starting all 6 scouts at session-ready compresses scout-06's start by
// ~2.5s, directly improving the V0 "first facades quickly" demo row.
export function startAllScouts(): void {
	for (const { id, name } of SCOUT_ROSTER) startScout(id, name);
}

export function stopAllScouts() {
	for (const stop of activeRuns.values()) stop();
	activeRuns.clear();
}
