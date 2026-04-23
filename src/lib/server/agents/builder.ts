import { generateText, Output } from 'ai';
import { z } from 'zod';
import { context } from '$lib/server/context';
import {
	onSessionReady,
	onSwipeResult,
	onStageChanged,
	emitDraftUpdated,
	emitBuilderHint,
	emitEvidenceUpdated,
	emitAgentStatus,
	emitError,
	classifyErrorCode
} from '$lib/server/bus';
import type { AgentState, Facade, SwipeRecord } from '$lib/context/types';
import { debugLog } from '$lib/server/debug-log';
import { HTML_QUALITY_RULES } from '$lib/server/prompts';
import { FAST_MODEL, QUALITY_MODEL } from '$lib/server/ai';

// ── Constants ────────────────────────────────────────────────────────
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

DESIGN PALETTE (derived from evidence by Oracle — USE THESE EXACT VALUES):
{palette}

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

	// Parallel to iter-24's builder.scaffold flag-and-branch: preserve the
	// diagnostic focus on provider_auth_failure so the finally-block doesn't
	// overwrite 'provider auth failed' with the generic 'watching for swipes'.
	// Only matters post-healthy-auth (rebuild fires on every swipe, unreachable
	// under broken auth because no facade arrives).
	let authFailed = false;
	// iter-46: cross-session staleness flag. The existing success-path guard at
	// line ~252 returns early but finally still runs setStatus, overwriting the
	// NEW session's builder focus with this stale run's state. Parallel family
	// to iter-19 palette reset, iter-21 bus dedup clear, iter-42 conditional
	// stage-changed, and iter-45 runColdStart catch guard — all close cross-
	// session state leaks that arise when an async handler races a seedSession.
	// Also guards the catch block's emitError so a stale rejection doesn't
	// pollute the new session's bus.lastError (iter-26 replay source).
	let stale = false;
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

		const paletteStr = context.palette || 'Not yet derived — use warm defaults: --bg: #FFF8F0; --card: #FFF; --accent: #FF8C69; --text: #4A3E38; --muted: #A1887F; --radius: 16px;';

		const system = SWIPE_PROMPT
			.replace('{intent}', context.intent)
			.replace('{evidence}', context.toEvidencePrompt())
			.replace('{oracle_synthesis}', synthStr)
			.replace('{palette}', paletteStr)
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
			model: FAST_MODEL,
			output: Output.object({ schema: DraftUpdateSchema }),
			temperature: 0,
			system,
			prompt: `Swipe #${context.swipeCount}: user ${record.decision}ed "${facade.label}". Update the draft.`
		});

		if (context.sessionId !== capturedId) {
			stale = true;
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
		// iter-46 staleness guard, symmetric to the success-path check above and
		// parallel to iter-45's runColdStart catch. Under fire-and-forget rebuild
		// timing a stale rejection would otherwise emitError (polluting the new
		// session's bus.lastError) and fall through to finally's setStatus
		// (overwriting the new session's builder focus).
		if (context.sessionId !== capturedId) {
			stale = true;
			debugLog('Builder', 'rebuild-stale-error', {
				captured: capturedId,
				current: context.sessionId,
				err: String(err)
			});
			return;
		}
		console.error('[builder] rebuild failed:', err);
		const code = classifyErrorCode(err);
		if (code === 'provider_auth_failure') authFailed = true;
		emitError({
			source: 'builder',
			code,
			agentId: BUILDER_ID,
			message: err instanceof Error ? err.message : String(err)
		});
	} finally {
		// iter-46: skip the setStatus write when the run was stale — the new
		// session owns builder-01's agent state now, and this run's 'watching'
		// or 'provider auth failed' would overwrite it. busy + drainPending
		// still run because the module-level busy gate must be released for the
		// new session's rebuild queue to drain (drainPending's own sessionId
		// check at line ~176 already keeps it safe for session-scoped pending).
		if (!stale) {
			setStatus('idle', authFailed ? 'provider auth failed' : 'watching for swipes');
		}
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
			let authFailed = false;
			// iter-48: cross-session staleness flag, parallel family to iter-45
			// runColdStart catch, iter-46 rebuild catch+finally, iter-47
			// runSynthesis catch. Under fire-and-forget scaffold + slow
			// generateText + tight multi-session timing, session N's rejection
			// (or success) must not call emitError on N+1's bus.lastError nor
			// overwrite N+1's builder-01 focus via the finally's setStatus.
			let stale = false;

			try {
				const result = await generateText({
					model: FAST_MODEL,
					output: Output.object({ schema: DraftUpdateSchema }),
					temperature: 0,
					system: SCAFFOLD_PROMPT.replace('{intent}', intent),
					prompt: 'Generate the initial draft scaffold for this session.'
				});

				// iter-48: staleness check first — parallel to iter-46 rebuild
				// success-path. A stale run must skip both the merge AND the
				// finally's setStatus (the latter would clobber N+1's builder
				// focus, which the new session's own onSessionReady just set to
				// 'generating initial scaffold').
				if (context.sessionId !== capturedId) {
					stale = true;
					return;
				}

				// Only merge if no swipe has beaten us
				if (context.swipeCount === 0 && result.output) {
					context.draft.title = result.output.title;
					context.draft.summary = result.output.summary;
					context.draft.html = result.output.html;
					emitDraftUpdated({ draft: context.draft });
				}
			} catch (err) {
				// iter-48 staleness guard, symmetric to the success-path check
				// above and parallel to iter-45 runColdStart catch / iter-46
				// rebuild catch / iter-47 runSynthesis catch. A stale rejection
				// would otherwise emitError (polluting N+1's bus.lastError,
				// iter-26 replay source) and fall through to finally's setStatus
				// (overwriting N+1's builder-01 focus).
				if (context.sessionId !== capturedId) {
					stale = true;
					debugLog('Builder', 'scaffold-stale-error', {
						captured: capturedId,
						current: context.sessionId,
						err: String(err)
					});
					return;
				}
				console.error('[builder] scaffold failed:', err);
				const code = classifyErrorCode(err);
				if (code === 'provider_auth_failure') authFailed = true;
				emitError({
					source: 'builder',
					code,
					agentId: BUILDER_ID,
					message: err instanceof Error ? err.message : String(err)
				});
			} finally {
				// iter-48: skip the setStatus write when the run was stale — the
				// new session owns builder-01's agent state now. busy +
				// drainPending still run because the module-level busy gate must
				// be released for the new session's rebuild queue to drain
				// (drainPending's own sessionId check at line ~176 already keeps
				// it safe for session-scoped pending, iter-46 rationale).
				// Parallel to iter-23's scout.ts auth-break path on the non-stale
				// path: preserve the diagnostic focus on auth failure so the
				// operator-facing final agent-status isn't overwritten with the
				// generic 'watching'.
				if (!stale) {
					setStatus('idle', authFailed ? 'provider auth failed' : 'watching for swipes');
				}
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

	// Parallel to iter-24's builder.scaffold flag-and-branch: preserve the
	// diagnostic focus on provider_auth_failure so the finally-block doesn't
	// overwrite 'provider auth failed' with the generic 'reveal complete'.
	// Only matters post-healthy-auth (buildRevealDraft fires once at stage=
	// reveal, unreachable under broken auth because no swipes reach the
	// REVEAL_THRESHOLD=15 evidence count).
	let authFailed = false;
	// iter-49: cross-session staleness flag, parallel family to iter-45
	// runColdStart catch, iter-46 rebuild catch+finally, iter-47 runSynthesis
	// catch, and iter-48 scaffold catch+finally. buildRevealDraft is invoked
	// fire-and-forget via oracle.ts:432's buildRevealDraft().finally(...) so
	// under tight multi-session timing (reveal-triggered slow QUALITY_MODEL
	// generateText + mid-run new session) a stale rejection or success would
	// otherwise emitError (polluting N+1's bus.lastError, iter-26 replay
	// source) or setStatus via finally (overwriting N+1's builder-01 focus
	// that the new session's onSessionReady just set to 'generating initial
	// scaffold'). Two-site treatment (catch + finally) matches rebuild/scaffold
	// topology; runSynthesis/runColdStart asymmetries don't apply here since
	// buildRevealDraft's finally has no pre-existing gate like synthesisRunId.
	let stale = false;
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

		const finalPrompt = `You are the builder agent. The session is COMPLETE. Generate the FINAL prototype.

The user wanted to build: "${context.intent}"

FULL EVIDENCE:
${context.toEvidencePrompt()}

EMERGENT AXES:
${synthStr}

DESIGN PALETTE (derived from evidence — USE THESE EXACT CSS VARIABLES):
${context.palette || ':root { --bg: #FFF8F0; --card: #FFF; --accent: #FF8C69; --text: #4A3E38; --muted: #A1887F; --radius: 16px; }'}

ANTI-PATTERNS (NEVER violate):
${antiStr}

YOUR BUILD HISTORY:
${notesStr}

CURRENT DRAFT HTML (your incremental work so far):
${context.draft.html}

TASK: This is the REVEAL — the moment the user sees what grew from their choices.
Take EVERYTHING you've learned and produce a POLISHED, COMPLETE prototype.

QUALITY BAR:
- This is the ONE artifact the user takes away. Make it beautiful.
- USE THE DESIGN PALETTE ABOVE — start your HTML with a <style> block containing
  those exact CSS variables, then reference var(--bg), var(--accent) etc throughout.
- Consistent typography scale, spacing, and border-radius from the palette.
- This is NOT an incremental patch — it's a full synthesis
- Keep design decisions from your build history — don't undo good work
- Include real content: real numbers ($2,450.80), real labels, real text
- Make every section feel intentional — no generic placeholder sections
- The HTML should be rich enough to fill a full mobile screen (aim for 4000+ chars)

${HTML_QUALITY_RULES}

OUTPUT: final title, summary, html (complete, polished, rich), changeNote, patterns, probeBriefs = [], nextHint = null`;

		const result = await generateText({
			model: QUALITY_MODEL,
			output: Output.object({ schema: DraftUpdateSchema }),
			temperature: 0,
			system: finalPrompt,
			prompt: 'Generate the final reveal prototype. Make it beautiful.',
			maxOutputTokens: 16000
		});

		// iter-49: staleness check first — parallel to iter-46 rebuild success
		// path. A stale run must skip both the merge AND the finally's setStatus
		// (the latter would clobber N+1's builder focus, which the new session's
		// onSessionReady just set to 'generating initial scaffold').
		if (context.sessionId !== capturedId) {
			stale = true;
			return;
		}
		if (!result.output) return;

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
		// iter-49 staleness guard, symmetric to the success-path check above
		// and parallel to iter-45 runColdStart catch / iter-46 rebuild catch /
		// iter-47 runSynthesis catch / iter-48 scaffold catch. A stale
		// rejection would otherwise emitError (polluting N+1's bus.lastError)
		// and fall through to finally's setStatus (overwriting N+1's builder
		// focus).
		if (context.sessionId !== capturedId) {
			stale = true;
			debugLog('Builder', 'reveal-stale-error', {
				captured: capturedId,
				current: context.sessionId,
				err: String(err)
			});
			return;
		}
		console.error('[builder] final reveal build failed:', err);
		const code = classifyErrorCode(err);
		if (code === 'provider_auth_failure') authFailed = true;
		emitError({
			source: 'builder',
			code,
			agentId: BUILDER_ID,
			message: err instanceof Error ? err.message : String(err)
		});
	} finally {
		// iter-49: skip the setStatus write when the run was stale — the new
		// session owns builder-01's agent state now, and this run's 'reveal
		// complete' or 'provider auth failed' would overwrite it. Parallel to
		// iter-46 rebuild / iter-48 scaffold finally gating.
		if (!stale) {
			setStatus('idle', authFailed ? 'provider auth failed' : 'reveal complete');
		}
	}
}
