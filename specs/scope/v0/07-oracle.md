# 07 — Oracle (Code + LLM Synthesis, Akinator Pattern)

## Summary
The oracle is the strategic brain of the system. It has three jobs: emergent axis synthesis (LLM, every 4 swipes), concreteness floor gating (code), and reveal triggering (code). Session init is pure code — no axis seeding. src/lib/server/agents/oracle.ts.

## Design
Two exports:

1. `seedSession(intent: string)` — initializes session state (reset, set intent, generate sessionId, emit session-ready). No LLM call. "The first probes ARE the seed" (specs/4-akinator.md:139). Scouts fill the queue after session creation.

2. `startOracle()` — idempotent bus subscription on `swipe-result`. On each swipe:
   - **Concreteness floor** (synchronous): check `context.concretenessFloor` (< 4 → word, 4-7 → image, 8+ → mockup). If floor advanced, update `context.stage`, emit `stage-changed`.
   - **Reveal** (synchronous): if evidence >= 15, trigger reveal.
   - **Synthesis** (async, non-blocking): every 4 swipes, run LLM synthesis. Captures evidence snapshot before async call. Session staleness guard on result commit.

### Emergent Axis Synthesis
- Runs `generateText` with `gemini-2.5-flash` at temperature 0
- Discovers 3-5 emergent taste axes from evidence patterns
- Produces `TasteSynthesis`: `axes` (EmergentAxis[]), `edge_case_flags`, `scout_assignments` (each scout assigned a different axis), `persona_anima_divergence`
- Each `EmergentAxis` has: label, poleA, poleB, confidence (unprobed/exploring/leaning/resolved), leaning_toward, evidence_basis
- Stored on `context.synthesis`, emitted as `synthesis-updated` on bus
- Injected into scout prompts (axes + assignment + edge case flags) and builder prompts for coordination
- Shown in Anima panel as emergent axes with confidence badges
- Busy gate: if synthesis running and another 4th-swipe fires, skip

### Queue Health
Exposed via `context.queuePressure` getter ('hungry' | 'healthy' | 'full'). Scouts poll at loop top.

### Concreteness Floor
Exposed via `context.concretenessFloor` getter ('word' | 'image' | 'mockup'). Separate from `context.stage` — floor is a minimum, not a hard gate. Scouts read it for format selection.

## Scope
### Files
- src/lib/server/agents/oracle.ts (~150 LOC)
- src/lib/context/types.ts (TasteSynthesis type, synthesis-updated SSE event)
- src/lib/server/context.ts (synthesis field, concretenessFloor getter)
- src/lib/server/bus.ts (synthesis emit/on helpers)
- src/hooks.server.ts (unchanged — already starts oracle)

### Acceptance criteria
- [x] `seedSession(intent)` resets context, sets intent + sessionId, emits `session-ready`
- [x] `startOracle()` is idempotent (teardown on re-invocation)
- [x] Synthesis runs every 4 swipes via `generateText`
- [x] Synthesis captures evidence snapshot before async call
- [x] Session staleness guard discards stale synthesis results
- [x] `synthesis-updated` event fires on bus with `TasteSynthesis` payload (emergent axes format: axes, edge_case_flags, scout_assignments, persona_anima_divergence)
- [x] Concreteness floor advances: word (< 4) → image (4-7) → mockup (8+)
- [x] `stage-changed` fires when floor advances
- [x] Reveal triggers at evidence >= 15
- [x] `context.queuePressure` returns hungry/healthy/full
- [x] `pnpm check && pnpm build` both pass

### Dependencies
03-context (EyeLoopContext singleton, evidence, synthesis, facades, swipeCount, event bus). Scouts (05) fill the queue. Builder (06) reads synthesis for construction decisions.
