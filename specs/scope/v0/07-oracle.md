# 07 — Oracle (Pure Code, No LLM in V0)

## Summary
The oracle manages agent lifecycle, queue health, stage advancement, and freshness pruning. It is 80% code, 20% LLM in the full spec, but V0 cuts all LLM parts (compaction, fract detection, stuck detection). Everything here is pure code: if-statements on context state. src/lib/server/agents/oracle.ts.

## Design
Watches events on the bus and manages the system lifecycle. No generateText calls.

Responsibilities:
1. Start initial scout(s) on session init
2. Queue health: if context.facades.length < 3, signal scouts to prioritize. If > 5, scouts back off.
3. Stage advancement by swipe count: 1-4 words, 5-8 images, 9-14 mockups, 14+ reveal
4. Freshness pruning: on 'anima-updated', drop queued facades whose target axis just resolved (confidence > 0.8)
5. Reveal trigger: emit 'stage-changed' with stage='reveal' when swipeCount > 14 or all axes resolved

Bootstrap in hooks.server.ts init(): start oracle and builder listener. Scouts are NOT started in init() — they start when a session is created (session endpoint calls startScout).

## Scope
### Files
- src/lib/server/agents/oracle.ts (~170-200 LOC)
- src/hooks.server.ts (init function — agent bootstrap, ~20-30 LOC addition)

### Subtasks

## Queue health monitor
Subscribe to 'facade-ready' and 'swipe-result' events on the bus. After each event, check context.facades.length (only pending, unswiped facades). If < 3: emit 'scout-prioritize' on bus (scouts should generate immediately without delay). If > 5: emit 'scout-backoff' on bus (scouts should add a short delay before next generation). Alternatively, expose a context.queuePressure getter that scouts poll: 'hungry' (< 3), 'healthy' (3-5), 'full' (> 5). Scouts check this at the top of each loop iteration.

## Stage advancement logic
Subscribe to 'swipe-result'. After each swipe, check context.swipeCount against thresholds:
- swipeCount 1-4: stage = 'words'
- swipeCount 5-8: stage = 'images'
- swipeCount 9-14: stage = 'mockups'
- swipeCount > 14: stage = 'reveal'

When stage changes: update context.stage, emit 'stage-changed' with `{ stage: Stage, swipeCount: number }` on bus (matches SSEEvent type in 02-types). Scouts read context.stage at the top of each iteration to switch model/prompt. On 'reveal': scouts terminate their loops.

**Stage advancement ownership:** The oracle is the SOLE owner of stage transitions. Context.addEvidence() does NOT advance stage. The swipe endpoint does NOT emit stage-changed. Only oracle reads swipeCount and decides when to transition.

## Freshness pruning
Subscribe to 'anima-updated' on bus. On each update, iterate context.facades (pending queue). For each facade, check the targeted axis: if context.axes[facade.axisId].confidence > 0.8, the axis has effectively resolved. Remove the facade from context.facades. Emit 'facade-stale' with the facade id on bus so any scout awaiting that facade's swipe can unblock and continue (scouts should handle 'facade-stale' as a signal to skip and generate a new one). Log pruned facade count.

## Agent bootstrap in hooks.server.ts
In hooks.server.ts init() (SvelteKit server initialization hook):
1. Import and initialize EyeLoopContext (03-context)
2. Import and start the event bus (03-context)
3. Import and call startOracle(context, bus)
4. Import and call startBuilder(context, bus) (06-builder)
5. Do NOT start scouts here — scouts start when a session is created via the POST /api/session endpoint (04-endpoints). The session endpoint calls startScout(context, bus) for 1-2 scout instances.

### Acceptance criteria
- [ ] Queue stays between 3-5 pending facades during active swiping (scout-prioritize fires when < 3, scout-backoff fires when > 5)
- [ ] Stage transitions to 'images' at swipeCount 5, 'mockups' at swipeCount 9, 'reveal' at swipeCount 15
- [ ] 'stage-changed' event fires on bus with `{ stage, swipeCount }` (matches SSEEvent type)
- [ ] Stale facades (targeting axes with confidence > 0.8) are removed from context.facades on anima-updated
- [ ] Scouts waiting on a pruned facade receive a stale signal and do not hang indefinitely
- [ ] Reveal mode triggers after ~14 swipes and scout loops terminate
- [ ] hooks.server.ts init() starts oracle and builder without errors
- [ ] Oracle contains zero LLM calls — all logic is pure code

### Dependencies
03-context (EyeLoopContext singleton, axes, facades, stage, swipeCount, event bus), 05-scout-words (startScout function that oracle lifecycle manages).
