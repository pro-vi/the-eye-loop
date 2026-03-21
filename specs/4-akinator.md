# The Akinator Pattern — Validated Architecture

**Status:** Validated via `scripts/bench-akinator.mjs` on 2026-03-21. All 3 hypotheses pass.

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
→ scout reads raw evidence + persona, generates next probe
→ builder reads same evidence, extracts construction decisions
→ concreteness emerges from information density
```

---

## Evidence Format

```typescript
interface SwipeEvidence {
  content: string;          // what was shown (word, image desc, mockup desc)
  hypothesis: string;       // what the scout was testing
  decision: 'accept' | 'reject';
  latency_signal: 'fast' | 'slow';  // slow = hesitant = near boundary = most informative
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

---

## Scout Prompt (validated)

```
You are a taste scout — your job is to generate the next visual probe
that will be most informative about this user's preferences.

The user said they want to build: "{INTENT}"

EVIDENCE HISTORY (accept = they liked it, reject = they didn't,
hesitant = they took a long time to decide):

{EVIDENCE}

RULES:
- Do NOT repeat patterns the user already rejected
- Do NOT re-confirm things we already know
- Target the GAPS — what aspects of their taste are we still uncertain about?
- A probe the user would HESITATE on is more informative than one they'd
  instantly accept or reject
- Think like Akinator — each question should maximally partition the
  remaining possibility space
```

**Benchmark:** 6/6 quality checks on every run across 3 evidence depths (3, 8, 13 swipes). Zero failures.

---

## Builder Prompt (validated)

```
You are the builder agent. You assemble a prototype from what users
have shown through their choices — not from what they said.

The user said they want to build: "{INTENT}"

EVIDENCE HISTORY:

{EVIDENCE}

RULES:
- Ground everything in the evidence
- Anti-patterns (rejected things) are HARD CONSTRAINTS
- Reference specific accepted/rejected items as justification
- Probe briefs must be about SPECIFIC UI COMPONENTS, not abstract dimensions
```

**Benchmark:** 6/6 quality checks, identical output across 3 runs. Builder consistently identifies buildable components, extracts anti-patterns from rejections, and produces construction-grounded probe briefs.

---

## Emergent Concreteness

Facade format emerges from information density — no swipe-count stages needed:

| Evidence Depth | Emergent Format | Why |
|---------------|-----------------|-----|
| 3 swipes | **Word** ("Gardener", "Organic Growth") | Too little evidence for visual specifics |
| 8 swipes | **Mockup description** | Model feels confident enough to describe specific UI |
| 13 swipes | **Detailed mockup** with layout specifics | Strong evidence constrains the space |

The model skips the "image/moodboard" stage — it goes word → mockup. This suggests images are a scout-chosen format when the model wants to test visual direction, not a mandatory stage.

**Implementation:** Let the scout choose format. The oracle can set a minimum concreteness floor as a guardrail ("you have 8+ swipes of evidence, you may generate mockups") but should not force stages.

---

## What Gets Dropped

| V0 Concept | Status | Why |
|-----------|--------|-----|
| `TasteAxis` type | **Drop** | No explicit axes — evidence IS the model |
| `confidence: number` | **Drop** | LLM infers confidence from evidence density |
| `leaning?: string` | **Drop** | Embedded in accept/reject history |
| `toAnimaYAML()` serializer | **Replace** | Serialize evidence list, not axis distributions |
| `getMostUncertainAxis()` | **Drop** | Scout identifies gaps from evidence, not code |
| `addEvidence()` confidence delta | **Simplify** | Just append to evidence array |
| Swipe-count stage transitions | **Replace** | Scout chooses format; oracle guardrails |
| Axis seeding prompt | **Replace** | First few probes ARE the seed questions |

---

## What Stays

| Concept | Status | Why |
|---------|--------|-----|
| **Persona (intent string)** | Keep | Anchor for every prompt |
| **Anti-patterns** | Keep | Builder extracts from rejections, scouts respect as hard constraints |
| **Builder probe briefs** | Keep | Construction-grounded questions still drive scout priorities |
| **Event bus** | Keep | Swipe events, facade-ready, etc. |
| **SSE to client** | Keep | Stream evidence updates + agent status |
| **Queue buffering (3-5)** | Keep | Facade queue still needed |
| **Oracle (code)** | Keep | Queue health, guardrails, reveal trigger |
| **Latency signal** | Keep | `slow` = hesitant = boundary = most informative |

---

## Anima Panel (UI)

The Anima panel can't show confidence bars anymore. Instead it shows the **evidence story**:

Options:
1. **Accepted/rejected facade thumbnails** — visual history of what survived and what didn't
2. **LLM-generated taste summary** — regenerated after each swipe (like a compaction step)
3. **Tag cloud** — extracted keywords from accepted (+) and rejected (-) facades
4. **Divergence indicator** — where revealed preference diverges from stated intent

The most demo-impressive option is probably #1 + #2: show the facade history visually AND a one-line taste summary that updates live.

---

## Compaction

With raw evidence, context window becomes the constraint. After ~15-20 facades, the evidence list gets long. Compaction becomes:

```
Every N swipes:
  LLM reads full evidence history
  Outputs a compressed summary: "The user wants X, rejects Y, is uncertain about Z"
  Summary replaces old evidence entries (keeps last 5 raw + summary of older)
```

This is the same role as before but simpler — no axis YAML rewriting, just evidence summarization.

---

## Implementation Priority

1. **Simplify `types.ts`** — replace `TasteAxis` with `SwipeEvidence`, simplify `Facade` (drop `axisId`)
2. **Simplify `context.ts`** — evidence array replaces axis map, `addEvidence()` just pushes
3. **Rewrite scout prompt** — use validated Akinator prompt from this doc
4. **Rewrite builder prompt** — use validated builder prompt from this doc
5. **Update Anima panel** — show evidence story instead of confidence bars
6. **Add oracle guardrail** — minimum evidence depth for format escalation

---

## Validation Artifacts

- **Script:** `scripts/bench-akinator.mjs`
- **Report:** `scripts/findings/akinator-validation.md`
- **Raw results:** all 21 API calls logged with full output and quality scores
