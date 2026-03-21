---
topic: "Runtime coordination: Vercel constraints and SvelteKit SSE patterns"
date: 2026-03-21
projects:
  - name: Vercel Fluid Compute
    repo: vercel.com/docs/fluid-compute
    source_quality: doc-stated
  - name: SvelteKit SSE patterns
    repo: various (sveltekit-sse, sveltetalk.com)
    source_quality: code-verified
hypotheses:
  - claim: "Vercel serverless can host persistent multi-agent loops with shared state"
    result: rejected — Vercel cannot guarantee singleton instance across endpoints. SSE + POST may hit different instances.
  - claim: "adapter-node on a persistent server solves the coordination problem"
    result: confirmed — single process = shared module-level state, unlimited SSE, POST and SSE share same context
key_findings:
  - "Vercel Hobby: 5 min max function duration. Pro: 13 min. Hard wall."
  - "Vercel cannot guarantee POST and SSE hit the same instance — shared mutable state is unreliable"
  - "adapter-node on Railway/Fly.io is architecturally correct for this use case"
  - "SvelteKit hooks.server.ts has an init() function — perfect for bootstrapping agents"
  - "Module-level singletons persist across requests in adapter-node (single process)"
  - "SSE in SvelteKit is native — ReadableStream + text/event-stream headers, no library"
  - "EventEmitter + controller Set pattern for pub/sub between POST handlers and SSE streams"
unexplored_threads:
  - "Vercel WDK for session lifecycle management (suspend/resume)"
  - "sveltekit-sse library for disconnect detection"
---

# Runtime Coordination: The Deployment Decision

## The Problem

The Eye Loop needs:
- 3-5 concurrent agent loops sharing mutable state (EyeLoopContext)
- SSE stream from server to client (facades, agent status, Anima updates)
- POST requests from client to server (swipe results)
- POST handlers and SSE endpoints must read/write the SAME EyeLoopContext

## Why Vercel Breaks

Vercel serverless cannot guarantee that a POST request hits the same function instance as an active SSE connection. Even with Fluid Compute (shared instances), there is no singleton guarantee. This means:

- SSE endpoint creates `EyeLoopContext` in Instance A
- Swipe POST may hit Instance B, which has a DIFFERENT (or no) context
- Result: split-brain state, swipes don't reach agents, demo fails

## The Decision: Two Viable Paths

### Path A: adapter-node + Railway (recommended)

Deploy SvelteKit with `adapter-node` to Railway, Fly.io, or Render. Single long-running Node.js process.

**What this gives you:**
- Module-level `EyeLoopContext` singleton guaranteed
- SSE connections live as long as the process (unlimited)
- POST handlers share same in-memory context
- `hooks.server.ts` `init()` bootstraps agents on startup
- Everything works exactly as the spec describes

**Cost:** Railway free tier or ~$5/mo. Deploy from GitHub in <5 minutes.

**Risk:** Hackathon judges might care about "deployed on Vercel" since it's a Vercel hackathon. Mitigate by deploying frontend shell to Vercel + backend to Railway, or by explaining the architectural reason.

### Path B: Vercel with request-response pattern (fallback)

Simplify the architecture to avoid persistent state:

1. Client sends POST with intent → server returns first facades
2. Client sends POST with swipe + serialized Anima → server processes, returns next facades
3. No SSE. No persistent agents. No shared state.
4. Anima state round-trips through the client (or stored in Vercel KV)

**What this gives you:**
- Works on Vercel serverless, zero runtime concerns
- Each request is independent — no coordination needed

**What this loses:**
- No "agents visibly working in parallel" — the core demo experience
- No background builder assembling prototype
- Feels like a request-response API, not a living system

### Path C: Hybrid — Vercel frontend + Railway backend

Best of both worlds for hackathon optics:

- SvelteKit static/SSR frontend on Vercel (fast, CDN, "we use Vercel")
- Agent backend as a separate Node.js service on Railway
- Client connects to Railway backend via SSE for agent events
- Swipe POSTs go to Railway backend directly

**Complexity:** Two deploy targets, CORS config, but architecturally sound.

## Recommendation for Hackathon

**Start with Path A (adapter-node on Railway).** If judges question Vercel usage, explain that the AI agent orchestration requires a persistent process — this is a legitimate architectural decision. The Vercel AI SDK still powers all the agent loops regardless of where Node.js runs.

**Fallback to Path B** only if Railway setup takes too long or has issues. The request-response pattern works but makes the demo less impressive.

## SvelteKit Implementation Patterns (for Path A)

### SSE Endpoint (native, no library)
```
src/routes/api/stream/+server.ts
- GET handler returns Response with ReadableStream
- Content-Type: text/event-stream
- Controller added to shared Set on start
- Controller removed on cancel/error
```

### Shared State (module-level singleton)
```
src/lib/server/context.ts
- export const context = new EyeLoopContext()
- Imported by both SSE endpoint and POST handlers
- Persists across all requests (adapter-node guarantee)
```

### Agent Bootstrap
```
src/hooks.server.ts
- export const init = async () => { startAgents(context); }
- Runs once before first request
- Spawns orchestrator, builder, scouts as concurrent promises
```

### Event Bus (EventEmitter)
```
src/lib/server/bus.ts
- Node.js EventEmitter
- Agents emit: facade-ready, swipe-result, probe-requested, anima-updated
- SSE endpoint subscribes and forwards to client
- POST handler emits swipe-result when swipe arrives
```

### Swipe Handler
```
src/routes/api/swipe/+server.ts
- POST handler receives { facadeId, decision, latencyMs }
- Imports context from shared module
- Calls context.addEvidence(swipeRecord)
- Emits 'swipe-result' on bus
- Returns 200
```
