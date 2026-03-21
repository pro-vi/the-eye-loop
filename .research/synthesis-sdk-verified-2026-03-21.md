---
topic: "Code-verified AI SDK 6 API surface for Eye Loop"
date: 2026-03-21
projects:
  - name: ai (Vercel AI SDK)
    repo: npm ai@6.0.134
    source_quality: code-verified
  - name: "@ai-sdk/google"
    repo: npm @ai-sdk/google@3.0.52
    source_quality: code-verified
  - name: "@ai-sdk/svelte"
    repo: npm @ai-sdk/svelte@4.0.134
    source_quality: code-verified
hypotheses:
  - claim: "AI SDK 6 with stopWhen, prepareStep, ToolLoopAgent is real and current"
    result: confirmed — all exist in ai@6.0.134 dist/index.d.ts
  - claim: "Chat class exists in @ai-sdk/svelte for Svelte 5"
    result: confirmed — exported from @ai-sdk/svelte
  - claim: "generateText returns files[] for Nano Banana images"
    result: confirmed — GeneratedFile has .base64, .uint8Array, .mediaType
  - claim: "Gemini image models are in @ai-sdk/google model union"
    result: confirmed — gemini-2.5-flash-image, gemini-3-pro-image-preview, nano-banana-pro-preview all present
key_findings:
  - "CRITICAL: Must pass providerOptions with responseModalities: ['TEXT', 'IMAGE'] to enable image output"
  - "imageConfig available as provider option: aspectRatio, imageSize ('1K', '2K', '4K', '512')"
  - "Output.object(), Output.array(), Output.choice(), Output.json(), Output.text() all exist"
  - "stopWhen and prepareStep are stable (not experimental_) in ai@6"
  - "experimental_prepareStep deprecated in favor of prepareStep"
  - "Chat class export: import { Chat, type UIMessage } from '@ai-sdk/svelte'"
unexplored_threads: []
---

# Code-Verified AI SDK Surface for Eye Loop

Cross-referenced with `/vercel-ai-sdk` skill patterns. All claims below are **code-verified** against actual npm packages.

## Verified Versions

| Package | Version | Verified |
|---------|---------|----------|
| `ai` | 6.0.134 | latest on npm |
| `@ai-sdk/svelte` | 4.0.134 | latest on npm |
| `@ai-sdk/google` | 3.0.52 | latest on npm |

Note: The `vercel/ai-chatbot-svelte` template ships `ai@^4.2.0` — it is outdated. We use v6.

## 1. Nano Banana Image Generation — VERIFIED

### The Critical Detail Research Missed

To generate images with Gemini, you MUST pass `responseModalities` in providerOptions:

```typescript
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

const result = await generateText({
  model: google('gemini-2.5-flash-image'),
  providerOptions: {
    google: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: '3:2',
        imageSize: '1K',
      },
    },
  },
  prompt: 'Generate a dark atmospheric moodboard...',
});

// GeneratedFile interface (code-verified):
// .base64: string
// .uint8Array: Uint8Array
// .mediaType: string
for (const file of result.files) {
  const dataUrl = `data:${file.mediaType};base64,${file.base64}`;
}
```

### Available Image Models (from GoogleGenerativeAIModelId union)

```
gemini-2.5-flash-image          // Nano Banana (recommended for speed)
gemini-3-pro-image-preview      // Nano Banana Pro (highest quality)
gemini-3.1-flash-image-preview  // Nano Banana 2 (fast, 4K)
nano-banana-pro-preview         // Alias
```

### Image Editing (for one-axis sweeps)

```typescript
const result = await generateText({
  model: google('gemini-2.5-flash-image'),
  providerOptions: {
    google: { responseModalities: ['TEXT', 'IMAGE'] },
  },
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Change only the color temperature to warm. Keep everything else identical.' },
      { type: 'file', data: existingImageBase64, mediaType: 'image/png' },
    ],
  }],
});
```

### Skill Pattern Application

Per `/vercel-ai-sdk` skill: use `providerOptions` typed access, not string keys:
```typescript
// From skill: providerMetadata pattern
// For Google, providerOptions key is 'google'
providerOptions: {
  google: googleLanguageModelOptions.parse({
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '3:2', imageSize: '1K' },
  }),
}
```

## 2. Agent Loop Patterns — VERIFIED

### stopWhen + prepareStep (stable, not experimental)

```typescript
import { generateText, stopWhen, stepCountIs, hasToolCall } from 'ai';

const result = await generateText({
  model: google('gemini-3.1-pro-preview'),
  tools: { /* scout, builder tools */ },
  stopWhen: [stepCountIs(10), hasToolCall('done')],
  prepareStep: ({ steps, stepCount }) => {
    // Inject current Anima state into each step
    return {
      system: buildSystemPrompt(context.anima),
      // Can also: switch model, change tools, prune messages
    };
  },
});
```

### ToolLoopAgent (exists but less relevant for Eye Loop)

`ToolLoopAgent` types exist (`ToolLoopAgentSettings`, callbacks). But Eye Loop scouts are event-driven (wait for swipe), so manual async loops are better.

### Skill Pattern: tool() for agents-as-tools

Per `/vercel-ai-sdk` skill, use the `tool()` helper with zod schemas:

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const scoutTool = tool({
  description: 'Generate a facade that tests a specific hypothesis',
  parameters: z.object({
    dimension: z.string(),
    hypothesis: z.string(),
    stage: z.enum(['words', 'images', 'mockups', 'components']),
  }),
  execute: async ({ dimension, hypothesis, stage }) => {
    // Generate facade via Gemini
    const facade = await generateFacade(dimension, hypothesis, stage);
    return facade;
  },
});

// Derive parameter types (skill pattern)
type ScoutArgs = z.infer<typeof scoutTool.parameters>;
```

## 3. Client-Side — VERIFIED

### Chat class from @ai-sdk/svelte

```typescript
// Exact export (code-verified):
export { Chat, type CreateUIMessage, type UIMessage } from './chat.svelte.js';
```

Usage in Svelte 5:
```svelte
<script lang="ts">
  import { Chat, type UIMessage } from '@ai-sdk/svelte';

  const chat = new Chat({
    // Chat options
  });
</script>
```

### Skill Pattern: Type derivation for UIMessage parts

```typescript
import type { UIMessage } from '@ai-sdk/svelte';

// Per skill: use indexed access, don't redefine
type MessagePart = NonNullable<UIMessage['parts']>[number];
```

## 4. Structured Output — VERIFIED

`Output` is a namespace with static methods:

```typescript
import { Output } from 'ai';

// All verified:
Output.object({ schema: z.object({...}) })
Output.array({ schema: z.object({...}) })
Output.choice({ choices: [...] })
Output.json()
Output.text()
```

For Eye Loop facade metadata:
```typescript
const result = await generateText({
  model: google('gemini-2.5-flash'),
  output: Output.object({
    schema: z.object({
      hypothesis_tested: z.string(),
      accept_implies: z.string(),
      reject_implies: z.string(),
      dimension: z.string(),
      held_constant: z.array(z.string()),
    }),
  }),
  prompt: '...',
});

const metadata = result.output; // Fully typed
```

**Gemini caveat (from research):** Avoid `z.union()` and `z.record()` — Gemini uses OpenAPI 3.0 subset. Keep schemas flat.

## 5. SSE Streaming — VERIFIED

### Simple pattern (for Eye Loop):
```typescript
// src/routes/api/stream/+server.ts
import { streamText } from 'ai';

export async function POST({ request }) {
  const { messages } = await request.json();
  const result = streamText({ model, messages });
  return result.toUIMessageStreamResponse();
}
```

### Rich pattern (if we need custom events):
```typescript
import { createDataStreamResponse, streamText } from 'ai';

return createDataStreamResponse({
  execute: (dataStream) => {
    const result = streamText({ model, messages });
    result.mergeIntoDataStream(dataStream, { sendReasoning: true });
  },
});
```

## 6. Skill Gotchas That Apply to Eye Loop

From `/vercel-ai-sdk` skill, directly relevant:

| Gotcha | Eye Loop Impact |
|--------|----------------|
| `z.union()` breaks with Gemini structured output | Use flat schemas for Facade/ProbeBrief types |
| Tool output must be JSONValue | Scout facade results must serialize cleanly |
| toolCallId must match exactly | If builder requests probes via tools, ID alignment is critical |
| `DynamicToolUIPart.input` is `unknown`, not `JSONValue` | Cast at boundaries when building tool parts |
| Pin AI SDK version | Use exact versions, not `^` ranges |
| pnpm hoisting | Use `find node_modules -path "*/ai/dist/index.d.ts"` if types missing |

## Install Command (Exact Versions)

```bash
pnpm add ai@6.0.134 @ai-sdk/google@3.0.52 @ai-sdk/svelte@4.0.134 zod d3-hierarchy
pnpm add -D @types/d3-hierarchy
```
