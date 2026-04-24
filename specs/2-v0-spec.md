# The Eye Loop — Lean V0 Spec

## Zero to Agent: Vercel x DeepMind | March 21, 2026

**Status:** implementation contract for today
**Akinator pattern:** `specs/4-akinator.md` (validated via benchmarks)
**Prompt doc:** `specs/1-prompts.md`
**Model doc:** `specs/3-models.md`
**Vision doc:** `specs/0-spec.md`
**Research:** `.research/synthesis-*.md`

`0-spec.md` describes the full theory. `4-akinator.md` validates the evidence-based Akinator pivot. This file defines the smallest version that still wins the live demo.

---

## One-Line Product Promise

The user types an intent, swipes through generated facades, watches a visible taste model form in real time, and sees a prototype draft evolve before the session ends.

If that works live, the product story lands.

---

## Demo Contract

The demo succeeds if all five of these are true:

1. The user can enter an intent and get the first facades quickly.
2. Every swipe visibly updates the Anima (oracle synthesis + evidence list).
3. The next facades clearly respond to previous choices.
4. The UI shows named agents working in parallel or near-parallel.
5. A prototype pane starts changing before the final reveal.

Anything that does not improve one of those five outcomes is out of scope for V0.

---

## User Experience

1. The user enters a short product intent such as `weather app for runners`.
2. The server creates a session (pure code, no LLM), starts scouts which generate their first probes from just the intent.
3. The user sees one facade at a time and swipes `accept` or `reject`.
4. Every facade shows a hypothesis, agent name, and stage-appropriate content.
5. Every swipe updates the evidence list, oracle synthesis (every 4 swipes), builder draft, and agent activity.
6. After roughly 8-14 swipes, the user can inspect a coherent draft prototype built from the accumulated taste model, well before the auto-reveal threshold.

---

## V0 Scope

### Must Ship

- intent input and session creation (pure code, no axis seeding LLM call)
- swipeable facade feed (custom PointerEvent handler, `performance.now()` for latency capture)
- SSE updates from server to client (native `ReadableStream` + `text/event-stream`)
- visible Anima panel (oracle synthesis: emergent axes with confidence badges, edge case flags, divergence)
- named scout agents with live status
- evolving builder draft pane (starts from intent-seed, grows with each swipe)
- builder probe briefs (construction-grounded questions that drive scout priorities)
- queue buffering so the user is rarely waiting
- words stage
- HTML mockup stage
- oracle evidence synthesis every 4 swipes
- final reveal state

### Stretch

- diversity check (reject scout output overlapping >70% with last 3 facades)

### Explicitly Cut

- fract spawning / child scouts / agent retirement
- Anima compaction (evidence summarization)
- true BALD selection / orthogonal axis discovery
- interactive snippet stage / Veo / motion
- artifact assembly from multiple real code fragments

---

## Core Simplifications

| Vision Spec | Lean V0 (Akinator) |
|---|---|
| Hierarchical Anima tree with confidence | Evidence list + oracle synthesis (LLM navigates hyperspace implicitly) |
| BALD over tree, coded axis selection | Scout identifies gaps from evidence, not code |
| TasteAxis seeding from intent | No seeding — first probes ARE the seed questions |
| Axis-based YAML serialization | Evidence serialization (`toEvidencePrompt()`) |
| Coded confidence deltas per swipe | Just append to evidence array |
| Stage transitions by swipe count | Oracle concreteness floor + scout format choice |
| Compaction and contradiction handling | Oracle synthesis every 4 swipes |

These are implementation cuts, not product cuts.

---

## Runtime Architecture

This section describes the landed V0 runtime: a per-session reservoir design for a short warmup followed by fast 42-swipe sessions. The full architecture rationale is in `specs/0-spec.md` under `Hot Session Runtime`.

### Deploy

Vercel with Fluid Compute (adapter-vercel, Node.js runtime). Module-level in-memory session registry. Set `maxDuration: 300` on long-lived routes. `.research/synthesis-runtime`

### Server

`EyeLoopSession` in `src/lib/server/session/eye-loop-session.ts` owns per-session state and a session-local `EventEmitter`. `src/lib/server/session/registry.ts` maps `sessionId -> EyeLoopSession`. `src/lib/server/session/runtime.ts` owns bootstrap, reservoir refill, scout production, synthesis, builder patching, and reveal prep.

Session state:

- `intent`
- `swipeCount`
- `stage`
- `evidence: SwipeEvidence[]`
- `synthesis: TasteSynthesis | null`
- `facades: Facade[]`
- `probes: ProbeBrief[]`
- `agents: Map<string, AgentState>`
- `draft: PrototypeDraft`
- `antiPatterns: string[]`
- `tasteVersion`
- `queueStats`
- `reveal`

### Client

The main page renders:

- intent entry
- swipe feed
- Anima panel (oracle synthesis, not confidence bars)
- prototype draft panel
- agent activity rail

### Agent Roles

#### Scout

Scouts are Akinator for taste. Each reads evidence + oracle synthesis (emergent axes + axis assignment + queue contents) and generates informative probes into the shared reservoir. Scouts are producers; the reservoir owns readiness, draw order, and stale eviction. `specs/4-akinator.md`

Loop:

1. read evidence history + oracle synthesis (emergent axes, scout assignment, edge case flags) + queue contents for de-duplication + any builder probe brief
2. generate one facade targeting the biggest gap in taste knowledge (LLM decides, not code)
   - format chosen by scout based on evidence depth, gated by oracle concreteness floor
   - **words:** `SCOUT_MODEL` (default: Claude Haiku 4.5) with `Output.object()`
   - **mockups:** `SCOUT_MODEL` (default: Claude Haiku 4.5) generating HTML
3. push it into the session reservoir with `tasteVersion`, `createdAt`, and `generationReason`
4. return; swipe handling is session-owned and never waits on a scout

Model bindings live in `src/lib/server/ai.ts`. Images are cut in the landed runtime — `Facade.format` is `'word' | 'mockup'` only. Temperature: `1.0` for scouts (creative generation).

#### Builder

The builder never creates facades. Temperature: `0`. Two triggers:

1. **On session-created:** generate initial draft scaffold from intent (prototype pane never empty)
2. **On swipe-result:** update draft from evidence asynchronously. Accept = reinforce. Reject = add anti-pattern (PROHIBITIONS). Emit probe briefs when construction is blocked.
3. **Before reveal:** prepare a shadow reveal starting around swipe 8 and force a prep pass near swipe 36 so swipe 42 is mostly a transition.

#### Oracle

The oracle has two roles. `specs/4-akinator.md`, `specs/scope/v0/07-oracle.md`

**Code (every swipe):**
- Concreteness floor: `< 4 evidence = word, >= 4 = mockup` (two-tier; images cut)
- Reveal trigger: evidence >= 42
- Queue pressure: `session.queueStats` from the reservoir

**LLM (every 4 swipes):**
- Evidence synthesis via `generateText` at temperature 0
- Produces `TasteSynthesis`: emergent axes (3-5 discovered taste dimensions with confidence levels), edge case flags, scout assignments (each scout assigned a different axis), persona_anima_divergence
- Injected into scout + builder prompts for coordination
- Shown in Anima panel as emergent axes with confidence badges (unprobed/exploring/leaning/resolved)

---

## Data Contract

Source of truth: `src/lib/context/types.ts`. The shapes below mirror the landed TypeScript types; when the code diverges, types.ts wins and this block gets re-aligned.

```ts
type Stage = 'words' | 'mockups' | 'reveal';

interface SwipeEvidence {
  facadeId: string;
  content: string;
  hypothesis: string;
  decision: 'accept' | 'reject';
  latencySignal: 'fast' | 'slow';
  format: 'word' | 'mockup';
  implication: string;  // design signal copied from facade.acceptImplies / rejectImplies
}

interface Facade {
  id: string;
  agentId: string;
  hypothesis: string;
  axisTargeted?: string;    // label of the taste axis this probe targets — drives scout dedup
  label: string;
  content: string;
  format: 'word' | 'mockup';
  acceptImplies?: string;   // design implication if user accepts
  rejectImplies?: string;   // design implication if user rejects
}

interface SwipeRecord {
  facadeId: string;
  agentId: string;
  decision: 'accept' | 'reject';
  latencyMs: number;
  latencyBucket?: 'fast' | 'slow';
}

interface AgentState {
  id: string;
  name: string;
  role: 'scout' | 'builder' | 'oracle';
  status: 'idle' | 'thinking' | 'queued' | 'waiting';
  focus: string;
  lastFacadeId?: string;
}

interface PrototypeDraft {
  title: string;
  summary: string;
  html: string;
  acceptedPatterns: string[];
  rejectedPatterns: string[];
  nextHint?: string;
}

interface ProbeBrief {
  source: string;
  priority: 'high' | 'normal';
  brief: string;
  context: string;
  heldConstant: string[];
}

interface EmergentAxis {
  label: string;
  poleA: string;
  poleB: string;
  confidence: 'unprobed' | 'exploring' | 'leaning' | 'resolved';
  leaning_toward: string | null;
  evidence_basis: string;
}

interface Palette {
  bg: string;
  card: string;
  accent: string;
  text: string;
  muted: string;
  radius: string;
}

interface TasteSynthesis {
  axes: EmergentAxis[];
  edge_case_flags: string[];
  palette?: Palette;  // derived from accepted evidence on the runSynthesis path; cold-start omits
  scout_assignments: Array<{
    scout: 'Iris' | 'Prism' | 'Lumen' | 'Aura' | 'Facet' | 'Echo';
    probe_axis: string;
    reason: string;
  }>;
  persona_anima_divergence: string | null;
}

// SSE wire union — everything pushed from bus to /api/stream clients.
// Derived SSEEventMap + SSEEventType in types.ts keep bus helpers aligned.
type SSEEvent =
  | { type: 'facade-ready'; facade: Facade }
  | { type: 'facade-stale'; facadeId: string }
  | { type: 'swipe-result'; record: SwipeRecord }
  | { type: 'evidence-updated'; evidence: SwipeEvidence[]; antiPatterns: string[] }
  | { type: 'agent-status'; agent: AgentState }
  | { type: 'draft-updated'; draft: PrototypeDraft }
  | { type: 'builder-hint'; hint: string }
  | { type: 'stage-changed'; stage: Stage; swipeCount: number }
  | { type: 'synthesis-updated'; synthesis: TasteSynthesis }
  | { type: 'session-ready'; intent: string }
  | {
      type: 'error';
      source: 'scout' | 'oracle' | 'builder';
      code: 'provider_auth_failure' | 'provider_error' | 'generation_error';
      agentId?: string;
      message: string;
    };
```

No `TasteAxis`. No `axisId`. No coded confidence scores. Axes are emergent — discovered by the oracle from evidence patterns. `specs/4-akinator.md`

`Facade.axisTargeted` is a free-form label (e.g. `"look-and-feel"`) used only for scout-side dedup, not a typed identifier — it does not reintroduce the removed coded-axis model.

---

## Stage Rules

Concreteness floor is session-owned. See `EyeLoopSession.concretenessFloor` in `src/lib/server/session/eye-loop-session.ts`:

| Evidence Depth | Floor | Scout Can Choose |
|---------------|-------|-----------------|
| < 4 swipes | `word` | word only |
| >= 4 swipes | `mockup` | mockup only |

Format instruction injected into scout prompt:
- "You have 2 swipes of evidence. This is early exploration — use a single evocative WORD."
- "You have 6 swipes. Describe a concrete MOCKUP with layout details."

Image facades were cut from V0 — benchmarks showed scouts naturally skip the image stage (word → mockup), and the landed runtime has no image-capable provider wired up.

---

## Anima Model

The Anima is NOT a stored data structure. It is the LLM's inference from the evidence corpus, recomputed every time a scout or builder reads the context. The oracle's synthesis (every 4 swipes) produces emergent axes — structured taste dimensions discovered from evidence patterns, with confidence levels (unprobed/exploring/leaning/resolved).

No axis seeding. No coded confidence scores. No YAML distributions. The evidence list + anti-patterns + emergent axes synthesis IS the taste model.

---

## Queue Rules

- warm start: block until at least `12` ready facades or warmup timeout
- target queue size: top off toward `20`, cap at `24`, treat `< 8` as low water
- `session.queueStats`: UI-visible ready/pending/min/target/max/stale reservoir counts
- staleness: facades older than the taste-version lag are pruned when synthesis updates
- diversity: skip duplicate queued labels or targeted axes

---

## UI Contract

Required visual signals:

- every card shows the tested hypothesis
- the Anima panel shows emergent axes with confidence badges (unprobed/exploring/leaning/resolved), edge case flags, and persona-anima divergence — NOT flat text lists or confidence bars
- accepted/rejected facade thumbnails as visual history
- anti-patterns list (what the system will never show again)
- agents have names and statuses
- the builder draft updates during the session, not only at the end
- the builder can surface probe briefs as "what I need to know next"
- the reveal feels like something that has been growing in the background

Do not hide the system behind a single output pane.

---

## Failure Plan

If mockup generation is unstable:
- keep words stage working
- generate simpler HTML cards instead of full-page mockups

If parallel generation is unstable:
- keep one real scout loop
- show multiple agent identities only when they have real state changes

If scouts produce repetitive facades:
- add diversity check: reject output overlapping >70% with last 3 facades and retry

If a scout hits content filters:
- route error back to scout for retry with different framing
- don't crash the loop

If latency becomes a problem:
- Haiku 4.5 is the fast tier — no further model downgrade inside the Anthropic roster
- pre-generate facade buffer before user sees first card

If the fast tier misbehaves:
- Tune `SCOUT_MODEL_ID`, `ORACLE_MODEL_ID`, `BUILDER_MODEL_ID`, or `REVEAL_MODEL_ID` in env to move individual roles between Claude SKUs without touching call sites.
- Provider auth uses `CLAUDE_CODE_OAUTH_TOKEN` via the Claude Code OAuth headers (`x-api-key: ''`, `Authorization: Bearer <token>`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`). See `specs/3-models.md`.

---

## SDK Integration Notes

Code-verified against actual npm packages. See `package.json` for pinned versions.

```bash
pnpm add ai@6.0.134 @ai-sdk/anthropic@^3.0.64 zod@^3.24.0
```

| What | How | Reference |
|------|-----|-----------|
| Text facades | `generateText()` with `SCOUT_MODEL` (default: Claude Haiku 4.5) from `$lib/server/ai` | `specs/3-models.md` |
| HTML mockups | `generateText()` with `SCOUT_MODEL` (default: Claude Haiku 4.5) through structured scout schemas | `src/lib/server/session/runtime.ts` |
| Builder scaffold / rebuild | `generateText()` with `BUILDER_MODEL` (default: Claude Haiku 4.5) | `src/lib/server/session/runtime.ts` |
| Oracle cold-start / synthesis | `generateText()` with `ORACLE_MODEL` (default: Claude Haiku 4.5) | `src/lib/server/session/runtime.ts` |
| Quality reveal | `REVEAL_MODEL` (default: Claude Sonnet 4.6) for builder reveal | `src/lib/server/ai.ts` |
| Structured output | `output: Output.object({ schema: z.object({...}) })` — avoid `z.union()` | `.research/synthesis-sdk-verified` |
| SSE | Native `ReadableStream` + `text/event-stream` (custom bus, not AI SDK streaming) | `.research/synthesis-runtime` |
| Provider auth | Claude Code OAuth headers on `createAnthropic({ apiKey: 'x', headers: { Authorization: 'Bearer <token>', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', ... } })` | `src/lib/server/ai.ts` |

```
CLAUDE_CODE_OAUTH_TOKEN=   # required; provider call 401s without it
```

---

## Decision Rule

When in doubt, choose the simpler implementation that preserves the illusion of taste discovery.

The product is the feeling that the system is learning what the user means before they can fully say it.
