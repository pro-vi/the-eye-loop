# 08 — Scout Image + Mockup Stage Generation

## Summary
Extends the scout loop (05) with stage-specific model calls for images and mockups. The core while loop already works for words; this ticket adds model/prompt routing by context.stage. src/lib/server/agents/scout.ts (additions to existing file).

## Design
The scout reads context.stage at the top of each loop iteration and picks the appropriate model, prompt template, and output handling.

### Words (already done in 05)
- Model: google('gemini-2.5-flash')
- Output: Output.object() for metadata + text content
- Prompt: Scout system prompt section 2 (words rules)

### Images
- Model: google('gemini-2.5-flash-image')
- CRITICAL: providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:2', imageSize: '1K' } } }
- Without responseModalities: ['TEXT', 'IMAGE'], the model returns text only — no image output
- Extract result.files[] to get GeneratedFile objects. Convert to base64 data URL: `data:${file.mediaType};base64,${file.base64}`
- Store data URL in facade.imageDataUrl and facade.content (the image prompt text)
- Prompt: Scout system prompt section 2 with STAGE: images + IMAGE SCHEMA 7-field structure (SUBJECT, STYLE, LIGHTING, BACKGROUND, COMPOSITION, MANDATORY, PROHIBITIONS)
- Image notes from .research/synthesis-gemini-projects: reference images go FIRST in parts array, text prompt LAST. Each variation is a fresh stateless call, not multi-turn. Max 3 iterative edits before drift — rebuild prompt from scratch.
- Temperature: 1.0

### Mockups
- Model: google('gemini-2.5-flash')
- Output: HTML string (mobile viewport 375x667, inline styles, no scripts)
- Prompt: Scout system prompt section 2 with STAGE: mockups rules
- Store HTML in facade.content. Client renders via `<iframe srcdoc={facade.content} sandbox="">`
- Temperature: 1.0

### Stage routing
At the top of each scout iteration, read context.stage. Use if/switch to select:
- model identifier (flash vs flash-image)
- providerOptions (responseModalities only for images)
- prompt template section (words/images/mockups rules)
- output extraction logic (text vs files[] vs HTML string)

## Scope
### Files
- src/lib/server/agents/scout.ts (~100-120 LOC additions to existing file)

### Subtasks

## Image facade generation
Add an image generation branch to the scout loop. When context.stage === 'images': call generateText with google('gemini-2.5-flash-image'), providerOptions including responseModalities: ['TEXT', 'IMAGE'] and imageConfig: { aspectRatio: '3:2', imageSize: '1K' }. Build the image prompt using the IMAGE SCHEMA 7-field structure from specs/1-prompts.md: SUBJECT (from hypothesis/probe brief), STYLE (from resolved Anima), LIGHTING (quantified: "5500K natural"), BACKGROUND, COMPOSITION, MANDATORY (3-5 from resolved dimensions), PROHIBITIONS (3-5 from anti-patterns). Extract result.files[0] and convert to data URL. Construct Facade with imageDataUrl set and stage: 'images'. If result.files is empty, log error and retry once with a simplified prompt before continuing.

## Mockup facade generation
Add a mockup generation branch. When context.stage === 'mockups': call generateText with google('gemini-2.5-flash'). System prompt instructs generation of complete HTML+CSS for mobile viewport 375x667. Inline styles only, no external resources, no script tags. The HTML must be self-contained for srcdoc rendering. Store the HTML string in facade.content with stage: 'mockups'. Validate output contains an `<html>` or `<body>` tag; if not, wrap in minimal HTML boilerplate.

## Stage routing in scout loop
Refactor the scout loop body to dispatch by context.stage. Extract model selection, providerOptions construction, prompt building, and output extraction into a helper function or switch block. Ensure the loop structure (push facade, wait for swipe, update history) remains identical across all stages — only the generation call changes. Handle the transition case where stage changes mid-iteration (e.g., scout started generating for 'words' but stage advanced to 'images' before it finished): check stage after generation and before push — if stale, discard and regenerate.

### Acceptance criteria
- [ ] When context.stage === 'images', scout calls google('gemini-2.5-flash-image') with responseModalities: ['TEXT', 'IMAGE']
- [ ] Image facades contain a base64 data URL in facade.imageDataUrl that renders as an `<img>` tag
- [ ] When context.stage === 'mockups', scout calls google('gemini-2.5-flash') and generates an HTML string
- [ ] Mockup facades contain self-contained HTML in facade.content that renders in `<iframe srcdoc>`
- [ ] Stage routing selects the correct model and prompt for each stage without modifying the core loop structure
- [ ] If image generation returns no files, the scout retries once before continuing
- [ ] If stage changes mid-generation, the stale facade is discarded and a new one is generated for the current stage

### Dependencies
05-scout-words (core scout loop, local history, timeout/cleanup), 07-oracle (emits stage-changed events that update context.stage).
