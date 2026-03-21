# 09 — SwipeFeed Component

## Summary
Custom swipe card stack with PointerEvent gesture handling, stage-specific content rendering, and sub-ms latency capture. No gesture library. `src/lib/components/SwipeFeed.svelte`.

## Design
~50-line PointerEvent handler for swipe gestures. Card stack with absolute positioning and z-index layering. Stage-conditional content rendering (words, images, mockups). Emits structured swipe events with `{facadeId, decision, latencyMs}`.

## Scope
### Files
- src/lib/components/SwipeFeed.svelte

### Props
- `facades: Facade[]` — queued facades to display as cards
- `onswipe: (event: {facadeId: string, decision: 'accept' | 'reject', latencyMs: number}) => void` — callback fired on committed swipe (before animation)
- `onremove: (facadeId: string) => void` — callback fired after fly-off animation completes (transitionend). Parent splices the facade from its array here. This is the SOLE removal path.

### Subtasks

## Card stack layout
CSS absolute positioning with z-index layering. Top card at `z-10`, next card at `z-9` with `scale(0.95) translateY(10px)`, third at `z-8` with `scale(0.9) translateY(20px)`. Container is `position: relative` with fixed dimensions. Only render top 3 cards for performance.

## PointerEvent gesture handler
Custom ~50-line handler on the top card element:
- `onpointerdown`: record `startTime = performance.now()`, call `element.setPointerCapture(e.pointerId)`, store `startX = e.clientX`
- `onpointermove`: compute `deltaX = e.clientX - startX`, apply `transform: translateX(${deltaX}px) rotate(${deltaX * 0.05}deg)` directly to card style
- `onpointerup`: compute `latencyMs = performance.now() - startTime`. Threshold check: if `|deltaX| > 0.3 * cardWidth`, commit swipe — call `onswipe({facadeId, decision: deltaX > 0 ? 'accept' : 'reject', latencyMs})`. Otherwise, snap back.
- Set `touch-action: none` on card to prevent scroll interference
- Use `$state` for `deltaX`, `swiping` flag, and `startTime`

## Swipe animations
- **Fly-off (commit):** Apply class that sets `transform: translateX(${direction * 150}%) rotate(${direction * 15}deg); opacity: 0`. CSS `transition: transform 0.3s ease-out, opacity 0.3s ease-out`.
- **Snap-back (cancel):** Reset `transform: translateX(0) rotate(0)` with same transition.
- After fly-off transition ends (listen for `transitionend`), call `onremove(facadeId)`. The parent splices the facade from its array, which reactively removes the card from the DOM. SwipeFeed does NOT directly mutate the facades prop.
- Next card scale/translate transition creates the "slide up from stack" effect automatically via CSS transitions on nth-child rules.

## Stage-specific content rendering
Conditional rendering based on `facade.stage`:
- **words:** `<p class="text-3xl font-bold text-center">{facade.content}</p>` — plain text, centered, large
- **images:** `<img src={facade.imageDataUrl} alt={facade.hypothesis} class="w-full h-auto rounded-lg" />` — generated image display
- **mockups:** `<iframe srcdoc={facade.content} sandbox="" style="width:375px; height:667px; border:none; pointer-events:none" />` — sandboxed HTML preview, pointer-events disabled so swipe gestures pass through

Each card shows:
- Hypothesis text at top: `<p class="text-sm text-gray-400">{facade.hypothesis}</p>`
- Agent name badge in corner: `<span class="absolute top-2 right-2 text-xs bg-gray-700 px-2 py-1 rounded">{facade.agentId}</span>`
- Stage content in center area

### Acceptance criteria
- [ ] Card displays hypothesis text at the top of the card
- [ ] Card displays agent name badge in the corner
- [ ] Swiping right past 30% card width fires `onswipe` with `decision='accept'`
- [ ] Swiping left past 30% card width fires `onswipe` with `decision='reject'`
- [ ] `latencyMs` is captured via `performance.now()` with sub-ms precision (not `Date.now()`)
- [ ] Card animates off-screen (translateX 150%, rotate 15deg, opacity 0) on committed swipe with 0.3s ease-out transition
- [ ] Next card visibly slides up from the stack after top card exits
- [ ] Cancelled swipe (below threshold) snaps card back to center position
- [ ] Words stage renders centered large text
- [ ] Images stage renders `<img>` with `facade.imageDataUrl`
- [ ] Mockups stage renders sandboxed iframe at 375x667
- [ ] Card element has `touch-action: none` set
- [ ] No gesture library imported — pure PointerEvent API

### Dependencies
Depends on 04-endpoints (swipe POST route consumes the emitted swipe data).

### Estimate
~150-180 LOC.
