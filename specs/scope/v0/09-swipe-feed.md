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
- `onvibetoken: (token: {label: string, decision: 'accept' | 'reject', sourceRect: DOMRect}) => void` — callback fired on swipe commit with card position. Main page animates the flying chip.

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

## Vibe token animation (swipe → builder causal link)

On swipe commit, spawn a floating chip that animates from the card to the builder draft panel. This is the visual link between "I swiped" and "the draft changed." The token lands instantly; the actual draft update arrives 3-6s later — but the user already saw their choice fly into the builder.

**Mechanic:**
1. On swipe commit (same moment as `onswipe` fires), call `onvibetoken(token)` where:
   ```typescript
   interface VibeToken {
     label: string;          // facade.label — the word/phrase
     decision: 'accept' | 'reject';
     sourceRect: DOMRect;    // getBoundingClientRect() of the swiped card
   }
   ```
2. The **main page** (not SwipeFeed) owns the animation layer. It receives the token, creates an absolutely-positioned chip in a portal/overlay div, and animates it.
3. **Accept tokens (green):** fly to the draft panel header area.
4. **Reject tokens (red):** fly to the anti-patterns/rejected chips section of the draft panel.

**Animation (~40 lines in main page):**
```
- Create <div class="vibe-token"> absolutely positioned at sourceRect coords
- Accept: green bg, "✓ {label}". Reject: red bg, "✗ {label}"
- Use Web Animations API:
    element.animate([
      { left, top, scale: 1, opacity: 1 },                    // start at card
      { left: targetX, top: targetY, scale: 0.6, opacity: 0.8 } // end at panel
    ], { duration: 400, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
- targetRect = getBoundingClientRect() of the draft panel (accept) or anti-patterns section (reject)
- On animation finish: remove chip, briefly pulse target panel border (green/red, 200ms fade)
```

**CSS for the chip:**
```css
.vibe-token {
  position: fixed; /* overlay layer, not in flow */
  z-index: 50;
  padding: 4px 12px;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  pointer-events: none;
  white-space: nowrap;
}
.vibe-token.accept { background: #22c55e; color: white; }
.vibe-token.reject { background: #ef4444; color: white; }
```

**Why this works:**
- Instant feedback (0ms after swipe, not 3-6s)
- Zero LLM cost — pure client-side animation
- Causal link is physical/spatial — the choice visibly travels to where it's consumed
- Works even when builder is batching — the token lands before the draft updates
- Mobile-game-like "collecting" feel — satisfying micro-interaction

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
- [ ] On swipe commit, `onvibetoken` fires with label, decision, and card's DOMRect
- [ ] Vibe token chip appears at card position and animates toward draft panel (accept=green, reject=red)
- [ ] Token animation completes in ~400ms with ease-out curve
- [ ] Target panel border pulses briefly on token arrival

### Dependencies
Depends on 04-endpoints (swipe POST route consumes the emitted swipe data).

### Estimate
~150-180 LOC.
