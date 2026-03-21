import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { GEMINI_API_KEY } from '$env/static/private';
import { context } from '$lib/server/context';
import { awaitFacadeSwipe, emitFacadeStale, emitAgentStatus } from '$lib/server/bus';
import type { Facade, AgentState } from '$lib/context/types';

// ── Constants ────────────────────────────────────────────────────────

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
const MODEL = google('gemini-3.1-flash-lite-preview');
const SWIPE_TIMEOUT_MS = 30_000;
const MAX_HISTORY = 8;
// ── Scout roster ────────────────────────────────────────────────────

const SCOUT_ROSTER = [
	{ id: 'scout-01', name: 'Iris' },
	{ id: 'scout-02', name: 'Prism' },
	{ id: 'scout-03', name: 'Lumen' }
] as const;

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

function getFormatInstruction(evidenceCount: number): { floor: Facade['format']; instruction: string } {
	if (evidenceCount < 4) {
		return {
			floor: 'word',
			instruction: `You have ${evidenceCount} swipes of evidence. This is early exploration — use a single evocative WORD or short phrase (2-3 words max). Set format to "word" and put the word in both label and content.`
		};
	}
	if (evidenceCount < 8) {
		return {
			floor: 'image',
			instruction: `You have ${evidenceCount} swipes of evidence. Describe an IMAGE — a moodboard, color palette, or visual concept. Set format to "image" and put the visual description in content. Label should be a short title.`
		};
	}
	return {
		floor: 'mockup',
		instruction: `You have ${evidenceCount} swipes of evidence. Describe a concrete MOCKUP with specific layout, typography, and color decisions. Set format to "mockup" and put the full description in content. Label should be a short title.`
	};
}

// ── Prompt ───────────────────────────────────────────────────────────

const SCOUT_PROMPT = `You are a taste scout — your job is to generate the next visual probe
that will be most informative about this user's preferences.

The user said they want to build: "{INTENT}"

EVIDENCE HISTORY (accept = they liked it, reject = they didn't,
hesitant = they took a long time to decide):

{EVIDENCE}

EMERGENT AXES (oracle-discovered taste dimensions):
{EMERGENT_AXES}

YOUR AXIS ASSIGNMENT:
{AXIS_ASSIGNMENT}

QUEUE (probes already pending — do NOT duplicate):
{QUEUE_CONTENTS}

ANTI-PATTERNS (hard constraints — NEVER use these):
{ANTI_PATTERNS}

DIVERSITY: Your last 3 probes tested: {RECENT_HYPOTHESES}.
Do NOT probe the same territory again. Find a DIFFERENT gap.

PROBE BRIEF (from Builder — if present, this takes priority):
{PROBE_BRIEF}

FORMAT INSTRUCTION:
{FORMAT_INSTRUCTION}

RULES:
- Follow your axis assignment OR pick the most uncertain axis not already queued
- Do NOT duplicate what's already in the queue
- Do NOT repeat patterns the user already rejected
- Do NOT re-confirm things we already know (resolved axes)
- Target EXPLORING or UNPROBED axes
- A probe the user would HESITATE on is more informative
- Think like Akinator — maximally partition the remaining space
- Set axis_targeted to the emergent axis label you're probing
- Respect the format instruction above`;

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
	if (!context.synthesis?.axes?.length) return 'Not yet available (need 4+ swipes).';
	return context.synthesis.axes
		.map((a) => {
			const leaning = a.leaning_toward ? ` → ${a.leaning_toward}` : '';
			return `  - ${a.label} [${a.confidence}${leaning}]: ${a.poleA} vs ${a.poleB}\n    Evidence: ${a.evidence_basis}`;
		})
		.join('\n');
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

				const probe = context.getNextProbe();
				const probeBrief = probe
					? `${probe.brief}\nContext: ${probe.context}`
					: 'None — self-assign from most uncertain gap';

				let facadeQueued = false;
				try {
					const antiStr = context.antiPatterns.length
						? context.antiPatterns.map((p) => `  - ${p}`).join('\n')
						: '  (none yet)';

					const { instruction } = getFormatInstruction(context.evidence.length);

					const system = SCOUT_PROMPT.replace('{INTENT}', context.intent)
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

					const facade: Facade = {
						id: crypto.randomUUID(),
						agentId,
						hypothesis: output.hypothesis,
						label: output.label,
						content: output.content,
						format: output.format
					};

					context.pushFacade(facade);
					facadeQueued = true;
					agent.lastFacadeId = facade.id;

					setStatus(agent, 'waiting', `"${facade.label}"`);

					const outcome = await awaitFacadeSwipe(facade.id, SWIPE_TIMEOUT_MS, signal);

					if (!alive() || outcome === 'aborted') break;
					if (outcome === 'timeout') {
						const idx = context.facades.findIndex((f) => f.id === facade.id);
						if (idx !== -1) context.facades.splice(idx, 1);
						emitFacadeStale({ facadeId: facade.id });
						continue;
					}
					if (outcome === 'stale') continue;

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

export function startAllScouts(): void {
	for (const { id, name } of SCOUT_ROSTER) {
		startScout(id, name);
	}
}

export function stopScout(agentId: string) {
	activeRuns.get(agentId)?.();
}

export function stopAllScouts() {
	for (const stop of activeRuns.values()) stop();
	activeRuns.clear();
}
