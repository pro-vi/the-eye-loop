import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { GEMINI_API_KEY } from '$env/static/private';
import { context } from '$lib/server/context';
import { awaitFacadeSwipe, emitFacadeStale, emitAgentStatus } from '$lib/server/bus';
import type { Facade, AgentState } from '$lib/context/types';
import { debugLog } from '$lib/server/debug-log';
import { HTML_QUALITY_RULES } from '$lib/server/prompts';

// ── Constants ────────────────────────────────────────────────────────

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
const MODEL = google('gemini-3.1-flash-lite-preview');
const IMAGE_MODEL = google('gemini-3.1-flash-image-preview');
const SWIPE_TIMEOUT_MS = 30_000;
const MAX_HISTORY = 8;
// ── Scout roster ────────────────────────────────────────────────────

const SCOUT_ROSTER = [
	{ id: 'scout-01', name: 'Iris' },
	{ id: 'scout-02', name: 'Prism' },
	{ id: 'scout-03', name: 'Lumen' }
] as const;

const SCOUT_LENSES: Record<string, string> = {
	Iris: 'Your lens: LOOK AND FEEL — colors, shapes, light vs dark, rounded vs sharp, photos vs illustrations.',
	Prism: 'Your lens: LAYOUT AND INTERACTION — sidebar vs tabs, cards vs lists, dense vs spacious, scroll vs pages.',
	Lumen: 'Your lens: VOICE AND PERSONALITY — friendly vs professional, playful vs serious, branded vs neutral.'
};

// ── Zod schema (flat — no z.union for Gemini compat) ─────────────────

const ScoutOutputSchema = z.object({
	label: z.string(),
	hypothesis: z.string(),
	axis_targeted: z.string(),
	format: z.enum(['word', 'image', 'mockup']),
	content: z.string(),
	accept_implies: z.string(),
	reject_implies: z.string()
});

// ── Concreteness floor ──────────────────────────────────────────────

const FORMAT_INSTRUCTIONS: Record<Facade['format'], string> = {
	word: 'FORMAT: word. Output a single evocative word or 2-3 word phrase. The label IS the content. Examples: "Warm glow", "Sharp edges", "Cozy nook", "Open sky". NOT: "Biophilic brutalism", "Synaptic Echo", "Tectonic Granularity".',
	image: 'FORMAT: image. Describe a visual moodboard or UI screenshot for an image generator. Be CONCRETE and VISUAL — describe what someone would SEE, not abstract concepts. Good: "A warm finance app card with rounded corners showing $420 spent, peach background, friendly serif font". Bad: "Gravitational Topology of ephemeral data flows".',
	mockup: 'FORMAT: mockup. Describe a specific UI screen with layout, components, colors, and typography. Be a DESIGNER, not a philosopher. Good: "Mobile screen with top balance card ($2,400), 3 spending category pills below, warm cream background, Georgia font". Bad: "The Monolithic Monolith vs. The Fractal Lattice".'
};

function getFormatInstruction(scoutName: string): { floor: Facade['format']; instruction: string } {
	const floor = context.concretenessFloor;

	// Iris pre-buffers images during word stage so they're ready when floor advances.
	// Other scouts stay on words — ensures the queue always has fast facades to swipe.
	if (scoutName === 'Iris' && floor === 'word' && context.evidence.length >= 1) {
		return {
			floor: 'image',
			instruction: FORMAT_INSTRUCTIONS.image + '\nYou are PRE-BUFFERING. The user is still swiping words — your image will be ready when the stage advances. Make it count.'
		};
	}

	// Mixed queue rule: if queue already has a slow facade (image), other scouts
	// generate fast formats (word/mockup) to keep the user swiping.
	if (scoutName !== 'Iris' && floor === 'image') {
		const queueHasImage = context.facades.some((f) => f.format === 'image');
		if (queueHasImage) {
			return {
				floor: 'word',
				instruction: FORMAT_INSTRUCTIONS.word + '\nQueue already has an image pending. Generate a fast word probe so the user has something to swipe while the image renders.'
			};
		}
	}

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

export function startScout(agentId: string, name: string): () => void {
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

					const { floor, instruction } = getFormatInstruction(name);

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

					const result = await generateText({
						model: MODEL,
						output: Output.object({ schema: ScoutOutputSchema }),
						temperature: 1.0,
						system,
						prompt: 'Generate the next taste probe. Follow the format instruction.',
						abortSignal: signal
					});

					if (!alive()) break;

					const output = result.output;
					if (!output) continue;

					// Enforce concreteness floor — LLM may ignore format instruction
					const ALLOWED: Record<Facade['format'], Facade['format'][]> = {
						word: ['word'],
						image: ['image', 'mockup'],
						mockup: ['mockup']
					};
					const format = ALLOWED[floor].includes(output.format) ? output.format : floor;

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
						content: format === 'word' ? output.label : output.content,
						format
					};

					// ── Rendering pipeline ──────────────────────────────
					// Image/mockup facades must be fully rendered before
					// reaching the queue. If rendering fails, skip this
					// facade entirely — loop and regenerate.

					if (format === 'image') {
						setStatus(agent, 'thinking', `rendering image: "${facade.label}"`);
						const imagePrompt = `Generate a UI MOODBOARD or STYLE CONCEPT image — NOT a literal app screenshot. This should feel like a designer's inspiration board or color/texture study that captures a specific aesthetic direction.\n\nStyle direction: ${output.content}\n\nRules:\n- Abstract or atmospheric — NOT a phone mockup or wireframe\n- Show colors, textures, typography samples, material references\n- Think Dribbble moodboard or Pinterest inspiration board\n- Fill the entire frame — no device bezels, no hands holding phones`;

						let imageRendered = false;
						for (let attempt = 0; attempt < 2; attempt++) {
							try {
								const imgResult = await generateText({
									model: IMAGE_MODEL,
									providerOptions: {
										google: {
											responseModalities: ['TEXT', 'IMAGE'],
											imageConfig: { aspectRatio: '3:2', imageSize: '1K' }
										}
									},
									prompt: imagePrompt,
									abortSignal: signal
								});

								if (!alive()) break;

								if (imgResult.files?.length) {
									const file = imgResult.files[0];
									facade.imageDataUrl = `data:${file.mediaType};base64,${file.base64}`;
									debugLog(name, 'image-rendered', {
										label: facade.label,
										mediaType: file.mediaType,
										sizeKB: Math.round(file.base64.length * 0.75 / 1024),
										attempt: attempt + 1
									});
									imageRendered = true;
									break;
								} else {
									debugLog(name, 'image-no-files', {
										label: facade.label,
										attempt: attempt + 1
									});
									// Retry once
								}
							} catch (err) {
								if (!alive()) break;
								debugLog(name, 'image-fail', {
									label: facade.label,
									attempt: attempt + 1,
									err: String(err)
								});
								// Retry once
							}
						}

						if (!alive()) break;

						if (!imageRendered) {
							// Fall back to word format instead of dropping the facade
							debugLog(name, 'image-fallback-word', { label: facade.label });
							facade.format = 'word';
							facade.content = facade.label;
							delete facade.imageDataUrl;
						}
					} else if (format === 'mockup' && !/<div|<html|<section/i.test(output.content)) {
						setStatus(agent, 'thinking', `generating mockup HTML: "${facade.label}"`);
						try {
							const antiStr = context.antiPatterns.length
								? context.antiPatterns.join(', ')
								: 'none yet';
							const acceptedStr = context.draft.acceptedPatterns.length
								? context.draft.acceptedPatterns.join(', ')
								: 'none yet';

							const mockupPrompt = `Generate complete HTML+CSS that VISUALLY DEMONSTRATES this hypothesis.
The user will swipe accept/reject on this mockup — they should be able to tell what it tests by LOOKING at it.

Hypothesis: ${output.hypothesis}
Visual direction: ${output.content}
Anti-patterns (NEVER use): ${antiStr}
Accepted patterns (respect these): ${acceptedStr}

${HTML_QUALITY_RULES}

Output ONLY the HTML — no markdown fences, no explanation.
Mobile viewport 375x667. No scripts. No external resources.`;

							const htmlResult = await generateText({
								model: MODEL,
								prompt: mockupPrompt,
								maxOutputTokens: 2000,
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
				await sleep(1000);
			}
		}

		if (activeRuns.get(agentId) === stop) {
			setStatus(agent, 'idle', '');
			activeRuns.delete(agentId);
		}
	})();

	return stop;
}

const pendingTimers: ReturnType<typeof setTimeout>[] = [];

export function startAllScouts(): void {
	SCOUT_ROSTER.forEach(({ id, name }, i) => {
		if (i === 0) {
			startScout(id, name);
		} else {
			pendingTimers.push(setTimeout(() => startScout(id, name), i * 500));
		}
	});
}

export function stopScout(agentId: string) {
	activeRuns.get(agentId)?.();
}

export function stopAllScouts() {
	for (const t of pendingTimers) clearTimeout(t);
	pendingTimers.length = 0;
	for (const stop of activeRuns.values()) stop();
	activeRuns.clear();
}
