# The Akinator Pattern — Validated Architecture

**Status:** Validated via `scripts/bench-akinator.mjs` (H1-H3), `scripts/bench-akinator-flow.mjs` (full loop, 4/5), and `scripts/bench-emergent-axes.mjs` (3/3 scout diversity across all edge cases).

---

## The Insight

The Anima is not a parameter vector. It's the **compensation of the persona** — it exists in the gap between what the user said ("personal finance app") and what they actually chose (warm, companion-like, conversational, anti-spreadsheet).

We don't decompose swipes into axis updates. We encode the raw evidence (accept/reject + content + hypothesis + latency) and let the LLM navigate the hyperspace implicitly. The scout is Akinator for taste.

---

## What Changed

### Before (axis-based)
```
TasteAxis { id, label, options: [A, B], confidence: 0-1, leaning, evidenceCount }
→ code computes confidence delta per swipe
→ YAML serializes axes with distributions
→ scout targets lowest-confidence axis
→ stages driven by swipe count
```

### After (evidence-based)
```
Evidence[] { content, hypothesis, decision, latency_signal }
→ evidence list grows with each swipe
→ scout reads evidence + oracle synthesis, generates next probe
→ oracle synthesizes every N swipes (LLM) — the strategic brain
→ builder reads same evidence + synthesis, extracts construction decisions
→ concreteness gated by oracle floor, chosen by scout
```

---

## Evidence Format

```typescript
interface SwipeEvidence {
  facadeId: string;
  content: string;          // what was shown (word, image desc, mockup desc)
  hypothesis: string;       // what the scout was testing
  decision: 'accept' | 'reject';
  latencySignal: 'fast' | 'slow';  // slow = hesitant = near boundary = most informative
}
```

Serialized for prompts as:
```
1. [ACCEPT] "Companion"
   Hypothesis: Does the user want a tool that feels like a helper or a dashboard?

2. [REJECT] "Precision"
   Hypothesis: Does the user want clinical exactness or something looser?

3. [REJECT (hesitant)] "Ledger"
   Hypothesis: Does the user want traditional accounting aesthetics?
```

No user reasoning is stored — only what the system captures: content, hypothesis, decision, latency.

---

## Oracle: Emergent Axes (LLM)

The oracle is NOT pure code. It has a critical LLM role: **discovering emergent taste axes** from the evidence every 4 swipes.

Axes are not seeded upfront. They are the oracle's INTERPRETATION of the evidence — a structured, actionable summary that scouts, builder, and the Anima panel all consume. The evidence is the source of truth; axes are a derived lens.

### Oracle Synthesis Prompt (validated)

```
You are the Oracle — the strategic brain of a taste discovery system.

The user said they want to build: "{INTENT}"

FULL EVIDENCE (accept/reject + latency only — no user reasoning):

{EVIDENCE}

Analyze the evidence and produce EMERGENT TASTE AXES — dimensions that
have revealed themselves through the user's choices. These are NOT
pre-seeded. They are DISCOVERED from patterns in the evidence.

For each axis:
- label: short name for the taste dimension
- poleA / poleB: the two ends discovered from evidence
- confidence: unprobed | exploring | leaning | resolved
- leaning_toward: which pole (null if exploring/unprobed)
- evidence_basis: which accepts/rejects support this

Also produce:
- edge_case_flags: patterns needing special handling
- scout_assignments: for 3 scouts, assign each a DIFFERENT axis
- persona_anima_divergence: where revealed taste diverges from intent
```

### Oracle Synthesis Output

```typescript
interface EmergentAxis {
  label: string;
  poleA: string;
  poleB: string;
  confidence: 'unprobed' | 'exploring' | 'leaning' | 'resolved';
  leaning_toward: string | null;
  evidence_basis: string;
}

interface TasteSynthesis {
  axes: EmergentAxis[];
  edge_case_flags: string[];      // "user accepts everything", "axis X contradictory"
  scout_assignments: Array<{
    scout: string;                 // "Alpha" | "Beta" | "Gamma"
    probe_axis: string;            // which emergent axis to probe
    reason: string;
  }>;
  persona_anima_divergence: string | null;
}
```

### What the synthesis enables

1. **Scout coordination** — each scout is assigned a different emergent axis. No duplication. Validated: 3/3 unique axes across all 3 edge case scenarios.
2. **Edge case handling** — oracle flags "all responses hesitant", "axis X contradictory", "user not discriminating". Scouts adapt their strategy accordingly.
3. **Anima panel** — emergent axes with confidence levels ARE the visible taste model.
4. **Builder grounding** — knows which axes are resolved (build from), exploring (wait), or contradictory (needs probe).
5. **Divergence detection** — persona-anima gaps detected unprompted:
   > *"The user claims to want a 'personal finance app' but rejects the core utility of financial tools."*

### How scouts use emergent axes

Scouts are NOT assigned to fixed axes. They grab on the fly:

1. Read evidence + oracle synthesis (which includes emergent axes + assignments)
2. Read the current facade queue ("these probes are already pending")
3. Follow their assignment OR pick the most uncertain axis not already being served
4. Generate probe, push to queue, wait for swipe

The oracle's assignments are a **menu**, not a leash. Between syntheses, scouts self-coordinate via queue visibility.

### Edge case handling (validated)

| User Pattern | Oracle Flags | Scout Behavior |
|-------------|-------------|----------------|
| Normal (clear preferences) | Flags density conflict | Scouts probe 3 different axes |
| Contradictory (flip-flops) | "all hesitant" + "contradictory evidence" | Scouts probe the conflict directly |
| Reject-everything | "all hesitant" + "contradictory" | Scouts pivot to radically different directions |

### Oracle cadence

- Every 4 swipes (validated — enough evidence per round for meaningful synthesis)
- Uses FAST_MODEL (Claude Haiku 4.5, `src/lib/server/ai.ts`) at temperature 0
- ~3s latency — runs in background between swipes, doesn't block UI

---

## Scout Prompt (validated)

```
You are {SCOUT_NAME} — a taste scout generating the next probe.

{SCOUT_LENS}

The user wants to build: "{INTENT}"

EVIDENCE:
{EVIDENCE}

EMERGENT TASTE AXES (discovered by Oracle):
{axes_summary}
{edge_case_flags}
{persona_anima_divergence}

YOUR ASSIGNMENT: Probe "{assigned_axis}" — {assignment_reason}

ALREADY IN QUEUE (do NOT duplicate):
{queued_probes}

{FORMAT_INSTRUCTION}

RULES:
- Do NOT duplicate what's already queued
- Probe YOUR assigned axis or the most uncertain one
- Do NOT repeat patterns the user already rejected
- Think like Akinator — maximally partition the remaining space
```

### Scout Lenses (dedup mechanism #1)

Each scout has a permanent personality that biases toward a different domain. This prevents cold-start duplication (before oracle assigns axes) and provides natural diversity between synthesis rounds.

```typescript
const SCOUT_LENSES = {
  Iris:  'You naturally gravitate toward VISUAL and SENSORY questions — color, texture, materiality, atmosphere, visual weight.',
  Prism: 'You naturally gravitate toward INTERACTION and STRUCTURE questions — navigation, density, information flow, layout, hierarchy.',
  Lumen: 'You naturally gravitate toward IDENTITY and NARRATIVE questions — tone, personality, brand voice, emotional arc, metaphor.',
} as const;
```

The lens is permanent — it doesn't change between syntheses. Oracle assignments override the lens when present ("probe this specific axis") but the lens biases what the scout generates when self-assigning.

### Queue Dedup Check (dedup mechanism #2)

After generating a probe but before pushing to queue, check for axis overlap:

```typescript
// After generateText, before context.pushFacade:
const isDuplicate = context.facades.some(f =>
  f.hypothesis.toLowerCase().includes(output.axis_targeted.toLowerCase()) ||
  output.axis_targeted.toLowerCase().includes(f.hypothesis.toLowerCase().split(' ').slice(0, 3).join(' '))
);
if (isDuplicate) continue; // regenerate
```

This catches race conditions where two scouts generate simultaneously and target the same gap.

### Staggered Starts (dedup mechanism #3)

Don't fire all 3 scouts at t=0. Stagger by 500ms:

```typescript
export function startAllScouts(): void {
  startScout('scout-01', 'Iris');
  setTimeout(() => startScout('scout-02', 'Prism'), 500);
  setTimeout(() => startScout('scout-03', 'Lumen'), 1000);
}
```

First scout's probe lands in queue before the second scout starts generating. Combined with queue visibility in the prompt, natural dedup.

### Required scout prompt injections

1. **Scout lens** — permanent personality bias (visual / interaction / narrative)
2. **Evidence history** — raw evidence list
3. **Emergent axes** — from oracle synthesis (after first 4 swipes)
4. **Scout assignment** — which axis this scout should probe, from oracle
5. **Queue contents** — facades already pending, to prevent duplication
6. **Format instruction** — concreteness floor from oracle

### Before first oracle synthesis (swipes 1-3)

Scouts get intent + evidence + their lens (no axes, no assignment). The lens ensures Iris probes something visual, Prism probes something structural, and Lumen probes something narrative — three different first questions without any coordination infrastructure.

**Benchmark:** 3/3 scout diversity across all edge cases (with oracle assignments). Cold start diversity depends on lenses (not yet benchmarked in codebase — needs implementation).

---

## Concreteness Floor (Oracle-Gated)

The scout chooses format, but the oracle sets a minimum floor:

| Evidence Depth | Floor | Scout Can Choose |
|---------------|-------|-----------------|
| < 4 swipes | `word` | word only |
| 4-7 swipes | `image` | image or mockup |
| 8+ swipes | `mockup` | mockup only |

Format instruction injected into scout prompt:
- "You have 2 swipes of evidence. This is early exploration — use a single evocative WORD."
- "You have 6 swipes. Describe an IMAGE or moodboard."
- "You have 10 swipes. Describe a concrete MOCKUP with layout details."

**Finding:** Scout naturally skips image stage, going word → mockup. Images are optional — the scout generates them when testing visual direction, not as a mandatory stage.

---

## Builder Prompt (validated)

```
You are the builder agent. You assemble a prototype from what users
have shown through their choices — not from what they said.

The user said they want to build: "{INTENT}"

EVIDENCE HISTORY:

{EVIDENCE}

ORACLE SYNTHESIS (if available):
Known: {known}
Unknown: {unknown}
Guidance: {guidance}

RULES:
- Ground everything in the evidence
- Anti-patterns (rejected things) are HARD CONSTRAINTS
- Reference specific accepted/rejected items as justification
- Probe briefs must be about SPECIFIC UI COMPONENTS, not abstract dimensions
```

**Benchmark:** 6/6 quality checks, consistent across runs.

---

## What Gets Dropped

| V0 Concept | Status | Why |
|-----------|--------|-----|
| `TasteAxis` type | **Replace** with `EmergentAxis` | Axes are oracle output, not seeded input |
| `confidence: number` | **Drop** | LLM infers confidence from evidence density |
| `leaning?: string` | **Drop** | Embedded in accept/reject history |
| `toAnimaYAML()` serializer | **Replace** with `toEvidencePrompt()` | Serialize evidence list, not axis distributions |
| `getMostUncertainAxis()` | **Drop** | Scout identifies gaps from evidence, not code |
| `addEvidence()` confidence delta | **Simplify** | Just append to evidence array |
| Swipe-count stage transitions | **Replace** | Oracle concreteness floor + scout format choice |
| Axis seeding prompt | **Replace** | Oracle cold-start: 3 intent-specific hypotheses, not 5-7 generic axes |

---

## What Stays

| Concept | Status | Why |
|---------|--------|-----|
| **Persona (intent string)** | Keep | Anchor for every prompt |
| **Anti-patterns** | Keep | Builder extracts from rejections, scouts respect as hard constraints |
| **Builder probe briefs** | Keep | Construction-grounded questions still drive scout priorities |
| **Event bus** | Keep | Swipe events, facade-ready, etc. |
| **SSE to client** | Keep | Stream evidence + synthesis updates to client |
| **Queue buffering (3-5)** | Keep | Facade queue still needed |
| **Oracle (code + LLM)** | Keep | Code: queue health, floor, reveal. LLM: emergent axes every 4 swipes. |
| **Emergent axes** | **New** | Oracle discovers axes from evidence. Scouts grab on the fly. Anima panel shows them. |
| **Latency signal** | Keep | `slow` = hesitant = boundary = most informative |

---

## Anima Panel (UI)

The Anima panel shows **emergent axes**, not pre-seeded confidence bars:

1. **Emergent axes** — label + poles + confidence level (unprobed/exploring/leaning/resolved). These appear and evolve as the oracle discovers them. Visually alive — axes emerge, shift, resolve.
2. **Persona-anima divergence** — highlighted when detected ("You said finance app, but you keep choosing contemplative journal-like interfaces")
3. **Accepted/rejected facade thumbnails** — visual history of what survived
4. **Edge case flags** — surfaced when oracle detects contradictions or hesitation patterns

---

## Compaction

After ~15-20 facades, context gets long. Compaction = evidence summarization:

```
Every N swipes (or when evidence > 15 entries):
  LLM reads full evidence history
  Outputs compressed summary
  Summary replaces old entries (keeps last 5 raw + summary of older)
```

This is the oracle's synthesis job, extended — the synthesis already summarizes what's known. Compaction just makes it replace old evidence entries to keep context manageable.

---

## Cold Start — Oracle Intent Analysis

On session init, the oracle does ONE fast LLM call to analyze the intent and produce 3 intent-specific first hypotheses — one per scout. This replaces axis seeding AND solves cold-start diversity.

### Why

Generic lenses (visual/structure/voice) don't know that "ai workspace" should probe canvas-vs-linear, realtime-vs-async, solo-vs-collaborative. The intent itself contains domain-specific axes that lenses can't infer. The oracle reads the intent and produces hypotheses grounded in what THIS product needs to discover.

### Cold Start Prompt

```
You are the Oracle. A user just started a session.

INTENT: "{INTENT}"

Produce 3 FIRST QUESTIONS — one for each scout. These are the opening
Akinator moves. Each question should probe a different taste dimension
that matters specifically for THIS product.

For each:
- scout: Iris | Prism | Lumen
- hypothesis: what accept vs reject would reveal
- word_probe: the 1-3 word label the user will see (PLAIN LANGUAGE, not jargon)

Iris probes look and feel. Prism probes layout and interaction. Lumen probes voice and personality.

RULES:
- Questions must be INTENT-SPECIFIC, not generic design axes
- word_probe must be understandable in 1 second by a normal person
- Each question should target a DIFFERENT dimension
- Good: "Dark workspace" (tests atmosphere), "Sidebar tools" (tests layout), "Friendly helper" (tests personality)
- Bad: "Biophilic brutalism" (jargon), "Ephemeral layering" (nonsense), "Synaptic echo" (pretentious)
```

### Cold Start Output

```typescript
interface ColdStartHypothesis {
  scout: 'Iris' | 'Prism' | 'Lumen';
  hypothesis: string;
  word_probe: string;
}

type ColdStartOutput = ColdStartHypothesis[];
```

### Cold Start Flow

```
1. context.reset(); context.intent = intent;
2. Oracle cold-start LLM call (~2s, Flash Lite, temperature 0)
   → produces 3 intent-specific hypotheses
3. Store as initial scout assignments on context.synthesis
4. Fire 3 scouts staggered by 500ms
5. Each scout reads its cold-start assignment instead of self-assigning
6. Queue fills with 3 intent-specific word facades
7. First facade visible in ~2-3s
```

### Cold Start vs Full Synthesis

| | Cold Start | Full Synthesis |
|---|---|---|
| **When** | Session init (0 evidence) | Every 4 swipes |
| **Input** | Intent string only | Full evidence history |
| **Output** | 3 hypotheses + word probes | Emergent axes + assignments + flags |
| **Model** | Flash Lite (fast, ~2s) | Flash Lite (3s) or Pro |
| **Stored as** | Initial `context.synthesis` with 3 unprobed axes | Full `TasteSynthesis` replacing prior |

The cold-start output can be structured as a lightweight `TasteSynthesis` with 3 axes at confidence `unprobed`, so scouts read it through the same code path as full synthesis. No special casing needed.

### Example

Intent: "ai workspace"

```
Iris   → "Dark canvas"     — Does the user want a dark, immersive workspace or a bright, airy one?
Prism  → "Infinite scroll"  — Does the user want a spatial canvas or a structured document flow?
Lumen  → "Copilot chat"    — Does the user want AI as a visible companion or an invisible engine?
```

Intent: "recipe app for people who hate cooking"

```
Iris   → "Cozy kitchen"    — Does the user want warm homey vibes or clean clinical efficiency?
Prism  → "One big button"  — Does the user want extreme simplicity or browsable variety?
Lumen  → "Friendly coach"  — Does the user want encouragement or just-the-facts instructions?
```

---

## Implementation Priority

1. **`types.ts`** — replace `TasteAxis` with `SwipeEvidence` + `EmergentAxis` + `TasteSynthesis`, drop `axisId` from `Facade`
2. **`context.ts`** — evidence array, `toEvidencePrompt()`, store latest `TasteSynthesis`
3. **Oracle** — drop axis seeding, add emergent axis synthesis every 4 swipes (LLM), scout assignments, edge case flags, keep code guardrails
4. **Scout prompt** — evidence + emergent axes + assignment + queue visibility + format gate
5. **Builder prompt** — evidence + emergent axes based
6. **Anima panel** — show emergent axes with confidence + divergence
7. **Queue visibility** — pass current facade queue contents to each scout prompt

---

## Validation Artifacts

- **Isolated tests:** `scripts/bench-akinator.mjs` → `scripts/findings/akinator-validation.md` (H1-H3, all pass)
- **Full flow:** `scripts/bench-akinator-flow.mjs` → `scripts/findings/akinator-flow-v2.md` (12-swipe sim, 4/5)
- **Emergent axes:** `scripts/bench-emergent-axes.mjs` → `scripts/findings/emergent-axes.md` (3/3 diversity, all edge cases handled)
- **Edge cases:** `scripts/bench-edge-cases.mjs` → `scripts/findings/research-bench.md` (builder HTML 6/6)
- **Key finding:** Oracle discovers 3-5 emergent axes from evidence and assigns scouts to different ones
- **Key finding:** Edge case flags (contradictory, reject-all, all-hesitant) surface automatically
- **Key finding:** Persona-anima divergence detection works unprompted
- **Key finding:** Scout diversity: 3/3 unique axes when using assignments + queue visibility
- **Key finding:** Images stage is optional — word → mockup is the natural progression
