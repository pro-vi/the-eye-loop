# Feature: Eye Loop V0 — Hackathon Build

Smallest shippable version of The Eye Loop for the Zero to Agent hackathon demo. User types an intent, swipes through generated facades, watches a visible taste model form, and sees a prototype draft evolve.

## Demo Contract (all five must be true)

1. User enters intent → first facades appear quickly
2. Every swipe visibly updates the Anima
3. Next facades clearly respond to previous choices
4. UI shows named agents working in parallel
5. Prototype pane starts changing before final reveal

## Dependency Layers

```
L0 — Scaffold + Plumbing
  01-scaffold, 02-types, 03-context, 04-endpoints

L1 — Agent Loops (depends on L0)
  05-scout-words (depends on 03, 04)
  06-builder (depends on 03, 04)
  07-oracle (depends on 03, 05)
  08-scout-stages (depends on 05)

L2 — UI (depends on L0 + L1)
  09-swipe-feed (depends on 04)
  10-panels (depends on 04, 05, 06)
  11-draft-reveal (depends on 06)
  12-main-page (depends on 09, 10, 11)
```

## Critical Path

01 → 02 → 03 → 04 → 05 → 06 → 09 → 11 → 12

This satisfies all 5 demo contract items: intent → facades (1), visible Anima (2), responsive next facades (3), named agents (4), evolving prototype pane (5). Builder (06) and draft UI (11) are on the critical path because demo contract #5 requires visible draft changes before reveal.

## Tickets

- [ ] 01-scaffold — SvelteKit + AI SDK + Tailwind + deploy config
- [ ] 02-types — V0 data contract (TasteAxis, Facade, SwipeRecord, AgentState, PrototypeDraft)
- [ ] 03-context — EyeLoopContext singleton + event bus + Anima YAML serializer
- [ ] 04-endpoints — SSE stream + swipe POST + session init (with axis seeding LLM call)
- [ ] 05-scout-words — Scout core loop end-to-end (words stage only)
- [ ] 06-builder — Builder reactive loop (update draft on each swipe, emit hints)
- [ ] 07-oracle — Queue health, stage advancement, freshness pruning (pure code)
- [ ] 08-scout-stages — Image generation (Nano Banana) + HTML mockup generation
- [ ] 09-swipe-feed — SwipeFeed component with gesture handler + latency capture
- [ ] 10-panels — AnimaPanel (confidence bars) + AgentStatus (live agent activity)
- [ ] 11-draft-reveal — PrototypeDraft component + reveal mode transition
- [ ] 12-main-page — Layout, SSE client, session flow (intent → swiping → reveal)

## Timing Estimate (~6.5 hours)

| Block | Tickets | Time |
|-------|---------|------|
| Foundation | 01-04 | ~2 hrs |
| Core loop | 05-06 | ~1.5 hrs |
| First demo checkpoint | 09, 12 (minimal) | ~1 hr |
| Expand | 07, 08, 10, 11 | ~1.5 hrs |
| Polish + demo video | — | ~30 min |
