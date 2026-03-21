# 05 — Scout Core Loop (Words Stage)

## Summary
The critical first agent loop. A manual async while loop that generates word facades targeting the weakest taste axis, pushes them into the queue, waits for a swipe result, updates local history, and repeats. src/lib/server/agents/scout.ts.

## Design
Manual async while loop (NOT stopWhen). Scouts are event-driven — the swipe callback is external, so the loop must yield between iterations. Each iteration:
1. Read weakest axis (lowest confidence in context.axes)
2. Call generateText() with google('gemini-2.5-flash') + Output.object() + scout system prompt from specs/1-prompts.md section 2
3. Inject Anima state via context.toAnimaYAML() into the system prompt
4. Push facade to context.facades, emit facade-ready on bus
5. Wait for swipe: await new Promise(resolve => bus.once(`swipe:${facade.id}`, resolve))
6. Update local history (last 5-8 entries), loop

Temperature: 1.0 (creative generation — do not lower).

Structured output schema: FacadeMetadata via Output.object() with z.object():
- hypothesis_tested: z.string()
- accept_implies: z.string()
- reject_implies: z.string()
- dimension: z.string()
- heldConstant: z.array(z.string())

No z.union() — Gemini uses OpenAPI 3.0 subset and does not support it.

## Scope
### Files
- src/lib/server/agents/scout.ts (~160-180 LOC)

### Subtasks

## Scout loop skeleton
while(context.stage !== 'reveal') loop. Generate placeholder facade content, push to context.facades, emit 'facade-ready' on bus. Await bus.once(`swipe:${facade.id}`) to block until swipe arrives. On resume, read swipe result from event payload and continue. Wrap body in try/catch so a single failure does not kill the loop.

## Gemini integration
Import generateText from 'ai', google from '@ai-sdk/google', Output from 'ai', z from 'zod'. Build system prompt from specs/1-prompts.md section 2 template: role preamble, rules, Anima YAML (from context.toAnimaYAML()), probe brief (from context.probes or "None"), stage ("words"), local history YAML. Call generateText({ model: google('gemini-2.5-flash'), output: Output.object({ schema: FacadeMetadataSchema }), temperature: 1.0, system: systemPrompt, prompt: "Generate a word facade..." }). Extract result.output for metadata and result.text for facade content. Construct Facade object: { id: crypto.randomUUID(), agentId, stage: 'words', hypothesis: metadata.hypothesis_tested, axisId: weakestAxis.id, content: result.text }.

## Local history tracking
Maintain an array of the last 5-8 facade+result entries, newest first. Each entry: { facade_id, dimension, hypothesis, decision, latency_signal, lesson }. The lesson field is extracted from the metadata (accept_implies or reject_implies depending on decision). Serialize as compact YAML string for injection into the scout system prompt's LOCAL HISTORY block. Shift oldest entry when array exceeds 8.

## Timeout and cleanup
Wrap the swipe await in a Promise.race with a 30-second timeout. If timeout fires: remove the stale facade from context.facades, emit 'facade-stale' on bus with the facade id, log a warning, and continue the loop (generate next facade). On loop exit (stage === 'reveal' or context teardown), update agent status to 'idle'. Export a stop() function or AbortController pattern so the oracle can shut down scouts cleanly.

### Acceptance criteria
- [ ] Scout generates word facades that target the lowest-confidence axis in context.axes
- [ ] Each facade appears in context.facades queue after generation
- [ ] Scout blocks (does not generate next facade) until a swipe arrives for the current facade
- [ ] After swipe, scout resumes and generates the next facade targeting the updated weakest axis
- [ ] Local history tracks the last 5 entries with dimension, hypothesis, decision, and lesson
- [ ] If no swipe arrives within 30s, the stale facade is removed and the scout continues
- [ ] A single generateText failure does not crash the loop
- [ ] Scout loop terminates cleanly when stage transitions to 'reveal'

### Dependencies
03-context (EyeLoopContext singleton, toAnimaYAML(), axes, facades, event bus), 04-endpoints (swipe POST that emits swipe:${id} on bus).
