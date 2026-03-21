# Announcement: Scout Dedup Mechanisms

**Date:** 2026-03-21
**Affects:** Scout agent (`src/lib/server/agents/scout.ts`)
**Source of truth:** `specs/4-akinator.md` — "Scout Lenses", "Queue Dedup Check", "Staggered Starts"

---

## Problem

Boss test (16/16) revealed: all 3 scouts produced "Gamification" at cold start. Without oracle assignments (first 3 swipes), scouts have no coordination and duplicate probes.

## Three Fixes (all in `scout.ts`)

### 1. Scout Lenses — add to prompt

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

### 2. Queue Dedup Check — add before pushFacade

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

### 3. Staggered Starts — modify startAllScouts

```typescript
export function startAllScouts(): void {
  startScout('scout-01', 'Iris');
  setTimeout(() => startScout('scout-02', 'Prism'), 500);
  setTimeout(() => startScout('scout-03', 'Lumen'), 1000);
}
```

First probe lands in queue before second scout reads the queue. Natural dedup.

## What Doesn't Change

- Scout loop structure (generate → push → wait → learn → loop)
- Oracle assignments (still override lens when present)
- Queue visibility in prompt (already implemented)
- Format gate / concreteness floor
- Evidence serialization
