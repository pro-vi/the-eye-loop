# The Eye Loop — Lean V0 Spec

## Zero to Agent: Vercel x DeepMind | March 21, 2026

**Status:** implementation contract for today
**Vision doc:** `specs/0-spec.md`
**Prompt doc:** `specs/1-prompts.md`
**Research:** `.research/synthesis-*.md` (SDK verification, prompt patterns, runtime, Gemini project patterns)

`0-spec.md` describes the full theory. This file defines the smallest version that still wins the live demo.

---

## One-Line Product Promise

The user types an intent, swipes through generated facades, watches a visible taste model form in real time, and sees a prototype draft evolve before the session ends.

If that works live, the product story lands.

---

## Demo Contract

The demo succeeds if all five of these are true:

1. The user can enter an intent and get the first facades quickly.
2. Every swipe visibly updates the Anima.
3. The next facades clearly respond to previous choices.
4. The UI shows named agents working in parallel or near-parallel.
5. A prototype pane starts changing before the final reveal.

Anything that does not improve one of those five outcomes is out of scope for V0.

---

## User Experience

1. The user enters a short product intent such as `weather app for runners`.
2. The server creates a session, seeds a small set of taste axes, starts the scout loops, and fills the first queue.
3. The user sees one facade at a time and swipes `accept` or `reject`.
4. Every facade shows a hypothesis, agent name, and stage-appropriate content.
5. Every swipe updates the queue, visible Anima, builder draft, and agent activity.
6. After roughly 8-12 swipes, the user can inspect a coherent draft prototype built from the current taste model.

---

## V0 Scope

### Must Ship

- intent input and session creation
- swipeable facade feed (custom PointerEvent handler, ~50 lines, `performance.now()` for sub-ms latency capture) `.research/synthesis-external-libs`
- SSE updates from server to client (native `ReadableStream` + `text/event-stream`, no library) `.research/synthesis-runtime`
- visible Anima panel
- named scout agents with live status
- evolving builder draft pane
- builder-authored next-question hint or probe focus
- queue buffering so the user is rarely waiting
- words stage
- image stage between words and mockups (Nano Banana generates in 1-3s at 1K — same scout loop, different model call) `.research/synthesis-gemini-projects`
- HTML mockup stage
- final reveal state

### Stretch

- simple latency buckets such as `fast` vs `slow`
- Google Search grounding for mockup stage (`tools: [{ googleSearch: {} }]` — free, one line) `.research/synthesis-gemini-projects`

### Explicitly Cut

- fract spawning
- child scouts
- agent retirement
- Anima compaction
- true BALD selection
- orthogonal axis discovery
- full builder-driven probe queue
- interactive snippet stage
- Veo or motion generation
- artifact assembly from multiple real code fragments

---

## Core Simplifications

| Vision Spec | Lean V0 | Research Basis |
|---|---|---|
| Hierarchical Anima tree | Flat axis list with confidence | Tree is the right structure but overkill for V0. Flat list + lowest-confidence selection approximates BALD. |
| BALD over tree | Pick lowest-confidence unresolved axis | Distribution flatness (code) is the hackathon BALD proxy. `.research/synthesis-prompt-patterns` |
| 3+ real scouts with spawning | 1-2 real loops, multiple visible identities if needed | Manual async while loops, not agents-as-tools. `.research/synthesis-external-libs` |
| Builder drives formal probe queue | Builder emits simple next-question hints | Construction-grounded hints are the V0 version of probe briefs. `.research/synthesis-prompt-patterns` |
| Continuous artifact assembly | Builder maintains a single evolving HTML draft | Same mechanism, simpler scope. |
| Words → images → mockups blending | Stage changes by swipe count (1-4 → 5-8 → 9-14) | Images promoted from stretch: Nano Banana is 1-3s. `.research/synthesis-gemini-projects` |
| Compaction and contradiction handling | Ignore for V0 | Between-compaction updates are code (distribution shifts), not LLM. |

These are implementation cuts, not product cuts.

---

## Runtime Architecture

### Deploy

Vercel with Fluid Compute (adapter-vercel, Node.js runtime). Fluid Compute shares a single instance across concurrent requests. SSE keeps the instance warm; POST requests route to the same warm instance. Module-level `EyeLoopContext` singleton persists in global state. For a single-user demo, this behaves like a persistent server. Set `maxDuration: 300` on long-lived routes. `.research/synthesis-runtime`

### Server

Use one server-side `EyeLoopContext` instance per session as a module-level singleton in `src/lib/server/context.ts`. Bootstrap agent loops in `hooks.server.ts` `init()`. Event bus via Node.js `EventEmitter` in `src/lib/server/bus.ts`. `.research/synthesis-runtime`

Context state:

- `intent`
- `swipeCount`
- `stage`
- `axes`
- `facades`
- `agents`
- `draft`
- `events`

SSE streams context events to the client.

### Client

The main page renders:

- intent entry
- swipe feed
- Anima panel
- prototype draft panel
- agent activity rail if space allows

### Agent Roles

#### Scout

Scouts generate facades against the current weakest axis. Manual async while loops — NOT a single `generateText` with `stopWhen`, because the swipe callback is external and event-driven. `.research/synthesis-external-libs`

Loop:

1. read current stage and weakest axis (lowest confidence in flat axis list)
2. generate one facade with a clear hypothesis via `generateText()`:
   - **words stage:** `google('gemini-2.5-flash')` with `Output.object()` for structured metadata `.research/synthesis-sdk-verified`
   - **images stage:** `google('gemini-2.5-flash-image')` with `providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } }` `.research/synthesis-sdk-verified`
   - **mockups stage:** `google('gemini-2.5-flash')` generating HTML string
3. push it into the queue
4. wait for its swipe result (EventEmitter subscription: `bus.once('swipe:${facade.id}', resolve)`)
5. update local status and continue

Temperature: `1.0` for scouts (creative generation). `.research/synthesis-gemini-projects`

Image facade notes: reference images go FIRST in parts array, text prompt LAST. Style transfer via text prompt does NOT work — must use reference images for consistency. Each variation is a fresh stateless call, not multi-turn. Max 3 iterative edits before drift; rebuild prompt from scratch. `.research/synthesis-gemini-projects`

#### Builder

The builder never creates swipe-facing facades. Temperature: `0` (deterministic analysis). `.research/synthesis-gemini-projects`

It updates the draft whenever a swipe arrives:

- on `accept`, reinforce the chosen direction
- on `reject`, add an anti-pattern constraint (PROHIBITIONS are more reliably followed than positive mandates — 94% vs 91% compliance in Gemini) `.research/synthesis-prompt-patterns`
- emit a lightweight next-question hint when the draft is blocked or ambiguous (construction-grounded: "I need to know if the header is fixed or scroll-away", not "layout axis unresolved") `.research/synthesis-prompt-patterns`
- after every few swipes, rewrite the draft to reflect the current taste profile

#### Orchestrator

The orchestrator is 80% code, 20% LLM in V0. Temperature: `0` when LLM is used. `.research/synthesis-gemini-projects`

It is responsible for:

- starting the initial workers
- keeping `3-5` facades buffered
- advancing stages by swipe count
- dropping obviously stale queued facades after major preference shifts

All of the above is pure code (if statements on context state), not LLM calls. LLM is only used if we get to compaction or fract detection (cut for V0).

---

## Data Contract

```ts
type Stage = 'words' | 'images' | 'mockups' | 'reveal';

interface TasteAxis {
  id: string;
  label: string;
  options: [string, string];  // binary split matches AMPLe halving .research/synthesis-prompt-patterns
  confidence: number;         // 0-1, lowest = most uncertain = probe next
  leaning?: string;
  evidenceCount: number;
}

interface Facade {
  id: string;
  agentId: string;
  stage: Stage;
  hypothesis: string;
  axisId: string;
  content: string;            // text | base64 data URL | HTML string
  imageDataUrl?: string;      // for image-stage facades
}

interface SwipeRecord {
  facadeId: string;
  agentId: string;
  axisId: string;
  decision: 'accept' | 'reject';
  latencyMs: number;
  latencyBucket?: 'fast' | 'slow';  // coarse bucket for V0
}

interface AgentState {
  id: string;
  name: string;
  role: 'scout' | 'builder' | 'orchestrator';
  status: 'idle' | 'thinking' | 'queued' | 'waiting';
  focus: string;
  lastFacadeId?: string;
}

interface PrototypeDraft {
  title: string;
  summary: string;
  html: string;
  acceptedPatterns: string[];
  rejectedPatterns: string[];   // these are PROHIBITIONS — more reliable than positive mandates .research/synthesis-prompt-patterns
  nextHint?: string;
}
```

`latencyMs` should be stored now. V0 buckets it coarsely: `fast` (below session median) vs `slow` (above). Slow cases are near the decision boundary — most valuable for learning, but V0 only stores, does not act on this. `.research/synthesis-prompt-patterns`

---

## Stage Rules

### Words

Swipes `1-4`. Use single words, short phrases, or tiny text cards to establish strong directional preferences quickly. Generated via `google('gemini-2.5-flash')`.

### Images

Swipes `5-8`. Moodboards, palettes, visual concepts generated via Nano Banana (`google('gemini-2.5-flash-image')` with `responseModalities: ['TEXT', 'IMAGE']`). ~1-3 seconds per image at 1K resolution. 500 images/day free on hackathon account. `.research/synthesis-sdk-verified`, `.research/synthesis-gemini-projects`

### Mockups

Swipes `9-14`. Scouts generate styled HTML fragments or full-page mockups via `google('gemini-2.5-flash')`. Rendered in sandboxed iframes: `<iframe srcdoc={html} sandbox="">` with fixed viewport (375x667). `.research/synthesis-external-libs`

### Reveal

Triggered when the user stops or enough confidence has accumulated. The builder presents the current draft as the output.

---

## Anima Model

The Anima is a flat list of 5-7 axes seeded from the user's intent. Serialized as **YAML** when injected into agent prompts (62% accuracy vs 50% for JSON in LLM benchmarks for hierarchical data). `.research/synthesis-prompt-patterns`

Good starter axis categories (operationalized as measurable controls, not vibes — `.research/synthesis-prompt-patterns`):

- mood (e.g., calm vs energetic)
- density (sparse vs packed)
- color temperature (warm vs cool)
- typography character (geometric-sans vs humanist-serif)
- layout energy (structured vs organic)
- polish level (raw vs refined)

Each swipe should:

1. increase confidence on the targeted axis
2. set or reinforce the current leaning
3. update the visible panel immediately

The display matters more than the internal math.

---

## Queue Rules

- target queue size: `3-5`
- if queue drops below `3`, scouts should prioritize generation immediately
- if queue exceeds `5`, stop generating until the user catches up
- avoid near-duplicate facades in the queue at the same time
- if an axis becomes clearly resolved, stale queued facades for that axis may be dropped

Freshness and diversity matter more than theoretical purity.

---

## UI Contract

Required visual signals:

- every card shows the tested hypothesis
- the Anima visibly changes after each swipe
- agents have names and statuses
- the builder draft updates during the session, not only at the end
- the builder can surface a simple "what I need to know next" hint
- the reveal feels like something that has been growing in the background

Do not hide the system behind a single output pane.

---

## Build Order

1. Scaffold SvelteKit + Tailwind + `ai@6.0.134` + `@ai-sdk/google@3.0.52` + `@ai-sdk/svelte@4.0.134` + `zod` + `d3-hierarchy`. Deploy skeleton to Vercel. `.research/synthesis-sdk-verified`
2. Create session, context singleton, event bus, and SSE plumbing.
3. Ship one scout loop end to end with word facades.
4. Render swipe feed (custom PointerEvent handler) and post swipe results back to the server. `.research/synthesis-external-libs`
5. Add visible Anima updates (flat axis list, simple confidence bars).
6. Add builder draft updates on every swipe.
7. Add image facade generation (swap model to `gemini-2.5-flash-image`, add `responseModalities`). `.research/synthesis-sdk-verified`
8. Add HTML mockup generation.
9. Add a second scout or second displayed identity if needed for the illusion.
10. Tighten styling and rehearse the demo path.

The build is done when the demo contract is true, not when the architecture is complete.

---

## Failure Plan

If image generation is unstable:

- skip images stage, go straight from words to mockups
- image stage was originally stretch; the demo works without it

If mockup generation is unstable:

- keep words stage working
- generate simpler HTML cards instead of full-page mockups
- keep the builder draft as structured text plus lightweight HTML

If parallel generation is unstable:

- keep one real scout loop
- show multiple agent identities only when they have real state changes to report

If a scout hits content filters:

- route the error back to the scout so it retries with different framing (ModelVisibleError pattern from Gemini CLI) `.research/synthesis-gemini-projects`
- don't crash the loop

If latency becomes a problem:

- reduce model complexity (use `gemini-2.5-flash-lite` instead of `flash`)
- reduce critique loops
- prefer serving a good-enough next facade over waiting for a perfect one
- pre-generate a buffer of word facades on session init before user sees the first one

---

## SDK Integration Notes

These are code-verified against actual npm packages. `.research/synthesis-sdk-verified`

```bash
pnpm add ai@6.0.134 @ai-sdk/google@3.0.52 @ai-sdk/svelte@4.0.134 zod d3-hierarchy
pnpm add -D @types/d3-hierarchy
```

| What | How | Reference |
|------|-----|-----------|
| Text facades | `generateText()` with `google('gemini-2.5-flash')` | `.research/synthesis-sdk-verified` |
| Image facades | `generateText()` with `google('gemini-2.5-flash-image')` + `providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } }` | `.research/synthesis-sdk-verified` |
| Structured output | `output: Output.object({ schema: z.object({...}) })` — avoid `z.union()` with Gemini | `.research/synthesis-sdk-verified` |
| Client streaming | `Chat` class from `@ai-sdk/svelte` (not hooks — Svelte 5 uses classes) | `.research/synthesis-sdk-verified` |
| SSE response | `streamText()` + `.toUIMessageStreamResponse()` | `.research/synthesis-sdk-verified` |
| Image response | `result.files[]` → `GeneratedFile` with `.base64`, `.uint8Array`, `.mediaType` | `.research/synthesis-sdk-verified` |
| Image editing | Pass existing image as `{ type: 'file', data: base64, mediaType: 'image/png' }` in messages | `.research/synthesis-sdk-verified` |

```
GOOGLE_GENERATIVE_AI_API_KEY=   # auto-read by @ai-sdk/google
```

## Prompt Architecture Notes

The system prompts are the product. `.research/synthesis-prompt-patterns`

| Prompt | Key Pattern | Reference |
|--------|-------------|-----------|
| Scout | GATE edge-case pattern: "generate the most informative probe that addresses different aspects than what has already been considered" | `.research/synthesis-prompt-patterns` |
| Builder | Construction-grounded: "I need to know X to build Y, given resolved Z" | `.research/synthesis-prompt-patterns` |
| Anima serialization | YAML format: resolved values + hypothesis distributions + unprobed dimensions. Keep under ~300 tokens. | `.research/synthesis-prompt-patterns` |
| Image prompts | SCHEMA 7-field structure. Prohibitions > mandates (94% vs 91%). Quantified specs ("3200K") not vibes ("cool"). | `.research/synthesis-prompt-patterns` |
| Axis operationalization | Measurable controls (fog density, blur magnitude, color temperature), not adjectives | `.research/synthesis-gemini-projects` |

## Future After Demo

These belong to the next version, not today:

- hierarchical Anima tree
- real contradiction handling
- builder-driven probe queue
- fract spawning
- scout specialization over time
- motion and interactive stages
- true artifact assembly into runnable product code
- grid generation for one-axis sweeps (Pro model only, 50% cheaper per image) `.research/synthesis-gemini-projects`
- Google Search grounding for mockup realism `.research/synthesis-gemini-projects`
- cost tracking per image via `response.usageMetadata` `.research/synthesis-gemini-projects`

---

## Decision Rule

When in doubt, choose the simpler implementation that preserves the illusion of taste discovery.

The product is the feeling that the system is learning what the user means before they can fully say it.
