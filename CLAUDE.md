# The Eye Loop

A taste amplifier that discovers what you want to build through instinctive selection, not specification.

**Hackathon:** Zero to Agent — Vercel x DeepMind SF, March 21, 2026
**Problem Statement:** Three — AI Applications
**Submission deadline:** 5:00 PM PST today. Repo must be public.

---

## Tech Stack

- **SvelteKit + Svelte 5** — runes, reactive context class, SSE
- **Vercel AI SDK 6** — agent tool calling, structured output, `generateText` with `stopWhen` + `prepareStep`
- **Gemini 3.1 Pro** — orchestrator, builder, compaction (via temporary hackathon AI Studio account)
- **Gemini 2.5 Flash Image** — scout image facades (Nano Banana, via `generateText()` NOT `generateImage()`)
- **Gemini 2.5 Flash** — scout text/HTML facades
- **d3-hierarchy** — Anima tree layout math (Svelte SVG for rendering)
- **Tailwind CSS** — styling
- **Deploy: adapter-node on Railway** (NOT Vercel serverless — requires persistent process for shared state + SSE)

## Architecture Overview

Single reactive server-side `EyeLoopContext` class coordinates everything. Agents are simple loops that read/write shared state. Communication via shared context + event bus + probe queue. No direct agent-to-agent calls.

```
Eye (user) → SwipeFeed (client) → Context (server state)
                                    ├── Scout A/B/C (generate facades)
                                    ├── Builder (assembles prototype)
                                    └── Orchestrator (watches, spawns, retires, compacts)
```

### Key Abstractions

- **Anima** — hierarchical preference tree. Persona (stated intent) vs anima (revealed preference) tracked separately.
- **Facade** — visual artifact with a hypothesis, shown to user for binary judgment (swipe).
- **ProbeBrief** — builder-written question for scouts. Construction-grounded, not abstract.
- **Fracting** — when a dimension resolves, orthogonal sub-axes branch from it.
- **BALD selection** — next facade chosen to maximally partition remaining uncertainty.

### Agent Roster

| Agent | Model | Role | Generates facades? |
|-------|-------|------|-------------------|
| Orchestrator | Gemini 3.1 Pro | Lifecycle, routing, compaction | No |
| Builder | Gemini 3.1 Pro | Assembles prototype, writes probe briefs | No |
| Scout (x3) | Flash / Nano Banana | Ralph-style generate-wait-learn loops | Yes |
| Compactor | (orchestrator fn) | Merges evidence, prunes, promotes contradictions | No |

### Communication Channels

1. **Shared context** — Anima, facade queue, probe queue, draft prototype. All agents read; specific agents write via context methods.
2. **Event bus** — `facade-ready`, `swipe-result`, `probe-requested`, `spawn-requested`, `anima-updated`. Also streams to client via SSE.
3. **Probe queue** — Builder pushes construction-grounded briefs. Scouts pull (high priority). If empty, scouts self-assign from Anima uncertainty.

## Conventions

### Code Style

- Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`) — no legacy stores
- TypeScript throughout
- Context class pattern: server-side class with getters for derived state
- Agent loops are async generators or simple while loops with event subscriptions

### File Organization

```
src/
  lib/
    context/        # EyeLoopContext, Anima, data structures
    agents/         # orchestrator, builder, scout loops
    components/     # SwipeFeed, AnimaTree, AgentStatus, PrototypeReveal
  routes/
    +page.svelte    # main swipe interface
    api/
      stream/       # SSE endpoint
      swipe/        # swipe result handler
      session/      # session init (intent → first facades)
```

### Naming

- Agent files: `orchestrator.ts`, `builder.ts`, `scout.ts`
- Context: `eye-loop-context.ts`
- Data structures: `types.ts` in `context/`
- Components: PascalCase `.svelte` files

### Key Rules

- Scouts receive their own facade's swipe result back — they maintain local history
- Builder never generates facades, never swipe-facing
- Orchestrator never tells scouts what to do — scouts pull work
- Queue buffer target: 3-5 facades. Below 3 = spawn/prioritize. Above 5 = hold.
- Compaction runs every 5 swipes or on contradiction detection
- Latency (reaction time) is first-class signal — boundary proximity, not simple dislike
- Facade stages blend, no abrupt transitions

### Facade Stages

1. **Words (swipes 1-6)** — single words, near-instant, broadest partitioning
2. **Images (7-15)** — moodboards, palettes, visual concepts
3. **HTML Mockups (16-28)** — sandboxed iframes, full styled pages
4. **Interactive Snippets (28-35)** — surviving sections promoted to interactive
5. **Reveal** — information gain drops, builder presents assembled prototype

## Runtime Architecture (Critical)

**Why not Vercel serverless:** Agents share mutable `EyeLoopContext`. Vercel cannot guarantee POST and SSE hit the same instance. Shared state breaks across instances.

**Solution:** `adapter-node` deployed to Railway. Single Node.js process = singleton context, unlimited SSE, POST and SSE share same memory.

### Server-Side Patterns

- **Shared state:** Module-level singleton in `src/lib/server/context.ts`. Persists across all requests.
- **Agent bootstrap:** `hooks.server.ts` `init()` function — runs once before first request.
- **Event bus:** Node.js `EventEmitter` in `src/lib/server/bus.ts`. Agents emit, SSE subscribes.
- **SSE endpoint:** Native `ReadableStream` + `text/event-stream`. No library needed.
- **Swipe handler:** POST imports shared context, calls `context.addEvidence()`, emits on bus.

### Agent Loops

Scouts are **manual async loops** calling `generateText` per iteration (event-driven, wait for swipe). NOT a single `generateText` with `stopWhen` — the swipe callback is external, not LLM-driven.

### Gemini Image Generation

Use `generateText()` with `google('gemini-2.5-flash-image')` — NOT `generateImage()`. Images return in `result.files[]` as `uint8Array`. For image editing (one-axis sweeps), pass existing image back with edit instruction in messages array.

### Anima Serialization

Serialize as **YAML** in agent prompts (62% accuracy vs 50% for JSON in benchmarks). Format: resolved values + hypothesis distributions + unprobed dimensions. Keep under ~300 tokens.

### Prompt Priority

The system prompts ARE the product. In order of importance:
1. Scout system prompt (GATE edge-case pattern — generate most informative probe)
2. Anima YAML serialization format
3. SCHEMA 7-field image prompts (prohibitions > mandates, 94% vs 91%)
4. Builder probe brief format

## Build Priority

Today is a 7-hour hackathon. Cut line is real.

**Must ship (demo-critical):**
- SwipeFeed with gesture + timestamp capture
- EyeLoopContext with Anima tree
- Single scout loop end-to-end (intent → facade → swipe → Anima update)
- 3 parallel scouts with SSE to client
- Stage transitions (words → images → mockups)
- AnimaTree live visualization

**Should ship:**
- Builder loop with HTML mockups in iframes
- Builder-driven probes
- Prototype reveal

**Cut if needed:**
- Veo interaction clips
- Fract spawning (child scouts)
- Continuous builder (can do single end-call instead)
- Compaction (can skip if Anima stays small)

## Demo Script (3 min)

0:00-0:30 — Pitch: "taste amplifier, not a chatbot"
0:30-2:00 — Live: type intent, swipe words → images → mockups, Anima tree growing, agents working
2:00-2:30 — Reveal prototype grown behind every swipe
2:30-3:00 — Close: agents form hypotheses, learn from rejection, builder drives probes

## Judging Criteria

- **Impact Potential (20%)** — long-term viability
- **Live Demo (45%)** — does it work live? presentation quality
- **Creativity & Originality (35%)** — novel approach to problem statement

## Dependencies

```bash
pnpm add ai @ai-sdk/google @ai-sdk/svelte d3-hierarchy
```

## External Resources

- Vercel AI SDK docs: ai-sdk.dev
- Gemini API: via temporary hackathon AI Studio account
- Deploy: Railway with adapter-node (NOT Vercel serverless)
- Research: see .research/ for full synthesis docs
