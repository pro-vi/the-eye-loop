# AGENTS.md — The Eye Loop

Instructions for any coding agent (Claude Code, Codex, Copilot, Cursor, etc.) working in this repo.

---

## Project Context

**The Eye Loop** is a hackathon project (Zero to Agent, Vercel x DeepMind, March 21 2026). It's a taste amplifier: the user types an intent, then swipes through generated visual "facades." Each swipe updates a living preference model (the Anima). Agents generate probes, a builder assembles surviving artifacts into a prototype. By the time swiping ends, the prototype is already built.

Read `CLAUDE.md` for full architecture, tech stack, and build priorities.
Read `specs/0-spec.md` for the detailed build spec.

---

## Ground Rules

1. **Speed over perfection.** This is a single-day hackathon. Ship working code. Refactor never.
2. **Repo must be public.** Do not commit secrets, API keys, or credentials. Use env vars.
3. **All work must be new.** No importing existing projects. Everything built today.
4. **Do not add unnecessary dependencies.** The stack is SvelteKit + Svelte 5 + Vercel AI SDK + Tailwind. That's it.
5. **No docs/README unless asked.** Focus on code that ships.

---

## Tech Stack & Conventions

| Layer | Choice | Notes |
|-------|--------|-------|
| Framework | SvelteKit + Svelte 5 | Runes only (`$state`, `$derived`, `$effect`, `$props`). No legacy stores. |
| AI | Vercel AI SDK + Gemini 3.1 Pro / Flash | `generateText`, `streamText`, structured output, tool calling |
| Styling | Tailwind CSS | Utility classes. No component libraries. |
| Deploy | Railway (adapter-node) | Persistent process required for shared state + SSE. NOT Vercel serverless. |
| State | Server-side `EyeLoopContext` class | Module-level singleton in `src/lib/server/context.ts`. All agents read from it. |
| Transport | SSE | Native ReadableStream + text/event-stream. No library. |
| Event Bus | Node.js EventEmitter | `src/lib/server/bus.ts`. Agents emit, SSE subscribes, POST publishes. |
| Image Gen | Gemini Nano Banana | `generateText()` with `google('gemini-2.5-flash-image')`. NOT `generateImage()`. |

### TypeScript

- Strict mode. No `any` unless truly unavoidable.
- Types live in `src/lib/context/types.ts`.
- Prefer interfaces for data structures, types for unions.

### Svelte 5

- Components use `$props()` for inputs, not `export let`.
- Reactive state via `$state()` and `$derived()`.
- Side effects via `$effect()`.
- No `on:click` — use `onclick` (Svelte 5 event syntax).

### File Structure

```
src/
  lib/
    server/
      context.ts      # EyeLoopContext singleton (module-level, persists across requests)
      bus.ts           # EventEmitter event bus
      agents/          # Agent loop implementations
        orchestrator.ts
        builder.ts
        scout.ts
    context/
      types.ts         # All shared data structures (Anima, Facade, ProbeBrief, etc.)
    components/        # UI components
      SwipeFeed.svelte
      AnimaTree.svelte
      AgentStatus.svelte
      PrototypeReveal.svelte
  routes/
    +page.svelte       # Main interface
    +page.server.ts    # Session init
  hooks.server.ts      # init() bootstraps agents on startup
    api/
      stream/+server.ts    # SSE endpoint
      swipe/+server.ts     # POST swipe results
      session/+server.ts   # POST new session (intent)
```

**Respect file ownership.** If a file exists, read it before modifying. Don't create parallel implementations.

---

## Architecture — How Agents Communicate

Agents never call each other directly. Three channels:

### 1. Shared Context (`EyeLoopContext`)
Single server-side object. All agents read the same state. Writes go through context methods.

Key state:
- `.anima` — preference tree (shared read)
- `.facades` — queue of facades waiting for user (scouts push, client pulls)
- `.probes` — probe briefs (builder pushes, scouts pull)
- `.agents` — registry of active agent states
- `.draft` — builder's living prototype

Key derived (getters):
- `.mostUncertain` — BALD over Anima tree → highest entropy node
- `.queueHealthy` — `facades.length >= 3`
- `.nextProbe` — shift from probe queue, or null

### 2. Event Bus
Fire-and-forget events: `facade-ready`, `swipe-result`, `probe-requested`, `spawn-requested`, `anima-updated`.

Events also stream to client via SSE for live visualization.

### 3. Probe Queue
Builder identifies construction ambiguities → writes detailed probe briefs → pushes to queue.
Scouts pull briefs (high priority). If empty, scouts self-assign from Anima uncertainty.

---

## Agent Behavior Rules

### Scouts
- Run Ralph-style loops: generate → push → wait → receive feedback → decide → loop
- Pull work from probe queue first, then self-assign from `.mostUncertain`
- Receive their OWN facade's swipe result — maintain local history
- Can request child agent spawning when fracting

### Builder
- Runs continuously from first surviving artifact
- On accept: integrate artifact into draft prototype
- On reject: add anti-pattern constraint
- Identifies construction ambiguities → writes probe briefs for scouts
- **Never generates facades. Never swipe-facing.**

### Orchestrator
- Watches events, manages lifecycle
- Spawns scouts when queue thin or probes piling up
- Retires scouts when info gain dropping + queue full
- Triggers Anima compaction every 5 swipes
- Freshness check: drop queued facades whose hypothesis is now redundant
- **Never generates facades.**

---

## Data Structures (defined in `types.ts`)

```typescript
// Core types — see specs/0-spec.md for full definitions
interface Anima { intent: string; tree: AnimaNode[]; swipeCount: number; stage: Stage }
interface AnimaNode { axis: string; resolved: boolean; value?: string; confidence: number; children: AnimaNode[]; evidence: SwipeRecord[] }
interface SwipeRecord { facadeId: string; agentId: string; hypothesis: string; decision: 'accept' | 'reject'; latencyMs: number }
interface Facade { agentId: string; stage: Stage; hypothesis: string; content: string; axisTarget: string; brief?: ProbeBrief }
interface ProbeBrief { source: 'builder' | 'scout'; priority: 'high' | 'normal'; brief: string; context: string }
type Stage = 'words' | 'images' | 'mockups' | 'components'
```

---

## Queue & Timing

- **Swipe cadence:** ~2-3 seconds
- **Buffer target:** 3-5 facades in queue
- **Below 3:** spawn scout or increase priority
- **Above 5:** hold spawning, reduce critique loops
- **Freshness:** on Anima update, drop queued facades whose axis just resolved

---

## What NOT to Do

- Don't add auth, databases, or user accounts. This is a demo.
- Don't add error boundaries that swallow errors silently. Fail loud.
- Don't create abstraction layers "for later." There is no later.
- Don't mock AI responses for the demo. Use real Gemini calls.
- Don't optimize bundle size or add caching. Ship features.
- Don't add tests. (Hackathon. We test by demoing.)

---

## Runtime Architecture

**Deploy target: Railway with adapter-node** (NOT Vercel serverless).

Why: Agents share mutable `EyeLoopContext`. Vercel cannot guarantee POST and SSE hit the same function instance. A persistent Node.js process guarantees singleton state.

### How it works:
1. `hooks.server.ts` `init()` creates `EyeLoopContext` and spawns agent loops
2. SSE endpoint (`/api/stream`) streams events from EventEmitter to client
3. Swipe POST (`/api/swipe`) imports shared context, calls `context.addEvidence()`, emits on bus
4. Agents run as concurrent async loops within the same process
5. Everything shares the same in-memory state — no external store needed

### Agent loop pattern:
Scouts are **manual async loops**, NOT a single `generateText` with `stopWhen`. Each iteration:
1. Pull probe brief or self-assign from `context.mostUncertain`
2. Call `generateText()` once to generate facade
3. Push facade to queue, wait for swipe event (EventEmitter subscription)
4. Receive result, call `context.addEvidence()`
5. Loop

### Anima serialization in prompts:
Use **YAML** (not JSON) — 62% vs 50% accuracy in LLM benchmarks for hierarchical data.

## Environment Variables

```
GOOGLE_GENERATIVE_AI_API_KEY=   # Gemini API key (auto-read by @ai-sdk/google)
```

Use `$env/static/private` or `$env/dynamic/private` in SvelteKit. Never expose to client.
