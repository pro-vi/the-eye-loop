# 12 — Main Page Layout + SSE Client + Session Flow

## Summary
Top-level page component that orchestrates the full user session: intent entry, SSE-driven swipe mode with 3-column layout, and reveal mode. Manages all client-side state and wires child components together. `src/routes/+page.svelte`.

## Design
State machine with three modes: `intent`, `swiping`, `reveal`. IntentEntry is inline (no separate component file needed at this scale). SSE client connects on mode transition and distributes events to reactive state. Swipe handler POSTs to `/api/swipe` and relies on SSE for subsequent state updates.

## Scope
### Files
- src/routes/+page.svelte

### State ($state declarations)
- `mode: 'intent' | 'swiping' | 'reveal'` — current session phase
- `intentText: string` — bound to input field
- `loading: boolean` — true while POST /api/session is in flight
- `sessionId: string | null` — returned from session creation
- `facades: Facade[]` — queued facades for SwipeFeed
- `axes: TasteAxis[]` — current Anima state for AnimaPanel
- `agents: AgentState[]` — agent statuses for AgentStatus
- `draft: PrototypeDraft` — builder output for PrototypeDraft component
- `stage: Stage` — current stage (words/images/mockups/reveal)

### Subtasks

## IntentEntry UI
Inline intent form rendered when `mode === 'intent'`:
- Text input bound to `intentText` with `bind:value`, placeholder "What do you want to build?" or similar
- Submit button: "Start Discovery", disabled when `intentText.trim() === ''` or `loading === true`
- `onclick` handler (not `on:click`): sets `loading = true`, POSTs to `/api/session` with `{intent: intentText}`, receives `{sessionId, intent, axes}`, sets `sessionId`, `axes`, transitions `mode = 'swiping'`, sets `loading = false`
- Loading state: button shows spinner or "Starting..." text, input disabled
- Centered layout: `flex flex-col items-center justify-center min-h-screen gap-4`
- Error handling: if POST fails, set `loading = false`, show error message

## SSE connection management
`$effect` that runs when `mode === 'swiping'`:
- Create `EventSource` pointing to `/api/stream?sessionId=${sessionId}`
- Parse incoming events by type:
  - `facade-ready`: parse JSON data, push to `facades` array
  - `anima-updated`: parse JSON data, replace `axes` array
  - `agent-status`: parse JSON data, replace `agents` array
  - `draft-updated`: parse JSON data, replace `draft` object (carries full PrototypeDraft with html, patterns, nextHint)
  - `builder-hint`: parse JSON data, update `draft.nextHint` only (lightweight signal, optional — `draft-updated` is authoritative)
  - `stage-changed`: parse JSON data, update `stage`. If `stage === 'reveal'`, set `mode = 'reveal'`
- Each event listener: `eventSource.addEventListener('eventType', (e) => { ... })`
- Cleanup: return a teardown function from `$effect` that calls `eventSource.close()`
- Also close on mode change away from swiping (handled by effect re-run)
- Connection error handling: `eventSource.onerror` — log, optionally show reconnecting indicator

## Layout grid
Responsive layout rendered when `mode === 'swiping'`:
- **Desktop (md+ breakpoint):** 3-column CSS grid: `grid grid-cols-[1fr_2.5fr_1.5fr] gap-4 h-screen p-4`
  - Left column (20%): `<AnimaPanel axes={axes} />`
  - Center column (50%): `<SwipeFeed facades={facades} onswipe={handleSwipe} />`
  - Right column (30%): `<PrototypeDraft draft={draft} mode="swiping" />` stacked above `<AgentStatus agents={agents} />`
- **Mobile (below md):** stacked single column: SwipeFeed on top (full width), AnimaPanel and AgentStatus in a horizontal scroll or collapsed accordion below, PrototypeDraft at bottom

Reveal mode layout:
- `<PrototypeDraft draft={draft} mode="reveal" />` rendered full-width
- SwipeFeed, AnimaPanel, AgentStatus hidden (not rendered, not just `display:none` — avoid SSE waste)
- Back button or "Start Over" to reset to intent mode (optional, stretch)

## State management
All state declared at component top level with `$state`:
```
let mode = $state<'intent' | 'swiping' | 'reveal'>('intent');
let facades = $state<Facade[]>([]);
let axes = $state<TasteAxis[]>([]);
// etc.
```
Use `$derived` for:
- `currentStage`: derived from `stage` state
- `isLoading`: derived from `loading` state (for template conditionals)
- `hasFacades`: `facades.length > 0` (show empty state in SwipeFeed if false)

## Swipe handler
Async function called by SwipeFeed's `onswipe` callback:
```
async function handleSwipe(event: {facadeId: string, decision: 'accept' | 'reject', latencyMs: number}) {
  // Do NOT remove the facade from the facades array here.
  // SwipeFeed owns card removal: it triggers the fly-off animation
  // and emits transitionend, then removes from its rendered list.
  // Main page facades array is updated by SSE (anima-updated rebuilds state).

  // POST to server (fire-and-forget, don't await if latency is a concern)
  fetch('/api/swipe', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(event)
  });

  // SSE handles all subsequent state updates (new facades, anima, draft, agents)
}
```
- **SwipeFeed owns card removal timing.** It runs the fly-off animation, listens for `transitionend`, then calls `onremove(facadeId)`. Main page splices on that callback:
  ```
  function handleRemove(facadeId: string) {
    facades = facades.filter(f => f.id !== facadeId);
  }
  ```
- Wire both callbacks: `<SwipeFeed {facades} onswipe={handleSwipe} onremove={handleRemove} />`
- No need to process POST response body — SSE delivers all downstream updates
- Error handling: if POST fails, log error

### Acceptance criteria
- [ ] Intent form is visible on initial page load (`mode === 'intent'`)
- [ ] Submit button is disabled when input is empty or loading is true
- [ ] Submitting intent POSTs to `/api/session` and transitions to swiping mode on success
- [ ] SSE EventSource connects when mode transitions to `swiping`
- [ ] `facade-ready` SSE events add facades to the SwipeFeed
- [ ] `anima-updated` SSE events update the AnimaPanel axes
- [ ] `agent-status` SSE events update the AgentStatus panel
- [ ] `draft-updated` SSE events replace the full draft state in PrototypeDraft component
- [ ] `builder-hint` SSE events update `draft.nextHint` (lightweight secondary signal)
- [ ] `stage-changed` SSE event with `stage='reveal'` transitions mode to `reveal`
- [ ] EventSource is closed when mode changes away from swiping (effect cleanup)
- [ ] Swipe handler POSTs to `/api/swipe` with `{facadeId, decision, latencyMs}`
- [ ] Swiped card removal: SwipeFeed calls `onremove(facadeId)` after fly-off animation. Main page splices in `handleRemove`. No optimistic filter in `handleSwipe`.
- [ ] Desktop layout shows 3-column grid (AnimaPanel | SwipeFeed | PrototypeDraft + AgentStatus)
- [ ] Mobile layout stacks components vertically
- [ ] Reveal mode hides SwipeFeed, AnimaPanel, and AgentStatus; shows PrototypeDraft full-width
- [ ] All state uses `$state` runes, computed values use `$derived`
- [ ] No `on:click` syntax — all handlers use `onclick`

### Dependencies
Depends on 09-swipe-feed, 10-panels, 11-draft-reveal (child components), and 04-endpoints (SSE stream + swipe POST + session POST).

### Estimate
~200-250 LOC.
