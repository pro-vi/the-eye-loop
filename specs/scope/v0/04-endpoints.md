# 04 — Server Endpoints (SSE, Swipe, Session Init)

## Summary
Build three server endpoints: an SSE stream for pushing real-time updates to the client, a swipe POST handler for recording user decisions, and a session init POST handler that seeds the Anima from the user's intent via Gemini. These endpoints are the only HTTP surface — everything else flows through the event bus and context singleton.

## Design
All endpoints are SvelteKit server routes under `src/routes/api/`. Each sets `export const maxDuration = 300` for Vercel Fluid Compute. The SSE endpoint is a long-lived GET that returns a native `ReadableStream` with `Content-Type: text/event-stream` — no SSE library. The swipe endpoint is a short POST that mutates context and emits bus events. The session init endpoint calls Gemini 2.5 Flash via `generateText()` with `Output.object()` to generate operationalized taste axes from the user's intent, seeds the context, and returns the initial state.

## Scope
### Files
- src/routes/api/stream/+server.ts (~140 LOC)
- src/routes/api/swipe/+server.ts (~110 LOC)
- src/routes/api/session/+server.ts (~170 LOC)

### Subtasks

## SSE endpoint
`src/routes/api/stream/+server.ts` — GET handler.

Implementation:
- Create a `ReadableStream` with a `start(controller)` callback
- Inside start, subscribe to bus events: `facade-ready`, `swipe-result`, `anima-updated`, `agent-status`, `draft-updated`, `builder-hint`, `stage-changed`, `session-ready`
- For each event, encode as SSE format: `data: ${JSON.stringify(payload)}\n\n` with `event: ${eventType}\n`
- On client disconnect (controller cancel signal), unsubscribe all bus listeners to prevent memory leaks
- Return `new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })`
- Export `const maxDuration = 300`

SSE wire format per event:
```
event: facade-ready
data: {"type":"facade-ready","facade":{...}}

```

## Swipe POST endpoint
`src/routes/api/swipe/+server.ts` — POST handler.

Request body: `{ facadeId: string, decision: 'accept' | 'reject', latencyMs: number }`

Implementation:
- Parse and validate request body (inline validation, no Zod at this boundary — keep it simple)
- Look up facade in `context.facades` by `facadeId`; return 404 if not found
- Build `SwipeRecord` with `facadeId`, `facade.agentId`, `facade.axisId`, `decision`, `latencyMs`
- Compute `latencyBucket`: compare `latencyMs` to `context.sessionMedianLatency` — below median = `'fast'`, at or above = `'slow'`; if no prior swipes, default to `'slow'`
- Call `context.addEvidence(record)` — updates axis confidence/leaning, increments swipeCount (does NOT advance stage — oracle owns that)
- Call `context.markFacadeConsumed(facadeId)` — moves facade from active queue to consumedFacades
- If decision is `'reject'`, append the facade's hypothesis to `context.antiPatterns`
- Emit `swipe-result` on bus with the record and updated axis
- Emit `swipe:${facadeId}` on bus with the record (wakes the scout that generated this facade)
- Emit `anima-updated` on bus with current axes and antiPatterns
- Do NOT emit `stage-changed` — oracle subscribes to `swipe-result` and handles stage transitions
- Return `json({ ok: true, swipeCount: context.swipeCount, stage: context.stage })`
- Export `const maxDuration = 300`

## Session init endpoint
`src/routes/api/session/+server.ts` — POST handler.

Request body: `{ intent: string }`

Implementation:
- Parse request body, validate `intent` is a non-empty string
- Reset context for new session: `context.reset()`
- Set `context.intent = intent`
- Call Gemini 2.5 Flash to generate 5-7 operationalized taste axes:
  ```ts
  import { generateText, Output } from 'ai';
  import { google } from '@ai-sdk/google';
  import { z } from 'zod';

  const result = await generateText({
    model: google('gemini-2.5-flash'),
    output: Output.object({
      schema: z.object({
        axes: z.array(z.object({
          label: z.string(),
          optionA: z.string(),
          optionB: z.string(),
        }))
      })
    }),
    prompt: `Given the product intent "${intent}", generate 5-7 operationalized taste axes...`
  });
  ```
- No `z.union()` in the schema — keep it flat per Gemini OpenAPI 3.0 limitation
- Transform LLM output into `TasteAxis[]` with generated IDs, confidence 0, evidenceCount 0
- Call `context.seedAxes(axes)`
- Generate a `sessionId` (e.g., `crypto.randomUUID()`)
- Emit `session-ready` on bus
- Return `json({ intent, axes, sessionId })`
- Export `const maxDuration = 300`

System prompt for axis generation should produce measurable, binary-pole axes:
- Operationalized controls (fog density, blur magnitude, color temperature), not adjectives (pretty, modern)
- Each axis has two distinct poles that produce visibly different facades
- Axes should be approximately independent of each other
- Good categories: mood, density, color temperature, typography character, layout energy, polish level

### Acceptance criteria
- [ ] GET `/api/stream` returns response with `Content-Type: text/event-stream`
- [ ] SSE endpoint sends `event:` and `data:` lines in correct SSE wire format
- [ ] SSE endpoint cleans up bus listeners when the client disconnects
- [ ] POST `/api/swipe` with valid `{facadeId, decision, latencyMs}` returns 200 with `{ok: true}`
- [ ] POST `/api/swipe` with unknown facadeId returns 404
- [ ] Swipe endpoint sets `latencyBucket` to `'fast'` when latencyMs is below session median
- [ ] Swipe endpoint emits `swipe:${facadeId}` event on bus (verifiable by subscribing before calling)
- [ ] Swipe endpoint appends to `context.antiPatterns` on reject decisions
- [ ] POST `/api/session` with `{intent: "weather app for runners"}` returns `{intent, axes, sessionId}`
- [ ] Session init returns between 5 and 7 axes, each with two string poles
- [ ] Session init sets all returned axes to confidence 0 and evidenceCount 0
- [ ] Session init calls `context.seedAxes()` so axes are available to other endpoints immediately
- [ ] No `z.union()` in any Zod schema
- [ ] All three endpoints export `maxDuration = 300`

### Dependencies
- 01-scaffold (SvelteKit routes, AI SDK packages installed)
- 02-types (Facade, SwipeRecord, TasteAxis, Stage, ProbeBrief, AgentState)
- 03-context (EyeLoopContext singleton, event bus)
