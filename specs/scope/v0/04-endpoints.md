# 04 — Server Endpoints (SSE, Swipe, Session Init)

## Summary
Build three server endpoints: an SSE stream for pushing real-time updates to the client, a swipe POST handler for recording user decisions, and a session init POST handler that seeds a new session. These endpoints are the only HTTP surface — everything else flows through the event bus and context singleton. Session init is pure code (reset + intent + sessionId) — no LLM call, no axis seeding.

## Design
All endpoints are SvelteKit server routes under `src/routes/api/`. Each exports `config = { runtime: 'nodejs22.x', maxDuration: 300 }` for Vercel Fluid Compute. The SSE endpoint is a long-lived GET that returns a native `ReadableStream` with `Content-Type: text/event-stream` — no SSE library. The swipe endpoint is a short POST that mutates context via `addEvidence()` and emits bus events. The session init endpoint delegates to `seedSession()` from the oracle agent — pure code that resets context, sets intent + sessionId, stops/starts scouts, and emits `session-ready`.

## Scope
### Files
- src/routes/api/stream/+server.ts (~48 LOC)
- src/routes/api/swipe/+server.ts (~42 LOC)
- src/routes/api/session/+server.ts (~21 LOC)

### Subtasks

## SSE endpoint
`src/routes/api/stream/+server.ts` — GET handler.

Implementation:
- Create a `ReadableStream` with a `start(controller)` callback
- Inside start, use `bus.onAny(cb)` to subscribe to all SSE event types at once
- For each event, encode as SSE format: `event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, ...payload })}\n\n`
- Set up a 15-second keepalive interval that sends SSE comment lines (`: keepalive\n\n`)
- Track teardown function that clears keepalive interval and unsubscribes bus listeners
- On client disconnect (stream cancel), call teardown to prevent memory leaks
- Return `new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })`
- Export `config = { runtime: 'nodejs22.x', maxDuration: 300 }`

SSE wire format per event:
```
event: facade-ready
data: {"type":"facade-ready","facade":{...}}

```

## Swipe POST endpoint
`src/routes/api/swipe/+server.ts` — POST handler.

Request body: `{ facadeId: string, decision: 'accept' | 'reject', latencyMs: number }`

Implementation:
- Parse and validate request body (inline validation, no Zod — keep it simple)
- Validate `decision` is `'accept'` or `'reject'` and `latencyMs` is a number; return 400 otherwise
- Look up facade in `context.facades` by `facadeId`; return 404 if not found
- Build `SwipeRecord` with `facadeId`, `facade.agentId`, `decision`, `latencyMs` (no `axisId`)
- If decision is `'reject'`, append the facade's hypothesis to `context.antiPatterns` BEFORE calling addEvidence so the `evidence-updated` event includes the new anti-pattern
- Call `context.addEvidence(record)` — computes latencyBucket, builds SwipeEvidence, pushes to evidence[], emits `swipe-result` + `evidence-updated` on bus (does NOT advance stage — oracle owns that)
- Call `context.markFacadeConsumed(facadeId)` — moves facade from active queue to consumedFacades
- Do NOT emit `stage-changed` — oracle subscribes to `swipe-result` and handles stage transitions via concreteness floor
- Return `json({ ok: true, swipeCount: context.swipeCount, stage: context.stage })`
- Export `config = { runtime: 'nodejs22.x', maxDuration: 300 }`

## Session init endpoint
`src/routes/api/session/+server.ts` — POST handler.

Request body: `{ intent: string }`

Implementation:
- Parse request body, validate `intent` is a non-empty string; return 400 otherwise
- Import `seedSession` from oracle agent and `stopAllScouts`/`startAllScouts` from scout agent
- Call `stopAllScouts()` to halt any running scout loops
- Call `seedSession(intent.trim())` — pure code that resets context, sets intent + sessionId via `crypto.randomUUID()`, emits `session-ready` with `{ intent }` on bus
- Call `startAllScouts()` to kick off scout loops for the new session
- Return `json({ intent: intent.trim(), sessionId })`
- Export `config = { runtime: 'nodejs22.x', maxDuration: 300 }`

No LLM call. No axis seeding. No Gemini. No Zod. The first probes ARE the seed — scouts begin probing immediately using the intent alone.

### Acceptance criteria
- [ ] GET `/api/stream` returns response with `Content-Type: text/event-stream`
- [ ] SSE endpoint uses `bus.onAny()` to subscribe to all event types
- [ ] SSE endpoint sends `event:` and `data:` lines in correct SSE wire format
- [ ] SSE endpoint sends keepalive comments every 15 seconds
- [ ] SSE endpoint cleans up bus listeners and keepalive interval when the client disconnects
- [ ] POST `/api/swipe` with valid `{facadeId, decision, latencyMs}` returns 200 with `{ok: true}`
- [ ] POST `/api/swipe` with unknown facadeId returns 404
- [ ] Swipe endpoint builds `SwipeRecord` with no `axisId` field
- [ ] Swipe endpoint appends to `context.antiPatterns` on reject decisions BEFORE calling addEvidence
- [ ] Swipe endpoint calls `context.addEvidence(record)` which handles latencyBucket computation and emits `swipe-result` + `evidence-updated`
- [ ] Swipe endpoint does NOT directly emit bus events — `addEvidence()` handles all emissions
- [ ] POST `/api/session` with `{intent: "weather app for runners"}` returns `{intent, sessionId}`
- [ ] Session init does NOT call any LLM — pure code path
- [ ] Session init does NOT return axes — no TasteAxis in the response
- [ ] Session init calls `stopAllScouts()` then `seedSession()` then `startAllScouts()`
- [ ] `session-ready` event carries only `{ intent }` (no axes)
- [ ] All three endpoints export `config = { runtime: 'nodejs22.x', maxDuration: 300 }`

### Dependencies
- 01-scaffold (SvelteKit routes)
- 02-types (Facade, SwipeRecord, SwipeEvidence, Stage)
- 03-context (EyeLoopContext singleton, event bus)
