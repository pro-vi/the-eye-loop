# Announcement: Oracle Cold-Start Intent Analysis

**Date:** 2026-03-21
**Affects:** Oracle (`oracle.ts`), Scout (`scout.ts`), Context (`context.ts`)
**Source of truth:** `specs/4-akinator.md` — "Cold Start — Oracle Intent Analysis"

---

## Problem

First 3 swipes had no oracle synthesis. Scouts self-assigned from generic lenses only. Result: all 3 scouts produced "Gamification" for "ai workspace" — zero intent-specific diversity.

## Fix

Oracle makes ONE fast LLM call at session init (before scouts start). Reads the intent, produces 3 intent-specific first hypotheses — one per scout.

## Oracle (`oracle.ts`)

`seedSession()` changes from pure code to code + one LLM call:

```typescript
export async function seedSession(intent: string): Promise<{ sessionId: string }> {
  context.reset();
  context.intent = intent;
  context.sessionId = crypto.randomUUID();

  // NEW: cold-start intent analysis
  const result = await generateText({
    model: FAST_MODEL,  // Claude Haiku 4.5 via src/lib/server/ai.ts — speed matters
    temperature: 0,
    output: Output.object({ schema: coldStartSchema }),
    prompt: COLD_START_PROMPT.replace('{INTENT}', intent),
  });

  // Store as lightweight TasteSynthesis so scouts read it through same path
  if (result.output) {
    context.synthesis = {
      axes: result.output.map(h => ({
        label: h.hypothesis,
        poleA: h.word_probe,
        poleB: '(unknown)',
        confidence: 'unprobed',
        leaning_toward: null,
        evidence_basis: 'intent analysis (no evidence yet)',
      })),
      edge_case_flags: [],
      scout_assignments: result.output.map(h => ({
        scout: h.scout,
        probe_axis: h.hypothesis,
        reason: `Cold start: first question for ${h.scout}`,
      })),
      persona_anima_divergence: null,
    };
  }

  emitSessionReady({ intent });
  return { sessionId: context.sessionId };
}
```

Cold-start prompt (see `specs/4-akinator.md` for full version):

```
You are the Oracle. A user just started a session.
INTENT: "{INTENT}"
Produce 3 FIRST QUESTIONS — one for Iris (look/feel), Prism (layout/interaction), Lumen (voice/personality).
word_probe must be plain language, 1-3 words, understandable in 1 second.
```

**`seedSession` becomes async.** Update callers.

## Scout (`scout.ts`)

No changes needed. Scouts already read `context.synthesis?.scout_assignments` and follow their assignment. The cold-start synthesis flows through the same code path as full synthesis.

The scout will see:
- `getAxisAssignment('Iris')` → `Probe "Dark canvas" — Cold start: first question for Iris`
- Evidence: `(no evidence yet)`
- Format: `word` (evidence count = 0)

## Context (`context.ts`)

No changes needed. `context.synthesis` is already `TasteSynthesis | null`. The cold-start output is a valid `TasteSynthesis` with 3 axes at `unprobed` confidence.

## Session endpoint (`api/session/+server.ts`)

`seedSession` is now async — add `await`:

```typescript
const { sessionId } = await seedSession(intent.trim());
```

## Timing

Cold-start LLM call uses Flash Lite (~2s). Runs BEFORE scouts start. Total session init: ~2-3s (cold-start analysis + first scout probe generation in parallel).

## What Doesn't Change

- Full synthesis (every 4 swipes) — unchanged
- Scout prompt — unchanged (already reads assignments)
- Scout lenses — still active, bias self-assignment when no oracle assignment exists
- Builder — unchanged
- Queue, SSE, events — unchanged
