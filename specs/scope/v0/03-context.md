# 03 — EyeLoopContext + Event Bus + Evidence Prompt Serializer

## Summary
Build the server-side state singleton, typed event bus, and evidence prompt serializer. These three pieces form the shared backbone that every agent loop, endpoint, and SSE stream depends on. Context is the single mutable state surface; the bus is how mutations propagate; the evidence prompt serializer is how accumulated swipe evidence reaches LLM prompts.

## Design
`EyeLoopContext` is a module-level singleton in `src/lib/server/context.ts` — Vercel Fluid Compute keeps the instance alive across requests for the duration of the session. The event bus wraps Node.js `EventEmitter` with typed helpers derived from `SSEEventMap` so listeners never receive untyped payloads. The evidence prompt serializer converts the flat evidence list into a numbered accept/reject list with latency signals for LLM consumption.

Evidence-based model: no `TasteAxis`, no coded confidence scores, no axis IDs. Oracle discovers emergent axes from evidence and stores them in `TasteSynthesis` (axes, edge case flags, scout assignments, persona-anima divergence). Scouts read `context.synthesis?.axes` + `context.synthesis?.scout_assignments` for coordination, not code-side `getMostUncertainAxis()`.

## Scope
### Files
- src/lib/server/context.ts (~160 LOC)
- src/lib/server/bus.ts (~155 LOC)

### Subtasks

## EyeLoopContext singleton
Module-level singleton exported from `src/lib/server/context.ts`. Imports types from `src/lib/context/types.ts`.

State fields:
- `intent: string`
- `sessionId: string` (invalidation token, not a routing boundary)
- `swipeCount: number`
- `stage: Stage`
- `evidence: SwipeEvidence[]`
- `synthesis: TasteSynthesis | null` (emergent axes, edge case flags, scout assignments, persona-anima divergence — updated by oracle every 4 swipes)
- `facades: Facade[]` (ordered queue, head = next to show)
- `consumedFacades: Facade[]` (already swiped, kept for history/evidence lookup)
- `probes: ProbeBrief[]`
- `agents: Map<string, AgentState>`
- `draft: PrototypeDraft`
- `antiPatterns: string[]`
- `swipeLatencies: number[]` (for computing session median)

Methods:
- `addEvidence(record: SwipeRecord)` — increment swipeCount, compute latencyBucket (fast if below current session median, else slow), look up facade from `facades` or `consumedFacades`, build `SwipeEvidence` entry with content/hypothesis/decision/latencySignal, push to `evidence[]`, emit `swipe-result` and `evidence-updated` on bus. Does NOT advance stage — stage advancement is owned exclusively by the oracle (07-oracle).
- `pushFacade(facade: Facade)` — append to queue, emit `facade-ready` on bus
- `markFacadeConsumed(facadeId: string)` — move facade from queue to consumedFacades
- `getNextProbe(): ProbeBrief | undefined` — pop highest-priority probe (high first, then FIFO)
- `peekNextProbe(): ProbeBrief | undefined` — peek without consuming
- `consumeProbe(probe: ProbeBrief)` — remove specific probe from queue
- `reset()` — clear all state for new session
- `toEvidencePrompt(): string` — serialize evidence for LLM prompts (see subtask below)

Getters:
- `sessionMedianLatency` — median of swipeLatencies array (returns 0 if empty)
- `queuePressure` — `'hungry' | 'healthy' | 'full'` based on facades.length vs QUEUE_MIN (3) / QUEUE_MAX (5)
- `concretenessFloor` — `'word' | 'image' | 'mockup'` based on evidence count thresholds (<4 = word, <8 = image, else mockup)

## Event bus
Node.js `EventEmitter` wrapper in `src/lib/server/bus.ts`. Single module-level instance with `maxListeners` set to 50.

Generic typed `emit<K>` and `on<K>` functions derived from `SSEEventMap` — all event helpers are type-safe against the SSEEvent union in 02-types.

Emit helpers (one per SSE event type):
- `emitFacadeReady({ facade })`
- `emitFacadeStale({ facadeId })`
- `emitSwipeResult({ record })` — also emits `swipe:${facadeId}` for scout blocking pattern
- `emitEvidenceUpdated({ evidence, antiPatterns })`
- `emitAgentStatus({ agent })`
- `emitBuilderHint({ hint })`
- `emitStageChanged({ stage, swipeCount })`
- `emitDraftUpdated({ draft })`
- `emitSynthesisUpdated({ synthesis })`
- `emitSessionReady({ intent })`

Listen helpers (one per SSE event type):
- `onFacadeReady(cb)`, `onFacadeStale(cb)`, `onSwipeResult(cb)`, `onEvidenceUpdated(cb)`, etc.
- Each returns an unsubscribe function `() => void`

Scout blocking patterns:
- `onceFacadeSwipe(facadeId): Promise<SwipeRecord>` — resolves when `swipe:${facadeId}` fires
- `awaitFacadeSwipe(facadeId, timeoutMs, signal?): Promise<SwipeRecord | 'timeout' | 'aborted' | 'stale'>` — resolves on swipe, timeout, abort, or facade-stale event; cleans up all listeners on settlement

SSE forwarding:
- `onAny(cb)` — subscribes to all SSE event types, calls `cb(eventType, payload)` for each; returns unsubscribe function

## Evidence prompt serializer
Method `toEvidencePrompt()` on EyeLoopContext. Converts the flat evidence list into a numbered list of accept/reject decisions with latency signals, suitable for inclusion in LLM prompts.

Output format:
```
1. [ACCEPT] "minimalist grid layout"
   Hypothesis: user prefers structured layouts

2. [REJECT (hesitant)] "bold serif typography"
   Hypothesis: user prefers serif fonts
```

Rules:
- Returns `'No evidence yet.'` when evidence is empty
- Each entry is numbered sequentially
- Tag is `[ACCEPT]` or `[REJECT]` based on decision
- Slow latency appends ` (hesitant)` to the tag
- Content is quoted, hypothesis on next line indented
- No YAML library — uses string concatenation via `.map().join()`

### Acceptance criteria
- [ ] `import { context } from '$lib/server/context'` resolves in any server-side file
- [ ] Context has no `axes` field, no `seedAxes()` method, no `getMostUncertainAxis()` method
- [ ] Context has no `toAnimaYAML()` method
- [ ] `context.evidence` is a `SwipeEvidence[]` array
- [ ] `context.synthesis` holds `TasteSynthesis | null` (emergent axes format: axes, edge_case_flags, scout_assignments, persona_anima_divergence)
- [ ] `context.addEvidence(record)` increments swipeCount, computes latencyBucket, builds SwipeEvidence entry, and emits `swipe-result` + `evidence-updated` on bus
- [ ] `context.addEvidence()` does NOT advance stage (stage ownership belongs to oracle)
- [ ] `context.pushFacade(f)` adds facade to queue and emits `facade-ready` on bus
- [ ] `context.queuePressure` returns `'hungry'` when queue has fewer than 3 facades
- [ ] `context.concretenessFloor` returns `'word'` with <4 evidence, `'image'` with <8, `'mockup'` with >=8
- [ ] `context.toEvidencePrompt()` returns numbered list of accept/reject entries with latency signals
- [ ] `context.toEvidencePrompt()` returns `'No evidence yet.'` when evidence is empty
- [ ] `bus.onceFacadeSwipe(facadeId)` returns a Promise that resolves when the matching `swipe:${facadeId}` event fires
- [ ] `bus.awaitFacadeSwipe(facadeId, timeoutMs)` resolves with `'timeout'` | `'stale'` | `'aborted'` | `SwipeRecord`
- [ ] `bus.onAny(cb)` subscribes to all SSE event types and returns an unsubscribe function
- [ ] Bus `emitSwipeResult` also emits `swipe:${facadeId}` for scout blocking
- [ ] Bus event helpers are typed via `SSEEventMap` — payloads match SSEEvent union at compile time
- [ ] `emitSessionReady` takes `{ intent }` only (no axes)
- [ ] `emitEvidenceUpdated` takes `{ evidence, antiPatterns }` (not `anima-updated`)
- [ ] No YAML library imported — serializer uses string templates

### Dependencies
- 01-scaffold (SvelteKit project structure)
- 02-types (SwipeEvidence, Facade, SwipeRecord, AgentState, PrototypeDraft, ProbeBrief, EmergentAxis, TasteSynthesis, Stage, SSEEventMap, SSEEventType)
