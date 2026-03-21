# 06 — Builder Reactive Loop

## Summary
The builder agent subscribes to swipe-result events and updates the evolving prototype draft. It never generates facades. It integrates accepted properties, enforces rejected properties as anti-patterns (PROHIBITIONS — 94% compliance vs 91% for positive mandates), and emits construction-grounded probe briefs when blocked. src/lib/server/agents/builder.ts.

## Design
Two triggers: intent-seed (once) and swipe-result (ongoing).

### On session init (intent-seed)
The builder receives 'session-ready' from the bus with the user's intent and seeded axes. It generates an initial draft scaffold from just the intent — crude but visible. This means the prototype pane is never empty; it has content from second one. Demo contract #5: "A prototype pane starts changing before the final reveal."

### On each swipe-result
Subscribes to 'swipe-result' on the bus. On each event:
1. Look up the facade + swipe record from context
2. Call generateText() with google('gemini-2.5-flash') + builder system prompt from specs/1-prompts.md section 3
3. On accept: integrate surviving artifact's visual properties into draft
4. On reject: add rejected properties to context.draft.rejectedPatterns (hard constraints for all agents)
5. If construction ambiguity found: emit probe brief on bus for scouts (push to context.probes)
6. Update context.draft with new title/summary/html/patterns/nextHint
7. Emit `draft-updated` with `{ draft: PrototypeDraft }` on bus (carries the full updated draft including html, patterns, nextHint — this is what the client renders)
8. If nextHint is set, emit `builder-hint` with `{ hint: string }` (matches SSEEvent type — carries only the hint text, not probe briefs). Probe briefs are pushed to `context.probes` silently; scouts pull them on next iteration.
9. Emit `anima-updated` on bus (anti-patterns may have changed)

Temperature: 0 (deterministic analysis). Builder is reading evidence and building, not generating creative content.

Output schema: DraftUpdate via Output.object() with z.object():
- title: z.string()
- summary: z.string()
- html: z.string()
- acceptedPatterns: z.array(z.string())
- rejectedPatterns: z.array(z.string())
- probeBriefs: z.array(z.object({ source: z.literal('builder'), priority: z.enum(['high', 'normal']), brief: z.string(), context: z.string(), heldConstant: z.array(z.string()) }))
- nextHint: z.string().nullable()

No z.union() — keep schemas flat for Gemini compatibility.

## Scope
### Files
- src/lib/server/agents/builder.ts (~120-150 LOC)

### Subtasks

## Bootstrap and event subscription
Export a startBuilder(context, bus) function.

**Intent-seed:** Subscribe to 'session-ready' on the bus. On event, fire one generateText call with the intent + seeded axes to produce an initial draft scaffold (title, summary, basic HTML structure, empty patterns). This runs once. The user sees a prototype pane with content before they ever swipe.

**Swipe subscription:** Subscribe to 'swipe-result' on the bus. On event, look up the facade by facadeId from `context.consumedFacades` (NOT `context.facades` — the swipe endpoint moves the facade to consumedFacades before emitting the event). Look up the swipe record from the event payload. Update agent status to 'thinking' before the LLM call and back to 'idle' after.

## Gemini integration
Build system prompt from specs/1-prompts.md section 3 template: role preamble, rules, Anima YAML (from context.toAnimaYAML()), current draft state (context.draft serialized as YAML), anti-patterns list (context.draft.rejectedPatterns), last swipe details (facade_id, decision, content_summary, hypothesis, observation with confidence and boundary_proximity). Call generateText({ model: google('gemini-2.5-flash'), output: Output.object({ schema: DraftUpdateSchema }), temperature: 0, system: systemPrompt, prompt: "Analyze this swipe result and update the draft..." }). Extract result.output as DraftUpdate.

## Draft merge logic
On accept: merge result.output.acceptedPatterns into context.draft.acceptedPatterns (deduplicate). Update context.draft.html with result.output.html. Update title and summary if changed. On reject: append result.output.rejectedPatterns to context.draft.rejectedPatterns (these are PROHIBITIONS — builder and scouts both read them). Set context.draft.nextHint from result.output.nextHint. Emit `draft-updated` on bus with `{ draft: context.draft }` after every draft update. Emit `anima-updated` on bus if anti-patterns changed.

## Probe brief emission
If result.output.probeBriefs is non-empty, push each brief into context.probes array. If nextHint is set, emit `builder-hint` on bus with `{ hint: context.draft.nextHint }`. Probe briefs are NOT sent via builder-hint — they go into `context.probes` for scouts to pull. Probe briefs are construction-grounded: "Building the header — need to know: fixed-position or scroll-away, given resolved sparse layout with warm-neutral palette" (not "layout axis unresolved"). Scouts read context.probes to prioritize builder-requested probes over self-assignment.

### Acceptance criteria
- [ ] On session-ready, builder generates an initial draft from intent within 3s
- [ ] Prototype pane shows content before the first swipe
- [ ] After a swipe event, builder generateText call fires within 1s of the event
- [ ] context.draft.html updates after each builder call
- [ ] context.draft.rejectedPatterns grows by at least one entry when a facade is rejected
- [ ] context.draft.nextHint is populated when the builder identifies a construction ambiguity
- [ ] Probe briefs appear in context.probes when the builder is blocked
- [ ] 'builder-hint' event fires on bus when probe briefs are emitted
- [ ] 'anima-updated' event fires on bus after every draft update
- [ ] A generateText failure logs an error but does not unsubscribe the builder from future events

### Dependencies
03-context (EyeLoopContext singleton, toAnimaYAML(), draft, probes, event bus), 04-endpoints (swipe POST that emits swipe-result on bus).
