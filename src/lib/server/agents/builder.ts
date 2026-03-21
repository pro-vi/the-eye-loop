import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { GEMINI_API_KEY } from '$env/static/private';
import { context } from '$lib/server/context';
import {
	onSessionReady,
	onSwipeResult,
	emitDraftUpdated,
	emitBuilderHint,
	emitEvidenceUpdated,
	emitAgentStatus
} from '$lib/server/bus';
import type { AgentState, Facade, SwipeRecord } from '$lib/context/types';
import { debugLog } from '$lib/server/debug-log';

// ── Constants ────────────────────────────────────────────────────────

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
const MODEL = google('gemini-3.1-flash-lite-preview');
const BUILDER_ID = 'builder-01';
const BUILDER_NAME = 'Meridian';

// ── Zod schema (flat — no z.union for Gemini compat) ─────────────────

const DraftUpdateSchema = z.object({
	title: z.string(),
	summary: z.string(),
	html: z.string(),
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

// ── Prompts ──────────────────────────────────────────────────────────

const SCAFFOLD_PROMPT = `You are the Builder agent in The Eye Loop.

The user just started a session. Generate an initial draft prototype scaffold
from their intent. This is the FIRST draft — a plausible starting point that
will evolve as the user swipes. Keep it simple but visible.

USER INTENT: "{intent}"

OUTPUT:
- title: a working title for the prototype
- summary: 1-2 sentence description of what this will become
- html: basic HTML+CSS scaffold (mobile viewport 375x667, inline styles, no scripts).
  Show the intent visually — placeholder sections, approximate layout, muted palette.
- acceptedPatterns: [] (none yet)
- rejectedPatterns: [] (none yet)
- probeBriefs: [] (no evidence yet)
- nextHint: null`;

const SWIPE_PROMPT = `You are the builder agent. You assemble a prototype from what users
have shown through their choices — not from what they said.

The user said they want to build: "{intent}"

EVIDENCE HISTORY:

{evidence}

EMERGENT AXES (oracle-discovered taste dimensions):
{oracle_synthesis}
Use RESOLVED axes as constraints. EXPLORING axes = don't commit yet. LEANING = likely direction.

CURRENT DRAFT:
  title: {draft_title}
  summary: {draft_summary}

CURRENT DRAFT HTML:
{current_draft_html}

ACCEPTED PATTERNS SO FAR: {accepted_patterns}
REJECTED PATTERNS SO FAR: {rejected_patterns}

ANTI-PATTERNS (hard constraints — NEVER violate):
{anti_patterns}

LAST SWIPE:
  facade_id: {facade_id}
  decision: {decision}
  hypothesis: "{hypothesis}"
  content: "{content_summary}"

RULES:
- Ground everything in the evidence
- Anti-patterns (rejected things) are HARD CONSTRAINTS
- Reference specific accepted/rejected items as justification
- Probe briefs must be about SPECIFIC UI COMPONENTS, not abstract dimensions
- acceptedPatterns and rejectedPatterns are DELTAS — only new patterns from THIS swipe
- html must be COMPLETE — include all sections, not just changes
- html is rendered in a 375x667 mobile viewport with inline styles only, no scripts
- Use width: 100% and max-width: 375px on the body/root. No horizontal overflow.

OUTPUT: updated title, summary, html, pattern deltas, probe briefs, nextHint`;

// ── Helpers ──────────────────────────────────────────────────────────

function summarizeFacade(facade: Facade): string {
	if (facade.format === 'word') return facade.label;
	if (facade.format === 'image') return facade.content.slice(0, 200);
	return `[HTML mockup, ${facade.content.length} chars]`;
}

function setStatus(status: AgentState['status'], focus: string) {
	const agent: AgentState = {
		id: BUILDER_ID,
		name: BUILDER_NAME,
		role: 'builder',
		status,
		focus
	};
	context.agents.set(BUILDER_ID, agent);
	emitAgentStatus({ agent });
}

// ── Serialization gate ───────────────────────────────────────────────

let busy = false;
let pendingSwipe: { facade: Facade; record: SwipeRecord; sessionId: string } | null = null;
let cleanup: Array<() => void> = [];

function drainPending() {
	if (pendingSwipe && pendingSwipe.sessionId === context.sessionId) {
		const p = pendingSwipe;
		pendingSwipe = null;
		rebuild(p.facade, p.record);
	} else {
		pendingSwipe = null;
	}
}

// ── Rebuild (one LLM call per invocation) ────────────────────────────

let lastRebuiltSwipe = -1;

async function rebuild(facade: Facade, record: SwipeRecord) {
	// Dedup: HMR can register multiple listeners — only rebuild once per swipe
	if (context.swipeCount === lastRebuiltSwipe) return;
	lastRebuiltSwipe = context.swipeCount;

	busy = true;
	pendingSwipe = null;
	const capturedId = context.sessionId;
	setStatus('thinking', `analyzing ${record.decision} on "${facade.label}"`);

	try {
		const antiStr = context.antiPatterns.length
			? context.antiPatterns.map((p) => `  - ${p}`).join('\n')
			: '  (none yet)';

		const synthStr = context.synthesis
			? context.synthesis.axes
					.map((a) => `  ${a.label}: ${a.poleA} ↔ ${a.poleB} [${a.confidence}${a.leaning_toward ? ` → ${a.leaning_toward}` : ''}]`)
					.join('\n') +
				(context.synthesis.persona_anima_divergence
					? `\nDivergence: ${context.synthesis.persona_anima_divergence}`
					: '') +
				(context.synthesis.edge_case_flags.length
					? `\nFlags: ${context.synthesis.edge_case_flags.join(', ')}`
					: '')
			: 'Not yet available.';

		const system = SWIPE_PROMPT
			.replace('{intent}', context.intent)
			.replace('{evidence}', context.toEvidencePrompt())
			.replace('{oracle_synthesis}', synthStr)
			.replace('{draft_title}', context.draft.title || '(empty)')
			.replace('{draft_summary}', context.draft.summary || '(empty)')
			.replace('{current_draft_html}', context.draft.html || '(empty)')
			.replace('{accepted_patterns}', JSON.stringify(context.draft.acceptedPatterns))
			.replace('{rejected_patterns}', JSON.stringify(context.draft.rejectedPatterns))
			.replace('{anti_patterns}', antiStr)
			.replace('{facade_id}', facade.id)
			.replace('{decision}', record.decision)
			.replace('{hypothesis}', facade.hypothesis)
			.replace('{content_summary}', summarizeFacade(facade));

		const result = await generateText({
			model: MODEL,
			output: Output.object({ schema: DraftUpdateSchema }),
			temperature: 0,
			system,
			prompt: `Swipe #${context.swipeCount}: user ${record.decision}ed "${facade.label}". Update the draft.`
		});

		if (context.sessionId !== capturedId) {
			console.log('[builder] session changed during rebuild, discarding');
			return;
		}

		const output = result.output;
		if (!output) {
			console.error('[builder] no output from generateText');
			return;
		}

		// Merge
		context.draft.title = output.title;
		context.draft.summary = output.summary;
		context.draft.html = output.html;
		context.draft.nextHint = output.nextHint ?? undefined;

		// Accepted patterns — deduplicate
		const existingAccepted = new Set(context.draft.acceptedPatterns);
		for (const p of output.acceptedPatterns) {
			if (!existingAccepted.has(p)) context.draft.acceptedPatterns.push(p);
		}

		// Rejected patterns — to draft AND shared antiPatterns
		let addedAntiPatterns = false;
		const existingAnti = new Set(context.antiPatterns);
		const existingRejected = new Set(context.draft.rejectedPatterns);
		for (const p of output.rejectedPatterns) {
			if (!existingRejected.has(p)) context.draft.rejectedPatterns.push(p);
			if (!existingAnti.has(p)) {
				context.antiPatterns.push(p);
				addedAntiPatterns = true;
			}
		}

		// Probe briefs
		if (output.probeBriefs.length) {
			context.probes.push(...output.probeBriefs);
			debugLog('Builder', 'probes', {
				count: output.probeBriefs.length,
				briefs: output.probeBriefs.map((p) => p.brief)
			});
		}

		debugLog('Builder', 'rebuild', {
			swipe: context.swipeCount,
			title: output.title,
			accepted: output.acceptedPatterns,
			rejected: output.rejectedPatterns,
			hint: output.nextHint
		});

		// Events
		emitDraftUpdated({ draft: context.draft });

		if (output.nextHint) {
			emitBuilderHint({ hint: output.nextHint });
		}

		if (addedAntiPatterns) {
			emitEvidenceUpdated({
				evidence: [...context.evidence],
				antiPatterns: context.antiPatterns
			});
		}
	} catch (err) {
		console.error('[builder] rebuild failed:', err);
	} finally {
		setStatus('idle', 'watching for swipes');
		busy = false;
		drainPending();
	}
}

// ── Public API ───────────────────────────────────────────────────────

export function startBuilder(): void {
	if (cleanup.length > 0) {
		cleanup.forEach((fn) => fn());
		cleanup = [];
	}

	setStatus('idle', 'waiting for session');

	// Session-ready: generate initial scaffold
	cleanup.push(
		onSessionReady(async ({ intent }) => {
			lastRebuiltSwipe = -1;
			if (busy) pendingSwipe = null; // new session invalidates old pending
			busy = true;
			const capturedId = context.sessionId;
			setStatus('thinking', 'generating initial scaffold');

			try {
				const result = await generateText({
					model: MODEL,
					output: Output.object({ schema: DraftUpdateSchema }),
					temperature: 0,
					system: SCAFFOLD_PROMPT.replace('{intent}', intent),
					prompt: 'Generate the initial draft scaffold for this session.'
				});

				// Only merge if no swipe has beaten us AND session is still current
				if (context.swipeCount === 0 && context.sessionId === capturedId && result.output) {
					context.draft.title = result.output.title;
					context.draft.summary = result.output.summary;
					context.draft.html = result.output.html;
					emitDraftUpdated({ draft: context.draft });
				}
			} catch (err) {
				console.error('[builder] scaffold failed:', err);
			} finally {
				setStatus('idle', 'watching for swipes');
				busy = false;
				drainPending();
			}
		})
	);

	// Swipe-result: update draft
	cleanup.push(
		onSwipeResult(({ record }) => {
			const facade =
				context.facades.find((f) => f.id === record.facadeId) ??
				context.consumedFacades.find((f) => f.id === record.facadeId);

			if (!facade) {
				console.error('[builder] facade not found for', record.facadeId);
				return;
			}

			if (busy) {
				pendingSwipe = { facade, record, sessionId: context.sessionId };
				return;
			}

			rebuild(facade, record);
		})
	);

	console.log('[builder] started');
}
