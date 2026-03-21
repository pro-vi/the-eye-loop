# 13 — Polish: Streaming Draft + Embedding Diversity

## Summary

Two AI SDK features that elevate the demo from "works" to "wow." Both are independent of each other and can be implemented in any order. Neither changes the agent architecture — they enhance existing flows.

---

## 13a — Streaming Builder Draft

### The Demo Moment

Right now the builder calls `generateText()` and the draft appears all at once after 2-3s. With `streamText()`, the prototype pane shows HTML being written in real-time — the user swipes, and the prototype visibly grows character by character. This is demo contract #5 turned up to 11.

### What Changes

**Builder agent** (`src/lib/server/agents/builder.ts`):
- Replace `generateText()` with `streamText()` for the swipe-result handler
- Stream partial output to client via new `draft-streaming` SSE events
- Keep `generateText()` for the intent-seed scaffold (one-shot, no streaming benefit)

**SSE event type** (`src/lib/context/types.ts`):
- Add `{ type: 'draft-chunk'; chunk: string }` to SSEEvent union
- Add `{ type: 'draft-complete'; draft: PrototypeDraft }` to SSEEvent union

**PrototypeDraft component** (`src/lib/components/PrototypeDraft.svelte`):
- Accumulate `draft-chunk` events into a growing HTML string
- Render partial HTML in the sandboxed iframe as it arrives
- On `draft-complete`, replace accumulated chunks with the final draft

### Implementation

```typescript
// In builder.ts onSwipeResult handler — replace generateText with:
import { streamText } from 'ai';

const result = streamText({
  model: MODEL,
  output: Output.object({ schema: DraftUpdateSchema }),
  temperature: 0,
  system: systemPrompt,
  prompt: userPrompt,
});

// Stream chunks to client as they arrive
for await (const chunk of result.textStream) {
  emitDraftChunk({ chunk });
}

// After stream completes, extract structured output
const finalOutput = await result.output;
// ... merge logic unchanged
emitDraftComplete({ draft: context.draft });
```

### Anchors

**Demo contract #5:** "A prototype pane starts changing before the final reveal." Streaming makes this visceral — the user SEES the code being written.

**Judging: Live Demo (45%):** The most weighted criterion. Real-time streaming separates "it works" from "it's alive."

**Judging: Creativity (35%):** Most AI demos show a loading spinner then a result. Streaming the prototype assembly is a visual metaphor for the system's understanding growing in real time.

**Research anchor:** `.research/synthesis-gemini-projects` — Gemini CLI uses `generateContentStream()` for all calls. Streaming at the chunk level allows partial completion recovery and real-time progress. The pattern is battle-tested.

### Gotchas

- `streamText` with `Output.object()` — the structured output is only available after the stream completes (via `result.output` promise). The stream itself is raw text chunks, not structured JSON. Parse at the end, stream for visual effect.
- If the streamed HTML is malformed mid-generation, the iframe may flash broken layout. Mitigate: buffer 200ms of chunks before rendering, or only update iframe every 500ms.
- `streamText` does NOT support `abortSignal` the same way as `generateText` in all cases. Test abort behavior with the builder's session guard.

### Files

| File | Action | ~LOC |
|------|--------|------|
| `src/lib/server/agents/builder.ts` | Edit | +20, -5 |
| `src/lib/context/types.ts` | Edit | +2 (SSEEvent variants) |
| `src/lib/server/bus.ts` | Edit | +4 (emit helpers) |
| `src/lib/components/PrototypeDraft.svelte` | Edit | +15 |

### Acceptance Criteria

- [ ] After a swipe, `draft-chunk` events appear on the SSE stream within 500ms
- [ ] The prototype pane visibly updates DURING builder generation, not after
- [ ] `draft-complete` fires after the stream ends with the final merged draft
- [ ] Intent-seed scaffold still uses `generateText` (no streaming for one-shot)
- [ ] If session resets mid-stream, the stream is aborted cleanly (no orphaned chunks)

### Dependencies

06-builder (must be working), 11-draft-reveal (component must exist), 04-endpoints (SSE must forward new event types).

---

## 13b — Embedding-Based Facade Diversity

### The Problem

Scouts can generate facades that test the same territory with different words. String overlap misses semantic duplicates:
- "Minimalist dashboard" and "Clean sparse interface" — 0% string overlap, ~95% semantic overlap
- The user swipes on functionally identical probes — wasted information

### What Changes

**Diversity gate in scout loop** (`src/lib/server/agents/scout.ts`):
- After generating a facade, embed its hypothesis + content
- Compare against embeddings of queued facades + last N consumed facades
- If cosine similarity > threshold → reject and regenerate (up to 2 retries)

**Embedding model** — Gemini's text embedding via AI SDK:

```typescript
import { embed } from 'ai';

const { embedding } = await embed({
  model: google.textEmbeddingModel('text-embedding-004'),
  value: `${facade.hypothesis}: ${facade.label}`,
});
```

**Embedding cache on context** (`src/lib/server/context.ts`):
- Store embeddings alongside facades: `facadeEmbeddings: Map<string, number[]>`
- Cleared on session reset

### Implementation

```typescript
// In scout.ts, after generateText produces a facade:

const candidateText = `${output.hypothesis}: ${output.label} — ${output.content.slice(0, 100)}`;
const { embedding: candidateEmb } = await embed({
  model: google.textEmbeddingModel('text-embedding-004'),
  value: candidateText,
});

// Check against queued + recent consumed facades
const isDuplicate = [...context.facadeEmbeddings.entries()].some(([id, emb]) => {
  return cosineSimilarity(candidateEmb, emb) > DIVERSITY_THRESHOLD;
});

if (isDuplicate && retries < MAX_DIVERSITY_RETRIES) {
  retries++;
  continue; // regenerate
}

// Store embedding for future comparisons
context.facadeEmbeddings.set(facade.id, candidateEmb);
```

### Cosine Similarity (inline, ~5 lines)

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
```

### Threshold Tuning

| Threshold | Behavior |
|-----------|----------|
| 0.95 | Only reject near-identical probes (safe, almost no false positives) |
| 0.85 | Reject semantically similar probes (moderate, good diversity) |
| 0.75 | Aggressive diversity (may reject valid probes that happen to share a topic) |

Start at **0.85**. Tune based on demo behavior. If scouts get stuck in retry loops, raise to 0.90.

### Anchors

**Research anchor:** `research/generative-ui.md` — Design Galleries (SIGGRAPH 1997) formalized that dispersion is algorithmic, not decorative. "If the queue shows perceptually near-identical candidates, every response after the first carries almost no new information." Embeddings operationalize perceptual dispersion.

**Research anchor:** `research/iec-fatigue.md` — "Starting from random seeds wastes the most valuable swipes." Redundant facades waste swipes just as much as random ones. The user's ~30 swipe budget is fixed; every duplicate burns one.

**Research anchor:** `research/active-preference-learning.md` — "Choose comparisons near the model's current uncertainty boundary, but force in diversity so you do not get trapped in one basin." Embedding diversity is the diversity forcing function.

**Research anchor:** `.research/synthesis-prompt-patterns` — "Distribution flatness (code) is the hackathon BALD proxy." Embedding diversity is the second half — BALD says probe WHERE uncertainty is high, diversity says probe DIFFERENTLY from what's already in the queue.

**Demo contract #3:** "The next facades clearly respond to previous choices." Diversity ensures each facade tests a DIFFERENT gap. Without it, the user sees three variations on the same question — looks broken.

### Latency Impact

`text-embedding-004` is fast (~50-100ms per embed). One embed per generated facade + one cosine comparison against ~10 stored embeddings. Total added latency per facade: ~100ms. Negligible against the 1-4s `generateText` call.

### Gotchas

- `text-embedding-004` may not be available on the hackathon AI Studio account. Fallback: use `gemini-2.5-flash` with a short "rate similarity 0-10" prompt (~200ms). Worse but works.
- Embedding dimension for `text-embedding-004` is 768. Storing 30 embeddings × 768 floats = ~90KB. Negligible.
- Don't embed image prompt text — it's too long and structured. Embed `hypothesis + label` only (~20-50 tokens).
- Clear `facadeEmbeddings` on session reset.
- Max 2 retries on diversity rejection — don't let the scout loop stall. After 2 retries, accept the facade anyway (some redundancy is better than no facade).

### Files

| File | Action | ~LOC |
|------|--------|------|
| `src/lib/server/agents/scout.ts` | Edit | +30 |
| `src/lib/server/context.ts` | Edit | +5 (facadeEmbeddings map + reset) |

### Acceptance Criteria

- [ ] Scout embeds each generated facade's hypothesis + label
- [ ] Facade with cosine similarity > 0.85 to any queued/recent facade is rejected and regenerated
- [ ] Max 2 diversity retries before accepting the facade anyway
- [ ] `facadeEmbeddings` is cleared on session reset
- [ ] Embedding latency does not visibly delay facade generation (< 200ms overhead)
- [ ] If embedding model is unavailable, scout proceeds without diversity gate (graceful degradation)

### Dependencies

05-scout-words (scout loop must exist). No UI changes — diversity is invisible to the user, they just see better facades.

---

## Build Order

Both are independent. Recommended order:

1. **13a (streaming draft)** first — highest demo impact, directly visible to judges
2. **13b (embedding diversity)** second — invisible to user but makes the demo feel smarter

Either can be cut without affecting the other or the core demo.

---

## Timing

| Ticket | Estimate | Impact |
|--------|----------|--------|
| 13a streaming | ~30 min | High — "the prototype writes itself" |
| 13b diversity | ~20 min | Medium — prevents redundant probes |
