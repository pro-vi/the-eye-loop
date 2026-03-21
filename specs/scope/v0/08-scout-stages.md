# 08 — Scout Rendering Pipeline (Image + Mockup)

> **Akinator pivot active.** Read `specs/4-akinator.md` for architecture. Scout chooses format based on evidence depth + lens, NOT `context.stage`.

## Summary

Extends the scout loop (05) with a rendering pipeline. The scout already generates text probes for all formats. This ticket adds the rendering step: when `format === 'image'`, call NB2 to generate an actual image. When `format === 'mockup'`, ensure the scout generates renderable HTML.

Single file: `src/lib/server/agents/scout.ts` (~80 LOC additions).

## The Rendering Pipeline

The scout loop becomes:

```
1. Generate probe (Flash Lite, ~2s) → text description + metadata
2. IF format=image:  render via NB2 (~20s) → attach imageDataUrl to facade
3. IF format=mockup: content IS the HTML already (Flash Lite generates it)
4. Push facade to queue
5. Wait for swipe
```

The user swipes on VISUALS, not text descriptions:

| format | What user sees | Rendering step |
|--------|---------------|----------------|
| `word` | Text on card | None — content IS the facade |
| `image` | NB2-generated moodboard/icon/visual | NB2 call after probe generation |
| `mockup` | HTML rendered in iframe | None — content IS renderable HTML |

## Design

### Image Rendering

When the scout's `Output.object()` returns `format: 'image'`:

```typescript
import { createGoogleGenerativeAI } from '@ai-sdk/google';
const renderer = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
const IMAGE_MODEL = renderer('gemini-3.1-flash-image-preview');
```

After `generateText` returns the probe, before `pushFacade`:

```typescript
if (output.format === 'image') {
  const imgResult = await generateText({
    model: IMAGE_MODEL,
    providerOptions: {
      google: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '3:2', imageSize: '1K' },
      },
    },
    prompt: output.content,  // scout's text description becomes the image prompt
    abortSignal: signal,
  });

  if (imgResult.files?.length) {
    const file = imgResult.files[0];
    facade.imageDataUrl = `data:${file.mediaType};base64,${file.base64}`;
  }
  // If no image returned, facade still has text description as fallback
}
```

**Critical constraints** (from `specs/3-models.md`):
- MUST pass `responseModalities: ['TEXT', 'IMAGE']` — without it, NB2 returns text only
- Stateless only — NO multi-turn. Each image is a fresh call. `thought_signature` breaks multi-turn.
- `imageConfig: { aspectRatio: '3:2', imageSize: '1K' }` for speed. Use `'2K'` for quality if time permits.
- NB2 latency: ~20s. This is why pre-buffering matters — scouts should start generating image probes during the word stage so they're queued by swipe 4-5.

### Mockup Generation

When `format: 'mockup'`, the scout's Flash Lite call should already produce HTML. The format instruction in the prompt says "describe a concrete MOCKUP with layout details." But we need to ensure the output is **renderable HTML**, not a text description of a mockup.

Two-step approach:

1. The scout's `Output.object()` already returns `content` — check if it contains HTML tags
2. If content is a description (no `<div` or `<html`), make a second Flash Lite call to generate actual HTML:

```typescript
if (output.format === 'mockup' && !/<div|<html|<section/i.test(output.content)) {
  const htmlResult = await generateText({
    model: MODEL,  // Flash Lite
    prompt: `Generate complete HTML+CSS for this mockup description. Mobile viewport 375x667, inline styles only, no scripts.\n\nDescription: ${output.content}\n\nAnti-patterns (NEVER use): ${context.antiPatterns.join(', ')}`,
    maxTokens: 2000,
    abortSignal: signal,
  });
  // Extract HTML from response (may be in markdown code block)
  const htmlMatch = htmlResult.text?.match(/```html?\n?([\s\S]*?)```/);
  facade.content = htmlMatch ? htmlMatch[1] : htmlResult.text ?? output.content;
}
```

Client renders mockups via `<iframe srcdoc={facade.content} sandbox="">` with fixed 375x667 viewport.

### Format Dispatch

No `context.stage` routing. The scout already chooses format via `Output.object()` based on evidence depth + format instruction. This ticket just adds the rendering step after generation:

```typescript
// After generateText returns output, before pushFacade:

const facade: Facade = {
  id: crypto.randomUUID(),
  agentId,
  hypothesis: output.hypothesis,
  label: output.label,
  content: output.content,
  format: output.format,
};

// Rendering pipeline
if (output.format === 'image') {
  // NB2 call — ~20s
  const imgResult = await generateText({ ... });
  if (imgResult.files?.length) {
    facade.imageDataUrl = `data:${imgResult.files[0].mediaType};base64,${imgResult.files[0].base64}`;
  }
} else if (output.format === 'mockup' && !/<div|<html/i.test(output.content)) {
  // Ensure content is actual HTML, not a description
  const htmlResult = await generateText({ ... });
  facade.content = extractHtml(htmlResult.text) ?? output.content;
}

context.pushFacade(facade);
```

### Pre-buffering Strategy

Image facades take ~22s (2s probe + 20s NB2). Word facades take ~2s. The queue target is 3-5.

Pre-buffering happens naturally because scouts run continuously:
- Swipes 1-3: format floor = `word`, all scouts generate words fast (~2s each)
- At swipe 2-3: floor changes to `image` for next generation cycle
- Scouts that finish their word swipe start generating image probes immediately
- By swipe 4-5: first image facade should be in queue (started ~20s ago)

If queue runs dry during image transition, the oracle's queue pressure check will log it. Acceptable for V0 — user may see a brief "generating..." state.

### Error Handling

- If NB2 returns no files: keep the text description as fallback. The facade still has `content` with the image prompt text. Client shows text if `imageDataUrl` is absent.
- If NB2 hits content filter: log and continue. Don't crash the scout loop. The text description is the fallback.
- If mockup HTML generation fails: keep the description text. Client can show it as a card instead of an iframe.

## Scope

### Files
- `src/lib/server/agents/scout.ts` (~80 LOC additions)

### Subtasks

**Image rendering branch**
After `generateText` returns a probe with `format: 'image'`, call NB2 with `responseModalities: ['TEXT', 'IMAGE']` and `imageConfig`. Extract `result.files[0]` and set `facade.imageDataUrl` as a base64 data URL. If no files returned, log warning and keep text fallback.

**Mockup HTML validation**
After `generateText` returns a probe with `format: 'mockup'`, check if `content` contains HTML tags. If not, make a second Flash Lite call to convert the description into renderable HTML (375x667, inline styles, no scripts). Extract HTML from potential markdown code block wrapper.

**Renderer model setup**
Add NB2 model constant: `const IMAGE_MODEL = google('gemini-3.1-flash-image-preview')`. Import alongside existing Flash Lite model.

### Acceptance Criteria
- [ ] Image facades contain a base64 data URL in `facade.imageDataUrl` that renders as `<img>`
- [ ] Image generation uses `gemini-3.1-flash-image-preview` with `responseModalities: ['TEXT', 'IMAGE']`
- [ ] Mockup facades contain self-contained HTML in `facade.content` that renders in `<iframe srcdoc>`
- [ ] If NB2 returns no files, facade falls back to text description (no crash)
- [ ] If content filter blocks NB2, scout loop continues with next probe
- [ ] Scout loop structure unchanged — rendering is an inline step between generate and push

### Dependencies
05-scout-words (core scout loop), 07-oracle (concreteness floor determines when scouts start choosing image/mockup format).

### Models (from `specs/3-models.md`)
- Probe generation: `gemini-3.1-flash-lite-preview` (Flash Lite, ~2s)
- Image rendering: `gemini-3.1-flash-image-preview` (NB2, ~20s)
- Fallback renderer: `gemini-2.5-flash-image` (NB OG, ~6s, lower quality)
