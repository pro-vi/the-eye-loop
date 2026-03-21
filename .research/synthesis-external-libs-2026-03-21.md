---
topic: "External libraries and repos for Eye Loop hackathon build"
date: 2026-03-21
projects:
  - name: Vercel AI SDK
    repo: github.com/vercel/ai
    source_quality: doc-stated
  - name: "@ai-sdk/google"
    repo: npm @ai-sdk/google
    source_quality: doc-stated
  - name: svelte-gestures
    repo: github.com/Rezi/svelte-gestures
    source_quality: doc-stated
  - name: d3-hierarchy
    repo: npm d3-hierarchy
    source_quality: code-verified
  - name: Gemini Image Gen (Nano Banana)
    repo: Google AI Studio API
    source_quality: doc-stated
hypotheses:
  - claim: "Vercel AI SDK has multi-agent orchestration patterns we can use directly"
    result: partially confirmed — agents-as-tools pattern exists, but no shared state primitive. We roll our own EyeLoopContext.
  - claim: "There's a lightweight swipe gesture library that works with Svelte 5"
    result: confirmed — svelte-gestures v5 is Svelte 5 native with runes, or ~50 lines custom PointerEvent code
  - claim: "Tree visualization can be done with plain SVG rather than D3"
    result: confirmed — d3-hierarchy (136KB) for layout math + Svelte SVG rendering is ideal. Pure CSS (Treeflex) as fallback.
key_findings:
  - "Nano Banana image gen uses generateText(), NOT generateImage() — critical API difference"
  - "AI SDK 6 uses stopWhen (not maxSteps) and prepareStep for dynamic agent loops"
  - "@ai-sdk/svelte uses Chat class (not hooks) for Svelte 5"
  - "No maintained Tinder-card library exists — build custom with svelte-gestures or PointerEvents"
  - "Sandboxed iframes need just <iframe srcdoc={html} sandbox=''> — no library needed"
  - "Gemini structured output works but z.union() is NOT supported — keep schemas flat"
unexplored_threads:
  - "fal.ai as multi-model image gateway fallback"
  - "LayerChart Svelte 5 hierarchy components as alternative to d3-hierarchy + hand-rolled SVG"
  - "Vercel Sandbox for secure code execution in later facade stages"
---

# External Libraries Synthesis for The Eye Loop

## Decision Table

| Need | Decision | Package | Size | Why |
|------|----------|---------|------|-----|
| AI orchestration | Vercel AI SDK 6 | `ai`, `@ai-sdk/google`, `@ai-sdk/svelte` | core deps | Agents-as-tools, `stopWhen`, `prepareStep`, SSE streaming, structured output |
| Image generation | Gemini Nano Banana via `generateText()` | `@ai-sdk/google` | (included above) | Native image gen + editing in one model. 500 img/day free via AI Studio |
| Swipe gestures | Custom PointerEvent handler (~50 lines) | none | 0 KB | Full control over reaction-time capture. `performance.now()` for sub-ms precision |
| Swipe gestures (alt) | svelte-gestures v5 | `svelte-gestures` | ~5 KB | Svelte 5 native, `use:swipe` action. Good if we want pinch/rotate later |
| Anima tree viz | d3-hierarchy + Svelte SVG | `d3-hierarchy` | 136 KB | Layout math only — we render with Svelte `{#each}` + `tweened()` for animation |
| Anima tree viz (simple) | Treeflex CSS | `treeflex` | 45 KB | Pure CSS tree. Zero JS. Good enough for MVP |
| HTML mockup preview | Native `<iframe srcdoc sandbox="">` | none | 0 KB | No library needed. Fixed viewport (375x812) for swipe cards |
| Styling | Tailwind CSS | `tailwindcss` | core dep | Already decided |

## Total new dependencies: 3-4 packages

```
pnpm add ai@6.0.134 @ai-sdk/google@3.0.52 @ai-sdk/svelte@4.0.134 zod d3-hierarchy
pnpm add -D @types/d3-hierarchy
```

Optional (if we want gesture library instead of custom):
```
pnpm add svelte-gestures
```

> **UPDATED:** Versions pinned after code verification (see synthesis-sdk-verified-2026-03-21.md).

---

## 1. Vercel AI SDK — Agent Patterns

### What exists
- **Agents-as-tools**: Each scout/builder is a `tool()` wrapping a `generateText()` call. Orchestrator dispatches by calling tools.
- **`stopWhen`** (SDK 6): Replaces `maxSteps`. Built-in: `stepCountIs(n)`, `hasToolCall('name')`. Custom: function receiving `{ steps }`.
- **`prepareStep`**: Runs before each iteration. Can switch models, prune context, change tools, modify system prompt. Perfect for scouts that adapt based on Anima state.
- **Streaming**: `streamText()` + `.toUIMessageStreamResponse()` → SSE response. Client: `new Chat({})` from `@ai-sdk/svelte`.
- **Structured output**: `Output.object({ schema: z.object({...}) })` works with Gemini. **Avoid `z.union()` and `z.record()`** — Gemini uses OpenAPI 3.0 subset.

### What doesn't exist
- **No shared state bus.** Each `generateText` call is independent. We build `EyeLoopContext` as our own server-side shared state.
- **No built-in agent registry/lifecycle.** Spawning, retiring, monitoring agents is our job.
- **No multiplexed streaming.** Multiple concurrent agents need either multiple SSE connections or custom event multiplexing.

### Architecture mapping to Eye Loop

| AI SDK Concept | Eye Loop Use |
|---|---|
| `generateText` + `stopWhen` | Scout loop (generate facade, wait for swipe, decide next) |
| `prepareStep` | Inject current Anima state into scout's context each step |
| `tool()` wrapping `generateText` | Builder/scout as tools the orchestrator can invoke |
| `Output.object()` | Typed Facade, ProbeBrief responses from Gemini |
| `streamText` + SSE | Stream agent status + facade updates to client |
| `Chat` class (`@ai-sdk/svelte`) | Client-side message/stream management |
| Tool without `execute` | "done" signal to stop agent loop |

### Key gotcha
The scout loop in the spec is **event-driven** (wait for swipe result), not purely LLM-step-driven. The AI SDK's `stopWhen` loop works when the LLM drives the loop. For our case, each scout iteration is:

1. Generate facade (one `generateText` call)
2. Push to queue, wait for swipe event (external, not LLM-driven)
3. Receive result, update local state
4. Loop

This means scouts are better modeled as **manual async loops** calling `generateText` per iteration, NOT as a single `generateText` with `stopWhen`. The AI SDK agent loop is more useful for the orchestrator (multi-step reasoning with tools) and builder (multi-step assembly).

---

## 2. Gemini Image Generation (Nano Banana)

### Critical API pattern (CODE-VERIFIED against ai@6.0.134, @ai-sdk/google@3.0.52)

Nano Banana is NOT accessed via `generateImage()`. It uses `generateText()` with a model that can output images.

**CRITICAL:** Must pass `responseModalities: ['TEXT', 'IMAGE']` in providerOptions to enable image output. Without this, model returns text only.

```typescript
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

const result = await generateText({
  model: google('gemini-2.5-flash-image'),
  providerOptions: {
    google: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: '3:2',  // also: '1:1', '9:16', '16:9', etc.
        imageSize: '1K',     // also: '512', '2K', '4K'
      },
    },
  },
  prompt: 'Generate a dark atmospheric moodboard...',
});

// GeneratedFile interface (code-verified):
//   .base64: string
//   .uint8Array: Uint8Array
//   .mediaType: string
for (const file of result.files) {
  if (file.mediaType.startsWith('image/')) {
    const dataUrl = `data:${file.mediaType};base64,${file.base64}`;
  }
}
```

### Image editing (one-axis sweep)
Feed an existing image back with edit instructions. Use `type: 'file'` (not `type: 'image'`):

```typescript
const result = await generateText({
  model: google('gemini-2.5-flash-image'),
  providerOptions: {
    google: { responseModalities: ['TEXT', 'IMAGE'] },
  },
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Change only the color temperature to warm golden hour. Keep everything else identical.' },
      { type: 'file', data: existingImageBase64, mediaType: 'image/png' }
    ]
  }]
});
```

### Available models (March 2026)

| Model | Use for | Notes |
|---|---|---|
| `gemini-2.5-flash-image` | Scout image facades | Nano Banana. Fast, 500/day free |
| `gemini-3.1-flash-image-preview` | Higher quality images | Nano Banana 2. 4K. Preview |
| `gemini-3.1-pro-preview` | Orchestrator, builder, compaction | Text only. Latest Pro |
| `gemini-2.5-flash` | Scout HTML/text facades | Fast, cheap text gen |
| `imagen-4.0-generate-001` | Alt image gen (via `generateImage`) | No editing capability |

### Quota
- Free tier: ~500 requests/day for flash-image, ~15 RPM
- Hackathon account likely has elevated quota
- 500 images is plenty for dev + demo

---

## 3. Swipe Gesture UI

### Recommendation: Custom PointerEvent handler

For maximum control over reaction-time measurement and zero dependency overhead:

```
pointerdown → record startTime via performance.now()
pointermove → update card transform (translateX + rotate)
pointerup → threshold check (|deltaX| > 30% width), emit accept/reject + latencyMs
```

Key details:
- `touch-action: none` on card element to prevent scroll interference
- `element.setPointerCapture(e.pointerId)` to keep tracking
- CSS transitions for snap-back (cancel) and fly-off (commit) animations
- Card stack: `position: absolute` + `z-index` + `scale(0.95)` offset for depth

### Alternative: svelte-gestures v5
- `use:swipe` action, Svelte 5 native with runes
- Less control over exact timing measurement
- Good if we want other gestures later (pinch for Anima tree zoom?)

### Card stack CSS pattern
```css
.card { position: absolute; transition: transform 0.3s ease-out; }
.card:nth-child(2) { transform: scale(0.95) translateY(10px); }
.card:nth-child(3) { transform: scale(0.9) translateY(20px); }
.swiped-right { transform: translateX(150%) rotate(15deg); opacity: 0; }
.swiped-left { transform: translateX(-150%) rotate(-15deg); opacity: 0; }
```

---

## 4. Anima Tree Visualization

### Recommendation: d3-hierarchy + Svelte SVG

`d3-hierarchy` provides ONLY the layout math (no DOM manipulation). We render with Svelte:

```
d3.tree() → assigns (x, y) to each node
Svelte {#each} → renders <circle>, <line>, <text> in <svg>
tweened() stores → smooth animation when tree grows (fracting)
```

Supports radial layout trivially (polar coordinate transform on the same data).

### Fallback: Treeflex (pure CSS)
- 45 KB, zero JS
- Nested `<ul>/<li>` with pseudo-element connectors
- Add Svelte `transition:slide` for new nodes
- Good enough for MVP, upgrade to SVG if time permits

### Animation
- `tweened()` from `svelte/motion` for smooth position interpolation
- Svelte `transition:scale` on new nodes for "fract" appearance
- Color-code nodes: green=resolved, amber=active, gray=pruned

---

## 5. Sandboxed Iframe for HTML Mockups

**No library needed.** Native HTML:

```html
<iframe
  srcdoc={htmlString}
  sandbox=""
  style="width: 375px; height: 667px; border: none;"
/>
```

- `sandbox=""` (empty) = most restrictive. CSS renders, scripts blocked.
- If external fonts needed: `sandbox="allow-same-origin"`
- **NEVER** combine `allow-scripts` + `allow-same-origin` on AI-generated content
- Fixed viewport (375x667 mobile) for swipe cards — no auto-height needed
- For auto-height later: `postMessage` + `ResizeObserver` (~20 lines)

---

## Install Plan (pinned, code-verified)

```bash
pnpm add ai@6.0.134 @ai-sdk/google@3.0.52 @ai-sdk/svelte@4.0.134 zod d3-hierarchy
pnpm add -D @types/d3-hierarchy
```

Total added weight: minimal. AI SDK is the bulk. d3-hierarchy is 136KB unpacked.
No swipe library. No iframe library. No tree rendering library.

---

## Gap Analysis

| What we need | External solution? | Roll our own? |
|---|---|---|
| Multi-agent shared state | No SDK support | Yes — EyeLoopContext class |
| Event bus | No SDK support | Yes — simple EventEmitter or Svelte-style |
| Scout lifecycle (spawn/retire) | No SDK support | Yes — orchestrator logic |
| Swipe UI | Libraries exist but none ideal | Yes — ~50 lines PointerEvent |
| Card stack animation | CSS-only | Yes — pure CSS |
| Tree layout math | d3-hierarchy | No — use library |
| Tree rendering | Svelte SVG | Yes — ~80 lines Svelte |
| Iframe sandboxing | Native HTML | No code needed |
| Image generation | Gemini via AI SDK | No — use API |
| Image editing/variation | Gemini native | No — use API |
| SSE streaming | AI SDK + SvelteKit | Minimal glue code |
| Structured output | AI SDK Output.object() | No — use API |
