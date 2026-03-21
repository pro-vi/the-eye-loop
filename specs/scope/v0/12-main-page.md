# 12 — Main Page Layout + SSE Client + Session Flow

## Summary
Top-level page component that orchestrates the full user session: intent entry, SSE-driven swipe mode with 3-column layout, and reveal mode. Manages all client-side state and wires child components together. `src/routes/+page.svelte`.

## Design
State machine with three modes: `intent`, `swiping`, `reveal`. IntentEntry is inline (no separate component file needed at this scale). SSE client connects on mode transition and distributes events to reactive state. Swipe handler POSTs to `/api/swipe` and relies on SSE for subsequent state updates.

## Scope
### Files
- src/routes/+page.svelte (~215 LOC)

### State ($state declarations)
- `mode: 'intent' | 'swiping' | 'reveal'` — current session phase
- `intentText: string` — bound to input field
- `loading: boolean` — true while POST /api/session is in flight
- `error: string` — error message from session creation
- `sessionId: string | null` — returned from session creation
- `facades: Facade[]` — queued facades for SwipeFeed
- `evidence: SwipeEvidence[]` — swipe evidence for AnimaPanel
- `synthesis: TasteSynthesis | null` — oracle synthesis for AnimaPanel (emergent axes, edge case flags, scout assignments, persona-anima divergence)
- `antiPatterns: string[]` — rejected patterns for AnimaPanel
- `agents: AgentState[]` — agent statuses for AgentStatus
- `draft: PrototypeDraft` — builder output for PrototypeDraft component (initialized with empty title, summary, html, and empty pattern arrays)
- `stage: Stage` — current stage (words/images/mockups/reveal)

No `TasteAxis[]` state. Taste model is evidence-based: `SwipeEvidence[]` + `TasteSynthesis` (emergent axes format).

### Subtasks

## IntentEntry UI
Inline intent form rendered when `mode === 'intent'`:
- Text input bound to `intentText` with `bind:value`, placeholder "What do you want to build?"
- Submit button: "Go" (or "Starting..." when loading), disabled when `intentText.trim() === ''` or `loading === true`
- `onclick` handler (not `on:click`): sets `loading = true`, POSTs to `/api/session` with `{intent: intentText.trim()}`, receives `{sessionId}`, sets `sessionId`, transitions `mode = 'swiping'`, sets `loading = false`
- Loading state: button shows "Starting..." text, input disabled
- Centered layout: `flex flex-col items-center justify-center min-h-screen gap-6 px-6`
- Error handling: if POST fails, set `error` message, show below input
- `onkeydown` on input: Enter key triggers `startSession()`

## SSE connection management
`$effect` that runs when `mode === 'swiping'`:
- Create `EventSource` pointing to `/api/stream` (no query params — server uses singleton context)
- Parse incoming events by type:
  - `facade-ready`: parse JSON data, spread-append to `facades` array
  - `facade-stale`: parse JSON data, filter out stale facade by id
  - `evidence-updated`: parse JSON data, replace `evidence` array and `antiPatterns` array
  - `synthesis-updated`: parse JSON data, replace `synthesis` object
  - `agent-status`: parse JSON data, upsert into `agents` array (replace existing by id or append)
  - `draft-updated`: parse JSON data, replace `draft` object
  - `builder-hint`: parse JSON data, merge `hint` into `draft.nextHint`
  - `stage-changed`: parse JSON data, update `stage`. If `stage === 'reveal'`, set `mode = 'reveal'`
- Each event listener: `es.addEventListener('eventType', (e) => { ... })`
- Cleanup: return a teardown function from `$effect` that calls `es.close()`
- Connection error handling: `es.onerror` — log to console

## Layout grid
Responsive layout rendered when `mode === 'swiping'`:
- **Desktop (md+ breakpoint):** 3-column CSS grid: `grid grid-cols-[1fr_2.5fr_1.5fr] gap-4 h-screen p-4`
  - Left column: `<AnimaPanel {evidence} {synthesis} {antiPatterns} />`
  - Center column: `<SwipeFeed {facades} onswipe={handleSwipe} onremove={handleRemove} />`
  - Right column: `<PrototypeDraftPanel {draft} mode="swiping" />` stacked above `<AgentStatus {agents} />`
- **Mobile (below md):** stacked single column: SwipeFeed on top (full width), then AgentStatus, AnimaPanel, and PrototypeDraftPanel below in a `flex flex-col gap-4` container

Reveal mode layout:
- `<PrototypeDraftPanel {draft} mode="reveal" />` rendered full-width, centered
- SwipeFeed, AnimaPanel, AgentStatus not rendered

## Swipe handler
Function called by SwipeFeed's `onswipe` callback:
```
function handleSwipe(event: {facadeId: string, decision: 'accept' | 'reject', latencyMs: number}) {
  fetch('/api/swipe', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(event)
  }).catch(err => console.error('[swipe] POST failed:', err));
}
```
- Fire-and-forget POST — SSE handles all subsequent state updates
- **SwipeFeed owns card removal timing.** It runs the fly-off animation, listens for `transitionend`, then calls `onremove(facadeId)`. Main page splices on that callback:
  ```
  function handleRemove(facadeId: string) {
    facades = facades.filter(f => f.id !== facadeId);
  }
  ```
- Wire both callbacks: `<SwipeFeed {facades} onswipe={handleSwipe} onremove={handleRemove} />`

### Acceptance criteria
- [ ] Intent form is visible on initial page load (`mode === 'intent'`)
- [ ] Submit button is disabled when input is empty or loading is true
- [ ] Submitting intent POSTs to `/api/session` and transitions to swiping mode on success
- [ ] SSE EventSource connects when mode transitions to `swiping`
- [ ] `facade-ready` SSE events add facades to the SwipeFeed
- [ ] `facade-stale` SSE events remove stale facades from the array
- [ ] `evidence-updated` SSE events update the AnimaPanel evidence and anti-patterns
- [ ] `synthesis-updated` SSE events update the AnimaPanel synthesis (emergent axes with confidence badges)
- [ ] `agent-status` SSE events upsert into the AgentStatus panel
- [ ] `draft-updated` SSE events replace the full draft state in PrototypeDraft component
- [ ] `builder-hint` SSE events update `draft.nextHint` (lightweight secondary signal)
- [ ] `stage-changed` SSE event with `stage='reveal'` transitions mode to `reveal`
- [ ] EventSource is closed when mode changes away from swiping (effect cleanup)
- [ ] Swipe handler POSTs to `/api/swipe` with `{facadeId, decision, latencyMs}`
- [ ] Swiped card removal: SwipeFeed calls `onremove(facadeId)` after fly-off animation. Main page splices in `handleRemove`. No optimistic filter in `handleSwipe`.
- [ ] Desktop layout shows 3-column grid (AnimaPanel | SwipeFeed | PrototypeDraft + AgentStatus)
- [ ] Mobile layout stacks components vertically
- [ ] Reveal mode hides SwipeFeed, AnimaPanel, and AgentStatus; shows PrototypeDraft full-width
- [ ] No `TasteAxis[]` state — uses `SwipeEvidence[]` + `TasteSynthesis` (emergent axes format) + `string[]` anti-patterns
- [ ] All state uses `$state` runes, computed values use `$derived`
- [ ] No `on:click` syntax — all handlers use `onclick`

### Dependencies
Depends on 09-swipe-feed, 10-panels, 11-draft-reveal (child components), and 04-endpoints (SSE stream + swipe POST + session POST).

### Estimate
~215 LOC.
