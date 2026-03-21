# The Eye Loop

Swipe to discover your taste. AI builds what you actually want.

The Eye Loop is a multi-agent taste discovery system. You type an intent ("finance app that doesn't feel like a spreadsheet"), swipe through AI-generated probes, and watch as the system discovers your aesthetic preferences and builds a prototype that reflects your actual taste — not just what you said.

## How it works

1. **Enter an intent** — describe what you want to build
2. **Swipe** — accept or reject visual probes (words, images, mockups)
3. **Watch your taste form** — the Anima panel shows emergent taste axes discovered from your choices
4. **See the prototype evolve** — the builder agent assembles a live HTML draft from your revealed preferences

## Architecture

Three agent types run concurrently on the server:

- **Scouts** (Iris, Prism, Lumen) — generate taste probes using the Akinator pattern. Each has a sensory lens (visual, structural, narrative) and receives axis assignments from the oracle for coordination.
- **Builder** (Meridian) — assembles an evolving HTML prototype from accepted/rejected evidence. Emits construction-grounded probe briefs to guide scouts.
- **Oracle** — discovers emergent taste axes from evidence every 4 swipes. Assigns scouts to different axes. Detects persona-anima divergence (when your choices contradict your stated intent).

Evidence flows through an `EventEmitter` bus. SSE streams updates to the client in real time. No database, no auth — single-session hackathon demo.

## Stack

- **SvelteKit** + Svelte 5 runes
- **Vercel AI SDK 6** — `generateText` + `Output.object` for structured LLM output
- **Gemini** — Flash Lite (probes, builder), Flash Image (NB2 moodboards), Flash (synthesis)
- **Tailwind CSS 4** — CSS-first config with custom design tokens
- **Vercel** — Fluid Compute, adapter-vercel

## Running locally

```bash
cp .env.example .env
# Add your GEMINI_API_KEY to .env

pnpm install
pnpm dev
```

Open `http://localhost:5173` and enter an intent.

## Key files

```
src/lib/context/types.ts          — data contract (SwipeEvidence, Facade, TasteSynthesis)
src/lib/server/context.ts         — EyeLoopContext singleton
src/lib/server/bus.ts             — typed event bus (SSEEventMap-derived)
src/lib/server/agents/scout.ts    — scout loop + rendering pipeline
src/lib/server/agents/builder.ts  — builder reactive loop
src/lib/server/agents/oracle.ts   — synthesis + concreteness floor + reveal
src/routes/api/stream/+server.ts  — SSE endpoint with state replay
src/routes/api/swipe/+server.ts   — swipe POST handler
src/routes/api/session/+server.ts — session init
src/routes/+page.svelte           — main UI (intent → swiping → reveal)
```

## Research

The `specs/` and `research/` directories contain the full design process — from initial spec through the Akinator pivot, validated via benchmark scripts in `scripts/`.

## Built at

Zero to Agent hackathon — Vercel x DeepMind, San Francisco, March 21 2026.
