# Model Architecture — The Eye Loop

Three-tier model architecture: fast generator, image renderer, slow oracle.

---

## Model Roster

| Tier | Model ID | Display Name | Role | Latency | Context |
|------|----------|-------------|------|---------|---------|
| Generator | `gemini-3.1-flash-lite-preview` | 3.1 Flash Lite | Scout text/HTML, Builder, Compaction | 1-5s | 1M in / 65K out |
| Renderer | `gemini-3.1-flash-image-preview` | Nano Banana 2 | Image facade generation | ~21s | 65K in / 65K out |
| Oracle | `gemini-3.1-pro-preview` | 3.1 Pro | Fract detection, stuck detection, quality gate | 18-25s | 1M in / 65K out |

## Tier Responsibilities

### Generator (Flash Lite 3.1)

Called on every swipe cycle. Must stay under 5s for demo feel.

- **Scout word facades** — single words/phrases, ~1.2s
- **Scout image SCHEMA prompts** — 7-field structured prompts for Renderer, ~2.6s
- **Scout HTML mockups** — complete HTML+CSS (375x667 mobile), ~4.5s
- **Builder updates** — integrate swipe results, emit probe briefs, ~1.9s
- **Compaction** — rewrite Anima YAML every 5 swipes, ~1.7s

### Renderer (Nano Banana 2)

Called when Generator produces an IMAGE SCHEMA prompt. Pre-buffered in facade queue.

- Image generation via `generateText()` with `providerOptions.google.responseModalities: ['TEXT', 'IMAGE']`
- Returns `result.files[]` with base64 PNG/JPEG
- Output: UI moodboards, color swatches, typography samples, component previews
- ~21s latency — acceptable because queue pre-buffers 3-5 facades ahead

### Oracle (3.1 Pro)

Called rarely (every 5-10 swipes) for high-stakes decisions. Runs in background.

- **Fract detection** — when a dimension resolves, propose grounded child axes from local evidence
- **Stuck detection** — info gain declining, decide: shift stage / broaden / reveal / reframe
- **Quality gate** — sanity check compacted Anima every ~10 swipes (optional, cut if needed)

## Why Not Other Models

Benchmarked on 2026-03-21 against actual prompt patterns from `1-prompts.md`.

| Model | Verdict | Reason |
|-------|---------|--------|
| `gemini-2.5-flash` | Skip | 10-43s (thinking overhead), no quality gain over Flash Lite |
| `gemini-2.5-pro` | Skip | 15-24s, only won Image SCHEMA (67% → 100%) — fixable with Zod schemas |
| `gemini-2.5-flash-image` (NB OG) | Backup | 3x faster (6s) but blurry/artistic output, less useful for UI facades |
| `gemini-3-pro-image-preview` (NB Pro) | Skip | Same speed as NB2, photorealistic style less useful for UI |
| `gemini-3-flash-preview` | Skip | 54s latency — unusable |

## Environment

```env
# .env
GEMINI_API_KEY=...          # AI Studio key
# Aliased at runtime:
# process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY
```

## Code Pattern

```typescript
import { google } from '@ai-sdk/google';

// Generator — all text tasks
const generator = google('gemini-3.1-flash-lite-preview');

// Renderer — image facades only
const renderer = google('gemini-3.1-flash-image-preview');

// Oracle — rare background decisions
const oracle = google('gemini-3.1-pro-preview');
```

Image generation pattern:
```typescript
const result = await generateText({
  model: renderer,
  prompt: imageSchemaPrompt,
  providerOptions: {
    google: { responseModalities: ['TEXT', 'IMAGE'] },
  },
});
// result.files[0].base64, result.files[0].mediaType
```

## Rate Limits (AI Studio Free)

| Model | RPM | TPM | RPD |
|-------|-----|-----|-----|
| 3.1 Pro | 2K | 8M | Unlimited |
| 3.1 Flash Lite | 30K | 30M | Unlimited |
| Nano Banana 2 | 5K | 10M | 50K |

No rate concerns for single-user demo. Flash Lite has the most generous limits.

## Temperature Discipline

Different tasks need different temperature settings (validated by gemini-cli project patterns):

| Tier | Temperature | Why |
|------|------------|-----|
| Generator (scouts) | `1.0` (default) | Creative facade generation needs diversity |
| Generator (builder) | `0` | Analytical — identifying construction blockers |
| Generator (compaction) | `0` | Deterministic — merging/pruning evidence |
| Renderer (NB2) | `1.0` (default) | Creative image generation |
| Oracle | `0` | Analytical — fract detection, stuck decisions |

## Renderer Patterns (from research)

Patterns validated by nano-banana-2-skill and gemimg projects:

1. **Reference images go FIRST in parts array, text prompt LAST.** Gemini uses visual context before text instruction — improves style consistency for one-axis sweeps.

2. **Style transfer via text prompt does NOT work.** "Make it warmer" is unreliable. Pass the accepted facade as reference image + instruct only the axis change.

3. **Stateless editing is MANDATORY, not just preferred.** Multi-turn conversation history with NB2 fails with `thought_signature` error — AI SDK does not handle this. Each facade MUST be a fresh `generateText` call with reference image as `type: 'file'` in a single user message. Never pass assistant-generated images back in conversation history.

4. **Google Search grounding: skip.** Benchmarked — adds ~7s latency to image gen with no quality improvement. Same for HTML mockups. Not worth it.

5. **Max 3 iterative edits on same reference before rebuilding prompt from scratch** — drift accumulates.

6. **One-axis sweeps work.** NB2 cleanly isolates single-axis changes (palette, shape, density) while preserving all other properties. Reference-first ordering confirmed effective.

Image editing (one-axis sweep):
```typescript
const result = await generateText({
  model: renderer,
  providerOptions: {
    google: { responseModalities: ['TEXT', 'IMAGE'] },
  },
  messages: [{
    role: 'user',
    content: [
      // Reference image FIRST
      { type: 'file', data: existingBase64, mediaType: 'image/png' },
      // Variation instruction LAST
      { type: 'text', text: 'Change only the color temperature to warm golden. Keep everything else identical.' },
    ],
  }],
});
```

## Verified: Structured Output + Image Gen

`Output.object()` + `responseModalities: ['TEXT', 'IMAGE']` **work together in a single call.** NB2 returns both typed metadata and image files. No need for two-call split.

```typescript
const result = await generateText({
  model: renderer,
  output: Output.object({
    schema: z.object({
      hypothesis_tested: z.string(),
      accept_implies: z.string(),
      reject_implies: z.string(),
      dimension: z.string(),
      held_constant: z.array(z.string()),
    }),
  }),
  providerOptions: {
    google: { responseModalities: ['TEXT', 'IMAGE'] },
  },
  prompt: facadePrompt,
});
// result.output → typed metadata
// result.files[0] → image
```

Note: without `Output.object()`, NB2 may return no text at all — raw JSON-in-text parsing is unreliable. Always use structured output for metadata.

## Fallback Model IDs

If a preview model breaks during demo, hot-swap by changing one string:

| Tier | Primary | Fallback | Trade-off |
|------|---------|----------|-----------|
| Generator | `gemini-3.1-flash-lite-preview` | `gemini-2.5-flash` | 1-5s → 10-40s (thinking overhead) |
| Renderer | `gemini-3.1-flash-image-preview` | `gemini-2.5-flash-image` | 21s → 6s, lower quality |
| Oracle | `gemini-3.1-pro-preview` | `gemini-2.5-pro` | Similar latency, less capable |
