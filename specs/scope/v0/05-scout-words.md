# 05 — Scout Core Loop (Evidence-Based)

## Summary
The critical first agent loop. A roster of 3 named scouts (Iris, Prism, Lumen) run concurrent async while loops. Each scout reads evidence via `context.toEvidencePrompt()`, oracle `TasteSynthesis` (emergent axes + axis assignment + edge case flags), and queue contents for de-duplication. Identifies taste gaps via LLM, generates a facade, pushes it into the queue, waits for a swipe result, updates local history, and repeats. `src/lib/server/agents/scout.ts`.

## Design
Manual async while loop per scout (NOT stopWhen). Scouts are event-driven — the swipe callback is external, so the loop must yield between iterations. Each iteration:
1. Check queue pressure — if `context.queuePressure === 'full'`, sleep and retry
2. Read full evidence via `context.toEvidencePrompt()` (accept/reject history with latency signals)
3. Read oracle synthesis via `context.synthesis` (emergent axes, edge case flags, persona-anima divergence)
4. Read scout assignment from `context.synthesis?.scout_assignments` — find this scout's axis assignment
5. Read queue contents from `context.facades` — inject pending probes for de-duplication
6. Check concreteness floor via `getFormatInstruction(context.evidence.length)` — determines whether to generate word, image, or mockup
7. Peek next probe brief from `context.peekNextProbe()` (builder-assigned, if any)
8. Inject anti-patterns from `context.antiPatterns` as hard constraints
7. Call `generateText()` with `google('gemini-3.1-flash-lite-preview')` + `Output.object()` + `ScoutOutputSchema`
8. Push facade to `context.pushFacade(facade)` (handles queue + bus emission)
9. Wait for swipe via `awaitFacadeSwipe(facade.id, 30_000, signal)` — returns outcome or timeout/abort
10. Update local history (last 8 entries), consume probe if one was assigned, loop

Temperature: 1.0 (creative generation — do not lower).

Structured output schema: `ScoutOutputSchema` via `Output.object()` with `z.object()`:
- `label`: z.string()
- `hypothesis`: z.string()
- `format`: z.enum(['word', 'image', 'mockup'])
- `content`: z.string()
- `accept_implies`: z.string()
- `reject_implies`: z.string()

No z.union() — Gemini uses OpenAPI 3.0 subset and does not support it.

Scout roster (3 concurrent scouts):
- `scout-01` "Iris"
- `scout-02` "Prism"
- `scout-03` "Lumen"

## Scope
### Files
- src/lib/server/agents/scout.ts (~290 LOC)

### Subtasks

## Scout loop skeleton
`while(alive())` loop where `alive()` checks `!signal.aborted && context.sessionId === capturedSessionId && context.stage !== 'reveal'`. Each scout gets its own `AbortController`. On queue full (`context.queuePressure === 'full'`), set status to `'queued'` and sleep 2s. Wrap body in try/catch so a single failure does not kill the loop. On loop exit, set agent status to `'idle'`.

## Gemini integration
Import `generateText` from `'ai'`, `createGoogleGenerativeAI` from `'@ai-sdk/google'`, `Output` from `'ai'`, `z` from `'zod'`. Build system prompt via template string replacement:
- `{INTENT}` — `context.intent`
- `{EVIDENCE}` — `context.toEvidencePrompt()` (full evidence history with accept/reject/latency)
- `{EMERGENT_AXES}` — oracle's emergent axes summary (label, poles, confidence, leaning) or "Not yet available" if < 4 swipes
- `{EDGE_CASE_FLAGS}` — from `context.synthesis?.edge_case_flags` (e.g., "user accepts everything", "axis X contradictory")
- `{PERSONA_ANIMA_DIVERGENCE}` — from `context.synthesis?.persona_anima_divergence`
- `{SCOUT_ASSIGNMENT}` — this scout's axis assignment from `context.synthesis?.scout_assignments` (e.g., "Probe interaction modality because...")
- `{QUEUED_PROBES}` — current queue contents from `context.facades` for de-duplication ("These probes are already pending: [list]")
- `{ANTI_PATTERNS}` — `context.antiPatterns` as hard constraints
- `{PROBE_BRIEF}` — from `context.peekNextProbe()` or "None — self-assign from most uncertain gap"
- `{FORMAT_INSTRUCTION}` — concreteness floor based on evidence count (< 4: word, 4-7: image, 8+: mockup)

Call `generateText({ model: google('gemini-3.1-flash-lite-preview'), output: Output.object({ schema: ScoutOutputSchema }), temperature: 1.0, system, prompt, abortSignal: signal })`. Construct Facade object: `{ id: crypto.randomUUID(), agentId, hypothesis: output.hypothesis, label: output.label, content: output.content, format: output.format }`.

## Local history tracking
Maintain an array of the last 8 facade+result entries per scout, newest first. Each entry: `{ label, hypothesis, decision, latency_signal, lesson }`. The lesson field is extracted from `accept_implies` or `reject_implies` depending on decision. Serialized as numbered text lines for the evidence prompt. Recent hypotheses (last 3) are injected as a diversity guard to prevent re-probing the same territory.

## Timeout and cleanup
Swipe await uses `awaitFacadeSwipe(facade.id, SWIPE_TIMEOUT_MS, signal)` which returns `'timeout' | 'aborted' | 'stale' | { decision, latencyBucket }`. If timeout: remove stale facade from `context.facades`, emit `facade-stale` on bus, continue loop. If aborted: break loop. If stale: continue. On outcome: consume probe if one was assigned, update local history. Each scout tracks its own `AbortController` in a `Map<string, () => void>`. Exports: `startScout()`, `startAllScouts()`, `stopScout()`, `stopAllScouts()`.

### Acceptance criteria
- [ ] Scout reads evidence via `context.toEvidencePrompt()`, NOT axis confidence
- [ ] Scout reads oracle synthesis (emergent axes, edge case flags, scout assignments) when available
- [ ] Scout reads its axis assignment from `context.synthesis?.scout_assignments`
- [ ] Scout reads queue contents from `context.facades` and injects them into prompt for de-duplication
- [ ] Scout identifies gaps via LLM prompt, NOT via `getMostUncertainAxis()`
- [ ] Concreteness floor escalates: word (< 4 evidence), image (4-7), mockup (8+)
- [ ] Each facade appears in `context.facades` queue after generation
- [ ] Scout blocks (does not generate next facade) until a swipe arrives for the current facade
- [ ] After swipe, scout resumes with updated evidence and synthesis
- [ ] Local history tracks the last 8 entries with label, hypothesis, decision, and lesson
- [ ] If no swipe arrives within 30s, the stale facade is removed and the scout continues
- [ ] A single `generateText` failure does not crash the loop
- [ ] Scout loop terminates cleanly when stage transitions to `'reveal'` or signal is aborted
- [ ] 3 concurrent scouts run from `startAllScouts()`
- [ ] Anti-patterns are injected as hard constraints (never re-propose rejected patterns)
- [ ] Diversity guard prevents re-probing same territory (last 3 hypotheses)

### Dependencies
03-context (`context` singleton, `toEvidencePrompt()`, `evidence`, `facades`, `synthesis` (emergent axes TasteSynthesis), `antiPatterns`, `probes`, `pushFacade()`, bus), 04-endpoints (swipe POST that records evidence and emits swipe result on bus).
