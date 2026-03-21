# 06 — Builder Reactive Loop

**Status: DONE** — `src/lib/server/agents/builder.ts` (14a56a3)
Benchmark: `scripts/findings/p6-builder-hints.md` — 5/5 hint quality, 3/3 runs.

## Summary
The builder agent subscribes to swipe-result and session-ready events, maintains a living prototype draft via generateText. Evidence-based (Akinator pattern) — reads `context.toEvidencePrompt()`, not axis distributions. Emits construction-grounded probe briefs when blocked. Serialization gate ensures at most one LLM call in flight; fast swipes coalesce with guaranteed tail rerun.

## Design
Two triggers: session-ready (once) and swipe-result (ongoing).

### On session init (session-ready)
Builder receives `session-ready` with intent. Generates initial draft scaffold (title, summary, basic HTML). Merge-guarded: only applies if `swipeCount === 0` (a swipe-driven rebuild takes priority over a slow scaffold). Demo contract #5: "A prototype pane starts changing before the final reveal."

### On each swipe-result
Subscribes to `swipe-result` on the bus. On each event:
1. Look up facade from `context.facades` (still there at emit time) falling back to `context.consumedFacades`
2. If builder is busy (prior LLM call in flight), store as `pendingSwipe` (latest wins) and return
3. Call `rebuild(facade, record)`:
   - Build system prompt with evidence history (`context.toEvidencePrompt()`), full current draft HTML, anti-patterns, facade/swipe details
   - `generateText()` with `google('gemini-2.5-flash')`, temperature 0, DraftUpdateSchema
   - Session guard: check `context.sessionId === capturedId` before merging
   - Merge: update title/summary/html, deduplicate-merge accepted patterns, append rejected patterns to draft AND `context.antiPatterns`
   - Push probe briefs to `context.probes`
   - Emit `draft-updated`, `builder-hint` (if nextHint set), `evidence-updated` (only if new anti-patterns added)
   - `finally`: set idle, clear busy, drain `pendingSwipe` (tail rerun if pending)

### Serialization gate
- `busy` flag + `pendingSwipe: { facade, record, sessionId }` snapshot
- At most one `generateText` in flight at a time (scaffold and rebuild both gated)
- Fast swipes coalesce — latest wins, tail rerun catches up
- `pendingSwipe` versioned with `sessionId` — cross-session pending discarded

Temperature: 0 (deterministic analysis). Builder reads evidence and builds, not generating creative content.

Output schema: DraftUpdate via Output.object() with z.object():
- title: z.string()
- summary: z.string()
- html: z.string()
- acceptedPatterns: z.array(z.string()) — DELTAS, not cumulative
- rejectedPatterns: z.array(z.string()) — DELTAS, not cumulative
- probeBriefs: z.array(z.object({ source: z.literal('builder'), priority: z.enum(['high', 'normal']), brief: z.string(), context: z.string(), heldConstant: z.array(z.string()) }))
- nextHint: z.string().nullable()

No z.union() — flat for Gemini compatibility.

## Scope
### Files
- src/lib/server/agents/builder.ts (~190 LOC)
- src/hooks.server.ts (added startBuilder() call)

### Acceptance criteria
- [x] On session-ready, builder generates an initial draft from intent
- [x] Prototype pane shows content before the first swipe (scaffold merge guard: swipeCount === 0)
- [x] After a swipe event, builder generateText call fires (or coalesces if busy)
- [x] context.draft.html updates after each builder call
- [x] context.draft.rejectedPatterns grows when facades are rejected (delta merge + shared antiPatterns)
- [x] context.draft.nextHint populated when builder identifies construction ambiguity
- [x] Probe briefs appear in context.probes when builder is blocked
- [x] 'builder-hint' event fires on bus when nextHint is set
- [x] 'evidence-updated' event fires when new anti-patterns added (not on every swipe — avoids duplicate with addEvidence)
- [x] generateText failure logs error but does not unsubscribe builder
- [x] Session guard prevents stale async merges across sessions
- [x] Serialization gate prevents concurrent LLM calls with coalesce + tail rerun

### Dependencies
03-context (EyeLoopContext singleton, toEvidencePrompt(), draft, probes, sessionId, event bus), 04-endpoints (swipe POST that emits swipe-result on bus).
