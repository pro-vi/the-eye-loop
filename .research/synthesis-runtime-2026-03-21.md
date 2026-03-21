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
    result: REVISED — initially rejected, then re-evaluated. Fluid Compute (default since Apr 2025) shares instances across concurrent requests and prioritizes warm instances. For a single-user demo, SSE keeps instance warm and POST routes to same instance. Viable for hackathon.
  - claim: "adapter-node on a persistent server solves the coordination problem"
    result: confirmed but unnecessary for hackathon — Vercel Fluid Compute is sufficient for single-user demo
key_findings:
  - "Vercel Hobby: 5 min max function duration. Pro: 13 min. Hard wall."
  - "REVISED: Fluid Compute shares instances and prioritizes warm ones — POST and SSE will share same instance for single-user demo"
  - "REVISED: Vercel with adapter-vercel is viable for hackathon. adapter-node on Railway remains the production-correct answer."
  - "SvelteKit hooks.server.ts has an init() function — perfect for bootstrapping agents"
  - "Module-level singletons persist across requests within a Fluid Compute instance"
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

## REVISED: Why Vercel Works (Fluid Compute)

Initial analysis rejected Vercel because "no singleton guarantee." After deeper investigation of Fluid Compute docs:

> "Multiple invocations can share the same physical instance (a global state/process) concurrently."
> "Vercel Functions prioritize existing idle resources before allocating new ones."

For a **single-user hackathon demo**, this means:
1. SSE connection keeps the instance warm and alive
2. POST requests (swipes) route to the same warm instance — Vercel prefers existing instances
3. Module-level `EyeLoopContext` persists in that instance's global state
4. No split-brain risk with one user

The "no guarantee" caveat applies to production multi-user scenarios, not to a single-user demo.

## The Decision: Vercel with Fluid Compute

Deploy SvelteKit with `adapter-vercel`. Node.js runtime. Fluid Compute enabled (default since Apr 2025).

**What this gives you:**
- Module-level `EyeLoopContext` singleton (practical guarantee for single-user demo)
- SSE connections live up to `maxDuration` (Hobby: 5 min, Pro: 13 min)
- POST handlers share same in-memory context on warm instance
- `hooks.server.ts` `init()` bootstraps agents on startup
- Zero deploy friction — Vercel hackathon, deployed on Vercel

**Configuration:**
```typescript
// In long-lived +server.ts routes:
export const config = {
  runtime: 'nodejs22.x',
  maxDuration: 300, // 5 min on Hobby
};
```

```json
// vercel.json (default for new projects)
{ "fluid": true }
```

**Risk:** If Vercel somehow spins up a second instance (extremely unlikely with one user), state splits. No mitigation needed for demo.

## Fallback: adapter-node on Railway

If Vercel proves unreliable during dev, switch to `adapter-node` on Railway. Single Node.js process = guaranteed singleton. Takes 5 minutes to set up.

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
