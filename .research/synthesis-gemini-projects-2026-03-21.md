---
topic: "Open-source projects pushing Gemini hard — patterns for Eye Loop"
date: 2026-03-21
projects:
  - name: google-gemini/gemini-cli
    repo: github.com/google-gemini/gemini-cli
    source_quality: code-verified
  - name: kingbootoshi/nano-banana-2-skill
    repo: github.com/kingbootoshi/nano-banana-2-skill
    source_quality: code-verified
  - name: minimaxir/gemimg
    repo: github.com/minimaxir/gemimg
    source_quality: code-verified
hypotheses:
  - claim: "Projects pushing Gemini hardest have discovered patterns not in official docs"
    result: confirmed — grid generation (50% cheaper), Google Search grounding for free, WEBP input encoding, reference-image-first ordering
  - claim: "Multi-turn image editing chains have practical failure modes we should learn from"
    result: confirmed — gemimg explicitly rejects multi-turn ("unclear if better"), recommends stateless per-edit calls. Style transfer via prompt does NOT work — must use reference images.
  - claim: "There are open-source Gemini agent projects using tool calling + image gen together"
    result: confirmed — Gemini CLI has full tool calling architecture with parallel execution, but does NOT combine it with image generation
key_findings:
  - "Grid generation: 2x2 or 4x4 variations in ONE API call, then slice — 50% cheaper per image"
  - "Google Search grounding: tools: [{ googleSearch: {} }] — free, grounds generation in real references"
  - "Style transfer via text prompt does NOT work — must use reference images for style consistency"
  - "Reference images go FIRST in parts array, text prompt LAST"
  - "Stateless editing beats multi-turn — each variation is a fresh call with reference image"
  - "Gemini CLI uses parallel tool execution — batch all tool calls, execute simultaneously"
  - "ModelVisibleError pattern — choose whether errors route to the LLM or the user"
  - "Temperature=0 for analysis tasks, default (1.0) for generation"
  - "Flash image output costs ~$60/1M tokens (~$0.04-0.07 per image at 1K)"
unexplored_threads:
  - "Gemini CLI's prompt snippet architecture for modular system prompt composition"
  - "gemimg's WEBP encoding for smaller input payloads"
  - "Nano Banana green screen pipeline (FFmpeg + ImageMagick) for transparency"
---

# Gemini Projects Research — Patterns for Eye Loop

## What We Studied

| Project | What it is | Size | Gemini depth |
|---------|-----------|------|--------------|
| **gemini-cli** | Google's official terminal agent | 2446 files | Deep — tool calling, streaming, multi-model, prompt composition |
| **nano-banana-2-skill** | Image gen CLI + Claude Code plugin | 39 files | Deep — Nano Banana image gen, reference images, style transfer, cost tracking |
| **gemimg** | Lightweight Python image gen/edit wrapper | 84 files | Focused — image gen + editing, grid generation, controlled variation |

## Patterns to Steal

### 1. Grid Generation for One-Axis Sweeps (gemimg)

**The single most cost-effective pattern found.** Instead of making 4 separate API calls for 4 variations, generate a 2x2 grid in ONE call and slice it:

```python
# gemimg pattern (gemimg/grid.py:15-99)
prompt = """
Generate a 2x2 contiguous grid of 4 distinct images,
maintaining the same composition across all 4:
- Top-left: warm color temperature
- Top-right: cool color temperature
- Bottom-left: neutral
- Bottom-right: split warm/cool
"""
# One API call → slice into 4 images
```

**Eye Loop application:** When a scout needs to probe a dimension (e.g., color temperature), generate a 2x2 grid of variations in one call. Show each quadrant as a separate swipeable facade. **50% cheaper, potentially faster** than 4 sequential calls.

**Caveat:** Only works with Pro models (`gemini-3-pro-image-preview`). Flash doesn't support grid output. For hackathon, may not be worth the added complexity of grid slicing.

### 2. Reference Images First, Text Last (nano-banana)

The message `parts` array order matters:

```typescript
// nano-banana pattern (src/cli.ts:533-556)
const parts = [];

// Reference images FIRST
for (const imgPath of options.referenceImages) {
  const imageData = await loadImageAsBase64(imgPath);
  parts.push({ inlineData: imageData });
}

// Text prompt LAST
parts.push({ text: finalPrompt });

const contents = [{ role: "user", parts }];
```

**Eye Loop application:** When doing one-axis sweeps, pass the accepted reference image FIRST, then the variation instruction. This gives Gemini visual context before the text instruction, improving style consistency.

### 3. Style Transfer via Reference Images, NOT Prompts (gemimg)

**Critical finding:** gemimg's README explicitly states style transfer via text ("make it Ghibli") **does not work** — the model ignores such commands. You must generate fresh or use reference images.

```
# DOES NOT WORK:
"Transform this image into Studio Ghibli style"

# DOES WORK:
Pass reference image + "Generate in the style of the reference image"
```

**Eye Loop application:** For our one-axis sweeps, don't try to describe style in text. Pass the accepted facade as a reference image and instruct only the axis change. The reference carries the style; the text carries the variation.

### 4. Stateless Editing > Multi-Turn (gemimg)

gemimg explicitly rejects multi-turn image editing:

> "gemimg intentionally does not support true multiturn conversations within a single conversational thread as: 1) The technical lift would no longer make this package lightweight, 2) It is unclear if it's actually better."

Each edit is a fresh `generateContent` call with the previous output image passed as input. No conversation history. No drift accumulation from turn management.

**Eye Loop application:** Each scout facade generation should be a fresh `generateText` call. Don't try to maintain a multi-turn image conversation. Pass the Anima state in the system prompt and any reference image as inline data. Stateless = simpler + no drift.

### 5. Google Search Grounding — Free (nano-banana)

```typescript
// nano-banana pattern (src/cli.ts:508-512)
const config = {
  responseModalities: ["IMAGE", "TEXT"],
  imageConfig,
  tools: [{ googleSearch: {} }],  // FREE grounding
};
```

**Eye Loop application:** When generating facades for concrete concepts (e.g., "portfolio site for architect"), Google Search grounding could help Gemini produce more realistic, reference-informed images. This is free and adds one line to the config. Worth trying, especially for mockup-stage facades.

### 6. Parallel Tool Execution (gemini-cli)

```
// gemini-cli pattern (coreToolScheduler.ts)
1. Model returns multiple functionCall parts
2. Scheduler validates all params
3. Execute ALL tools in parallel (Promise.all)
4. Batch results as functionResponse array
5. Send all results back in one message
```

**Eye Loop application:** When the orchestrator dispatches work to multiple scouts, use parallel execution. If using `generateText` with tools, the AI SDK already handles this via its agent loop. But for our manual scout loops, we should `Promise.all` the concurrent scout iterations.

### 7. ModelVisibleError Pattern (gemini-cli)

```typescript
// gemini-cli pattern (tool.ts)
class ModelVisibleError extends Error { /* ... */ }

// Tool execution:
if (sendErrorsToModel || error instanceof ModelVisibleError) {
  return { llmContent: errorMsg };  // Model sees error, can retry
} else {
  throw error;  // User sees, model doesn't
}
```

**Eye Loop application:** When a scout's facade generation fails (content filter, rate limit, etc.), route the error BACK to the scout so it can retry with a different approach, instead of crashing the loop. This is especially useful for image generation which can hit safety filters.

### 8. Temperature Discipline (gemini-cli)

Gemini CLI uses **different temperature settings for different task types**:

- **Analysis/vision:** `temperature: 0, topP: 0.95` (deterministic)
- **Generation:** `temperature: 0.7, topP: 0.95` (creative)
- **Tool calling:** default settings

**Eye Loop application:**
- **Orchestrator** (analyzing Anima, deciding what to probe): `temperature: 0`
- **Builder** (identifying construction ambiguities): `temperature: 0`
- **Scouts** (generating creative facades): `temperature: 1.0` (Gemini default)
- **Compaction** (merging evidence): `temperature: 0`

### 9. Prompt Composition Architecture (gemini-cli)

```
// gemini-cli pattern (promptProvider.ts)
Preamble → Core Mandates → Skills → Workflows → Guidelines → Memory

Each section is conditional:
- Skills only if skills exist
- Memory only if hierarchical memory enabled
- Mode-specific (interactive vs non-interactive)

Can be overridden entirely via custom file (env var)
```

**Eye Loop application:** Our scout/builder/orchestrator system prompts should follow this pattern:
1. **Preamble** — role identity ("You are a Scout agent in The Eye Loop")
2. **Mandates** — non-negotiable rules ("Never generate facades that please; generate facades that DISCRIMINATE")
3. **Context** — current Anima state (YAML serialized)
4. **Brief** — probe brief from builder, or self-assignment instructions
5. **Constraints** — held-constant dimensions, prohibited patterns

## Comparison: How They Use Gemini vs How We Will

| Capability | Gemini CLI | Nano Banana | gemimg | Eye Loop (planned) |
|-----------|-----------|-------------|--------|-------------------|
| Image generation | No | Yes (Nano Banana) | Yes (Nano Banana) | Yes (Nano Banana) |
| Image editing | No | Via reference images | Via stateless re-generation | Via reference + variation prompt |
| Structured output | No (text only) | No | No | Yes (Output.object for facade metadata) |
| Tool calling | Yes (full loop) | No | No | Yes (agents-as-tools for orchestrator) |
| Multi-agent | No (single agent) | No | No | Yes (scouts + builder + orchestrator) |
| Streaming | Yes (all calls) | No | No | Yes (SSE to client) |
| Image + text output | No | Yes | Yes | Yes (facade content + hypothesis metadata) |
| Google Search grounding | Yes (as tool) | Yes (in config) | No | Should add |
| Multi-turn images | No | No | Explicitly rejected | No (stateless per-facade) |
| Grid generation | No | No | Yes (2x2, 4x4) | Maybe (Pro only, stretch goal) |
| Cost tracking | No | Yes (per-token) | No | Should add for monitoring |

## Gap Analysis

| What they have | What we have | Action |
|---------------|-------------|--------|
| Google Search grounding | Not planned | **Add** — one line, free, improves mockup realism |
| Cost tracking per image | Not planned | **Add** — simple logging, useful for monitoring burn rate |
| ModelVisibleError routing | Not planned | **Add** — critical for scout retry on content filter hits |
| Temperature per task type | Not planned | **Add** — 0 for analysis, 1.0 for generation |
| Grid generation | Not planned | **Skip for hackathon** — Pro only, adds slicing complexity |
| WEBP input encoding | Not planned | **Skip** — minor optimization, not worth the complexity |
| Session persistence to disk | Not planned | **Skip** — demo is 3 minutes, no need |

## Validated Directions

Things we're already planning that these projects independently converged on:

1. **Stateless per-call image editing** — gemimg explicitly validates this over multi-turn
2. **Reference images for consistency** — nano-banana relies on this, not text-based style control
3. **Base64 inline data** — all three use this, not file uploads
4. **Manual agent loops** — gemini-cli's loop is while-based with explicit stop conditions, not framework magic
5. **Prompt composition from sections** — gemini-cli's modular approach matches our planned YAML Anima injection

## Differentiation to Preserve

Things we do that none of these projects attempt:

1. **Multi-agent concurrent generation** — none have parallel agents
2. **Structured output alongside image generation** — combining `Output.object()` with `responseModalities: ['TEXT', 'IMAGE']`
3. **Hypothesis-driven generation** — facades test hypotheses, not fulfill requests
4. **Latency as signal** — reaction time informing the preference model
5. **Builder-driven probes** — construction-grounded uncertainty, not abstract exploration
