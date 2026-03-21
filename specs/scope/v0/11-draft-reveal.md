# 11 — PrototypeDraft Component + Reveal Mode

## Summary
Shows the builder's evolving HTML draft in a sandboxed iframe, accepted/rejected pattern chips, the builder's next-question hint, and a reveal transition that expands the draft to full viewport. `src/lib/components/PrototypeDraft.svelte`.

## Design
Three sections during swiping mode (preview, metadata, next hint). On reveal, the draft expands to fill the viewport and the other panels are hidden. The component receives the current `PrototypeDraft` object and a mode flag from the parent.

## Scope
### Files
- src/lib/components/PrototypeDraft.svelte

### Props
- `draft: PrototypeDraft` — builder's current draft (from V0 data contract)
- `mode: 'swiping' | 'reveal'` — controls layout expansion

### Subtasks

## Draft preview iframe
Sandboxed iframe rendering the builder's evolving HTML output:
- `<iframe srcdoc={draft.html} sandbox="" />` — most restrictive sandbox, no scripts
- Fixed viewport `375px x 667px` during swiping mode (mobile preview)
- `border: none`, `border-radius` for polish
- Iframe content updates reactively when `draft.html` changes (Svelte rebinds `srcdoc`)
- Container has `bg-gray-900 rounded-lg overflow-hidden` for framing

## Pattern chips
Display accepted and rejected patterns as colored chip lists below the preview:
- **Accepted patterns:** `draft.acceptedPatterns` rendered as flex-wrap chips with `bg-green-700/50 text-green-300 text-xs px-2 py-1 rounded-full`
- **Rejected patterns:** `draft.rejectedPatterns` rendered as flex-wrap chips with `bg-red-700/50 text-red-300 text-xs px-2 py-1 rounded-full` — these are PROHIBITIONS, label them visually (e.g., strikethrough or "NOT:" prefix)
- Use `{#each}` over both arrays
- Section hidden when both arrays are empty

## Next hint alert
Yellow alert box displaying the builder's construction-grounded question:
- Only rendered when `draft.nextHint` is truthy
- Style: `bg-amber-900/50 border border-amber-500/30 rounded-lg p-3`
- Icon or label: "Builder needs to know:" prefix in `text-amber-400 text-xs font-semibold`
- Hint text: `text-amber-200 text-sm` (e.g., "I need to know if the header is fixed or scroll-away")

## Reveal transition
When `mode` changes from `'swiping'` to `'reveal'`:
- Iframe expands from 375x667 to full container width/height using CSS transition (`transition: all 0.5s ease-out`)
- Pattern chips and next hint remain visible but move below the expanded preview
- Title and summary from `draft.title` and `draft.summary` appear prominently above the preview:
  - Title: `text-2xl font-bold text-white`
  - Summary: `text-base text-gray-300 mt-2`
- Use `$derived` to compute container classes based on `mode`
- The parent page (12-main-page) handles hiding SwipeFeed and AnimaPanel — this component only handles its own expansion

### Acceptance criteria
- [ ] Draft iframe renders `draft.html` content in a sandboxed iframe
- [ ] Iframe uses `sandbox=""` (most restrictive) — no `allow-scripts`
- [ ] Iframe is 375x667 during swiping mode
- [ ] Accepted patterns render as green chips showing pattern text
- [ ] Rejected patterns render as red chips showing pattern text
- [ ] Pattern chips section is hidden when both arrays are empty
- [ ] `draft.nextHint` displays in a yellow alert box when present
- [ ] `draft.nextHint` alert is hidden when `nextHint` is undefined/empty
- [ ] Reveal mode expands the iframe to full container width
- [ ] Reveal mode shows `draft.title` and `draft.summary` prominently
- [ ] Transition from swiping to reveal is animated (CSS transition, not instant)
- [ ] Component uses `$props` for `draft` and `mode`
- [ ] No `on:click` syntax — Svelte 5 event handlers only

### Dependencies
Depends on 06-builder (builder generates the `PrototypeDraft` object with html, patterns, and nextHint).

### Estimate
~120-150 LOC.
