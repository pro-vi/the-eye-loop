# 03 — EyeLoopContext + Event Bus + Anima YAML Serializer

## Summary
Build the server-side state singleton, typed event bus, and Anima YAML serializer. These three pieces form the shared backbone that every agent loop, endpoint, and SSE stream depends on. Context is the single mutable state surface; the bus is how mutations propagate; the YAML serializer is how state reaches LLM prompts.

## Design
`EyeLoopContext` is a module-level singleton in `src/lib/server/context.ts` — Vercel Fluid Compute keeps the instance alive across requests for the duration of the session. The event bus wraps Node.js `EventEmitter` with typed helpers so listeners never receive untyped payloads. The Anima YAML serializer converts the flat axis map into the four-section YAML format defined in specs/1-prompts.md section 1 (resolved / exploring / unprobed / anti_patterns), kept under 300 tokens.

## Scope
### Files
- src/lib/server/context.ts (~280 LOC)
- src/lib/server/bus.ts (~100 LOC)

### Subtasks

## EyeLoopContext singleton
Module-level singleton exported from `src/lib/server/context.ts`. Imports types from `src/lib/context/types.ts`.

State fields:
- `intent: string`
- `swipeCount: number`
- `stage: Stage`
- `axes: Map<string, TasteAxis>`
- `facades: Facade[]` (ordered queue, head = next to show)
- `consumedFacades: Facade[]` (already swiped, kept for history)
- `probes: ProbeBrief[]`
- `agents: Map<string, AgentState>`
- `draft: PrototypeDraft`
- `antiPatterns: string[]`
- `swipeLatencies: number[]` (for computing session median)

Methods:
- `seedAxes(axes: TasteAxis[])` — populate initial axes from session init
- `addEvidence(record: SwipeRecord)` — update targeted axis confidence and leaning, increment swipeCount, push latency, compute latencyBucket (fast if below current median, else slow). Does NOT advance stage — stage advancement is owned exclusively by the oracle (07-oracle) to avoid split ownership.
- `pushFacade(facade: Facade)` — append to queue, emit facade-ready on bus
- `markFacadeConsumed(facadeId: string)` — move facade from queue to consumedFacades
- `getNextProbe(): ProbeBrief | undefined` — pop highest-priority probe
- `getMostUncertainAxis(): TasteAxis | undefined` — return axis with lowest confidence among non-resolved axes (confidence < 0.8)
- `queueHealthy(): boolean` — true if facades.length >= 3 and <= 5
- `reset()` — clear all state for new session
- `toAnimaYAML(): string` — serialize current state (see subtask below)

Getters:
- `currentStage` — derived from swipeCount thresholds
- `sessionMedianLatency` — median of swipeLatencies array

## Event bus
Node.js `EventEmitter` wrapper in `src/lib/server/bus.ts`. Single module-level instance.

Events and their payloads (typed helper functions for each — must match SSEEvent union in 02-types):
- `facade-ready` — `{ facade: Facade }`
- `facade-stale` — `{ facadeId: string }` (scouts awaiting this facade should unblock and skip)
- `swipe-result` — `{ record: SwipeRecord, axisUpdate: TasteAxis }`
- `swipe:${facadeId}` — `{ record: SwipeRecord }` (per-facade, used by scouts to await their facade's result via `bus.once()`)
- `anima-updated` — `{ axes: TasteAxis[], antiPatterns: string[] }`
- `agent-status` — `{ agent: AgentState }`
- `builder-hint` — `{ hint: string }`
- `stage-changed` — `{ stage: Stage, swipeCount: number }`
- `draft-updated` — `{ draft: PrototypeDraft }`
- `session-ready` — `{ intent: string, axes: TasteAxis[] }`

Typed helpers:
- `emitFacadeReady(facade)`, `emitSwipeResult(record, axisUpdate)`, etc.
- `onFacadeReady(cb)`, `onSwipeResult(cb)`, etc.
- `onceFacadeSwipe(facadeId): Promise<SwipeRecord>` — returns a promise that resolves when `swipe:${facadeId}` fires (scout blocking pattern)

## Anima YAML serializer
Method `toAnimaYAML()` on EyeLoopContext (or standalone function imported into context). Converts the flat axis map into the four-section YAML format from specs/1-prompts.md section 1.

Output format:
```yaml
# Anima | {swipeCount} swipes | stage: {stage}
intent: "{intent}"

resolved:
  {axis.label}:
    value: {axis.leaning}
    confidence: {axis.confidence}

exploring:
  {axis.label}:
    hypotheses: [{option_a}, {option_b}]
    distribution: [{p_a}, {p_b}]
    probes_spent: {axis.evidenceCount}

unprobed:
  - {axis.label}

anti_patterns:
  - {pattern}
```

Classification rules:
- confidence >= 0.8 and leaning set => resolved
- confidence > 0 and confidence < 0.8 => exploring
- evidenceCount === 0 => unprobed
- Anti-patterns always listed from `context.antiPatterns`

Keep output under 300 tokens. Use string concatenation or template literals, not a YAML library.

### Acceptance criteria
- [ ] `import { context } from '$lib/server/context'` resolves in any server-side file
- [ ] `context.seedAxes([...])` populates `context.axes` map with correct keys
- [ ] `context.addEvidence(record)` increments swipeCount, updates axis confidence, and sets latencyBucket on the record
- [ ] `context.addEvidence()` does NOT advance stage (stage ownership belongs to oracle)
- [ ] `context.getMostUncertainAxis()` returns the axis with the lowest confidence below 0.8
- [ ] `context.pushFacade(f)` adds facade to queue and emits `facade-ready` on bus
- [ ] `context.queueHealthy()` returns false when queue has fewer than 3 facades
- [ ] `context.toAnimaYAML()` output contains all four sections: resolved, exploring, unprobed, anti_patterns
- [ ] `context.toAnimaYAML()` classifies an axis with confidence 0.9 and a leaning as resolved
- [ ] `context.toAnimaYAML()` classifies an axis with confidence 0.4 as exploring
- [ ] `context.toAnimaYAML()` classifies an axis with evidenceCount 0 as unprobed
- [ ] `bus.onceFacadeSwipe(facadeId)` returns a Promise that resolves when the matching `swipe:${facadeId}` event fires
- [ ] Bus event helpers are typed — `emitSwipeResult` requires both `record` and `axisUpdate` arguments
- [ ] No YAML library imported — serializer uses string templates

### Dependencies
- 01-scaffold (SvelteKit project structure)
- 02-types (TasteAxis, Facade, SwipeRecord, AgentState, PrototypeDraft, ProbeBrief, Stage)
