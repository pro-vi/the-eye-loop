# Announcement: Scout Dedup Mechanisms

**Date:** 2026-03-21 (historical)
**Affects:** Scout agent (`src/lib/server/agents/scout.ts`)
**Source of truth:** `src/lib/server/agents/scout.ts` — `SCOUT_ROSTER`, `SCOUT_LENSES`,
`startScout` isDuplicate check, `startAllScouts`.

---

## Status

**Historical.** The three fixes below were designed for a 3-scout roster
(Iris / Prism / Lumen). The landed system has a **6-scout roster** and
does not stagger scout starts. The dedup problem this announcement names
is still real; the landing shape differs from what is documented here.

If you are implementing or reviewing scout behavior, read `scout.ts`
directly — do NOT reimplement from the "Three Fixes" section below.

### What actually landed

- **Roster:** 6 scouts — Iris, Prism, Lumen, Aura, Facet, Echo — defined
  at `scout.ts:32-39` (`SCOUT_ROSTER`).
- **Lenses:** a 6-entry map with different descriptions than the ones
  quoted below, defined at `scout.ts:41-48` (`SCOUT_LENSES`).
- **Queue dedup:** post-generateText exact-match on `axis_targeted`
  (case-insensitive) at `scout.ts:292-299`, not the
  `hypothesis.includes(axis_targeted)` approximation proposed in Fix 2.
- **Staggered starts:** removed. All 6 scouts fire simultaneously at
  session-ready; the comment at `scout.ts:475-482` explains why the
  500ms stagger's "first probe lands in queue before second scout reads
  queue" premise no longer holds when probe generation takes ~1-2s on
  Claude Haiku 4.5. Validator invariant `scout_start_spread_ms_p50 = 0`
  (see `scripts/validate.mjs` + `scripts/search-set.mjs`) encodes this
  shape as a regression probe.

---

## Problem (unchanged framing)

Boss test (16/16) revealed: all 3 scouts produced "Gamification" at cold
start. Without oracle assignments (first 3 swipes), scouts have no
coordination and duplicate probes. The root cause — uncoordinated
self-assignment at cold start — still informs the current design; only
the three mitigations below have evolved.

---

## Historical design (do not reimplement from this section)

<details>
<summary>Three Fixes (original 2026-03-21 proposal — superseded)</summary>

### 1. Scout Lenses — add to prompt (superseded: 6-entry map in scout.ts:41-48)

Each scout gets a permanent 1-line personality bias:

```typescript
const SCOUT_LENSES: Record<string, string> = {
  Iris:  'You naturally gravitate toward VISUAL and SENSORY questions — color, texture, materiality, atmosphere, visual weight.',
  Prism: 'You naturally gravitate toward INTERACTION and STRUCTURE questions — navigation, density, information flow, layout, hierarchy.',
  Lumen: 'You naturally gravitate toward IDENTITY and NARRATIVE questions — tone, personality, brand voice, emotional arc, metaphor.',
};
```

Inject as `{SCOUT_LENS}` in the prompt, right after `You are {SCOUT_NAME}`.

The lens is permanent — doesn't change. Oracle assignments override it when present, but the lens biases self-assignment (cold start and between syntheses).

### 2. Queue Dedup Check — add before pushFacade (superseded: axis_targeted equality in scout.ts:292-299)

After `generateText` returns, before `context.pushFacade()`:

```typescript
const isDuplicate = context.facades.some(f =>
  f.hypothesis.toLowerCase().includes(output.axis_targeted.toLowerCase()) ||
  output.axis_targeted.toLowerCase().includes(
    f.hypothesis.toLowerCase().split(' ').slice(0, 3).join(' ')
  )
);
if (isDuplicate) continue; // skip push, loop and regenerate
```

Catches race conditions where two scouts generated in parallel and targeted the same axis.

### 3. Staggered Starts — modify startAllScouts (superseded: REMOVED in iter-16)

```typescript
export function startAllScouts(): void {
  startScout('scout-01', 'Iris');
  setTimeout(() => startScout('scout-02', 'Prism'), 500);
  setTimeout(() => startScout('scout-03', 'Lumen'), 1000);
}
```

First probe lands in queue before second scout reads the queue. Natural dedup.

**Why superseded:** Claude Haiku 4.5 per-probe latency is ~1-2s, so
scout-N never saw scout-(N-1)'s just-pushed facade regardless of the
500ms offset. The stated mechanism never fired. See `scout.ts:475-482`
for the current comment and the validator's `scout_start_spread_ms`
metric for the regression probe.

</details>

## What Doesn't Change

- Scout loop structure (generate → push → wait → learn → loop)
- Oracle assignments (still override lens when present)
- Queue visibility in prompt (already implemented)
- Format gate / concreteness floor
- Evidence serialization
