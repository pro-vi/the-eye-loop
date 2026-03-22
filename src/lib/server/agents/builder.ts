import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { GEMINI_API_KEY } from '$env/static/private';
import { context } from '$lib/server/context';
import {
	onSessionReady,
	onSwipeResult,
	onStageChanged,
	emitDraftUpdated,
	emitBuilderHint,
	emitEvidenceUpdated,
	emitAgentStatus
} from '$lib/server/bus';
import type { AgentState, Facade, SwipeRecord } from '$lib/context/types';
import { debugLog } from '$lib/server/debug-log';
import { HTML_QUALITY_RULES } from '$lib/server/prompts';

// ── Constants ────────────────────────────────────────────────────────

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
const MODEL = google('gemini-3.1-flash-lite-preview');
const REVEAL_MODEL = google('gemini-3.1-pro-preview');
const BUILDER_ID = 'builder-01';
const BUILDER_NAME = 'Meridian';

// ── Zod schema (flat — no z.union for Gemini compat) ─────────────────

const DraftUpdateSchema = z.object({
	title: z.string(),
	summary: z.string(),
	html: z.string(),
	changeNote: z.string(),  // 1-line: what you changed and why (for your own memory next rebuild)
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

// ── Builder memory ──────────────────────────────────────────────────

interface BuilderNote {
	swipe: number;
	decision: 'accept' | 'reject';
	label: string;
	change: string;
}

const MAX_NOTES = 8;
let builderNotes: BuilderNote[] = [];

// ── Prompts ──────────────────────────────────────────────────────────

const SCAFFOLD_PROMPT = `You are the Builder agent in The Eye Loop.

The user just started a session. Generate an initial draft prototype scaffold.
This is the FIRST draft — a plausible starting point that evolves as the user swipes.

USER INTENT: "{intent}"

${HTML_QUALITY_RULES}

OUTPUT:
- title: a working title for the prototype
- summary: 1-2 sentence description
- html: basic HTML+CSS scaffold (mobile 375x667, inline styles, no scripts).
  Start with a CSS variable palette, then build 2-3 placeholder sections.
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

YOUR RECENT CHANGES (preserve these — don't undo your own work):
{builder_notes}

RULES:
- Ground everything in the evidence
- Anti-patterns (rejected things) are HARD CONSTRAINTS
- Reference specific accepted/rejected items as justification

HTML UPDATE RULES (CRITICAL — read carefully):
- You MUST start from the CURRENT DRAFT HTML above
- Make the SMALLEST possible change that reflects the last swipe
- If accept: integrate ONE new element or style change from the accepted facade
- If reject: adjust or remove ONE element that matches the rejected pattern
- PRESERVE everything else: colors, layout, typography, sections, content
- The output html must be 90%+ identical to the input. This is a PATCH, not a rewrite.
- If the current draft is empty, generate a fresh scaffold from evidence.

PROBE BRIEFS:
- Only output a probe brief if you are GENUINELY STUCK on a specific component
- "What color should the header be?" is NOT stuck — extrapolate from evidence
- "Need to know: sidebar nav vs bottom tabs — both could work given the evidence" IS stuck
- If you can build without asking, output an EMPTY probeBriefs array

${HTML_QUALITY_RULES}

OUTPUT: updated title, summary, html, pattern deltas, probe briefs, nextHint`;

// ── Helpers ──────────────────────────────────────────────────────────

function summarizeFacade(facade: Facade): string {
	if (facade.format === 'word') return facade.label;
	if (facade.format === 'image') return facade.content.slice(0, 300);
	// For mockups, include the actual HTML so the builder can see what was accepted/rejected
	return facade.content.slice(0, 1500);
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

// ── Serialization gate (HMR-safe via globalThis) ────────────────────

const G = globalThis as Record<string, unknown>;
let busy = false;
let pendingSwipe: { facade: Facade; record: SwipeRecord; sessionId: string } | null = null;
let cleanup: Array<() => void> = (G.__builderCleanup as Array<() => void>) ?? [];
G.__builderCleanup = cleanup;

// Tracks which swipes we've already rebuilt — survives HMR
const rebuiltSwipes = (G.__builderRebuiltSwipes as Set<string>) ?? new Set<string>();
G.__builderRebuiltSwipes = rebuiltSwipes;

function drainPending() {
	if (context.stage === 'reveal') {
		pendingSwipe = null;
		return;
	}
	if (pendingSwipe && pendingSwipe.sessionId === context.sessionId) {
		const p = pendingSwipe;
		pendingSwipe = null;
		rebuild(p.facade, p.record);
	} else {
		pendingSwipe = null;
	}
}

// ── Rebuild (one LLM call per invocation) ────────────────────────────

async function rebuild(facade: Facade, record: SwipeRecord) {
	// Dedup: HMR registers duplicate listeners — use facadeId as unique key
	const dedup = `${context.sessionId}:${record.facadeId}`;
	if (rebuiltSwipes.has(dedup)) return;
	rebuiltSwipes.add(dedup);

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

		const notesStr = builderNotes.length
			? builderNotes.map((n, i) => `${i + 1}. Swipe ${n.swipe} (${n.decision} "${n.label}"): ${n.change}`).join('\n')
			: '(first rebuild — no prior changes)';

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
			.replace('{builder_notes}', notesStr)
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

		// Don't overwrite draft after reveal — keep the last good version
		if (context.stage === 'reveal') {
			console.log('[builder] reveal active, preserving draft');
			return;
		}

		const output = result.output;
		if (!output) {
			console.error('[builder] no output from generateText');
			return;
		}

		// Record builder note (before merge — capture what changed)
		builderNotes.unshift({
			swipe: context.swipeCount,
			decision: record.decision,
			label: facade.label,
			change: output.changeNote || `${record.decision}ed "${facade.label}"`
		});
		if (builderNotes.length > MAX_NOTES) builderNotes.pop();

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

		// Probe briefs — only emit if genuinely blocked AND queue isn't already full of briefs
		const realBriefs = output.probeBriefs.filter((p) => p.brief.length > 20);
		if (realBriefs.length > 0 && context.probes.length < 3) {
			// Max 1 brief per rebuild to avoid flooding
			const brief = realBriefs[0];
			context.probes.push(brief);
			debugLog('Builder', 'probes', {
				count: 1,
				briefs: [brief.brief]
			});
		}

		debugLog('Builder', 'rebuild', {
			swipe: context.swipeCount,
			decision: record.decision,
			label: facade.label,
			title: output.title,
			htmlLength: output.html.length,
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
			rebuiltSwipes.clear();
			builderNotes = [];
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
			// Freeze draft at reveal — don't overwrite the good one
			if (context.stage === 'reveal') {
				pendingSwipe = null;
				return;
			}

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

	// NOTE: reveal build is triggered by oracle via buildRevealDraft(), not by stage-changed event.
	// This ensures the final draft is ready BEFORE the client sees the reveal page.

	console.log('[builder] started');
}

// ── Reveal build (called by oracle BEFORE emitting stage-changed) ────

export async function buildRevealDraft(): Promise<void> {
	const capturedId = context.sessionId;
	setStatus('thinking', 'final prototype synthesis');

	try {
		const antiStr = context.antiPatterns.length
			? context.antiPatterns.map((p) => `  - ${p}`).join('\n')
			: '  (none)';

		const synthStr = context.synthesis
			? context.synthesis.axes
					.map((a) => `  ${a.label}: ${a.poleA} ↔ ${a.poleB} [${a.confidence}${a.leaning_toward ? ` → ${a.leaning_toward}` : ''}]`)
					.join('\n')
			: 'Not available.';

		const notesStr = builderNotes.length
			? builderNotes.map((n, i) => `${i + 1}. Swipe ${n.swipe} (${n.decision} "${n.label}"): ${n.change}`).join('\n')
			: '(none)';

		// Collect accepted mockup HTML as reference material
		const acceptedMockups = context.consumedFacades
			.filter((f) => f.format === 'mockup')
			.filter((f) => context.evidence.some((e) => e.facadeId === f.id && e.decision === 'accept'))
			.map((f) => f.content)
			.slice(-3); // last 3 accepted mockups

		const mockupRefStr = acceptedMockups.length
			? 'ACCEPTED MOCKUP REFERENCES (the user liked these — incorporate their patterns):\n\n' +
				acceptedMockups.map((html, i) => `--- Accepted Mockup ${i + 1} ---\n${html.slice(0, 1500)}`).join('\n\n')
			: '';

		const finalPrompt = `You are the builder agent. The session is COMPLETE. Generate the FINAL prototype.

The user wanted to build: "${context.intent}"

FULL EVIDENCE:
${context.toEvidencePrompt()}

EMERGENT AXES:
${synthStr}

ANTI-PATTERNS (NEVER violate):
${antiStr}

YOUR BUILD HISTORY:
${notesStr}

CURRENT DRAFT HTML (your incremental work so far):
${context.draft.html}

${mockupRefStr}

TASK: This is the REVEAL — the moment the user sees what grew from their choices.
Take EVERYTHING you've learned and produce a POLISHED, COMPLETE prototype.

QUALITY BAR:
- This is the ONE artifact the user takes away. Make it beautiful.
- Derive a consistent design system: pick a seed color from evidence, generate
  a full palette (bg, card, accent, text, muted), consistent typography scale,
  consistent spacing and border-radius. Apply systematically.
- If accepted mockups are provided above, incorporate their specific UI patterns
  (card layouts, component styles, navigation patterns) into the final design.
- This is NOT an incremental patch — it's a full synthesis
- Keep design decisions from your build history — don't undo good work
- Include real content: real numbers ($2,450.80), real labels, real text
- Make every section feel intentional — no generic placeholder sections
- The HTML should be rich enough to fill a full mobile screen (aim for 4000+ chars)

${HTML_QUALITY_RULES}

OUTPUT: final title, summary, html (complete, polished, rich), changeNote, patterns, probeBriefs = [], nextHint = null`;

		const result = await generateText({
			model: REVEAL_MODEL,
			output: Output.object({ schema: DraftUpdateSchema }),
			temperature: 0,
			system: finalPrompt,
			prompt: 'Generate the final reveal prototype. Make it beautiful.',
			maxOutputTokens: 16000
		});

		if (context.sessionId !== capturedId || !result.output) return;

		context.draft.title = result.output.title;
		context.draft.summary = result.output.summary;
		context.draft.html = result.output.html;
		context.draft.nextHint = undefined;
		emitDraftUpdated({ draft: context.draft });

		debugLog('Builder', 'reveal-build', {
			title: result.output.title,
			htmlLength: result.output.html.length
		});

		console.log(`[builder] final reveal: "${result.output.title}" (${result.output.html.length} chars)`);
	} catch (err) {
		console.error('[builder] final reveal build failed:', err);
	} finally {
		setStatus('idle', 'reveal complete');
	}
}
