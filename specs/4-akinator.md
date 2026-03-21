# The Akinator Pattern — Validated Architecture

**Status:** Validated via `scripts/bench-akinator.mjs` (H1-H3) and `scripts/bench-akinator-flow.mjs` (full loop). 4/5 quality checks pass on full 12-swipe simulation.

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

## Oracle: Evidence Synthesis (LLM)

The oracle is NOT pure code. It has a critical LLM role: **evidence synthesis** every 4 swipes.

Scouts are individual Akinator instances — each sees evidence and generates one probe. The oracle watches the whole game. Without it, scouts duplicate work and miss strategic patterns.

### Oracle Synthesis Prompt (validated)

```
You are the Oracle — the strategic brain of a taste discovery system.

The user said they want to build: "{INTENT}"

FULL EVIDENCE (accept/reject + latency only — no user reasoning):

{EVIDENCE}

Produce a strategic synthesis:
1. KNOWN — consistent patterns in accepts and rejects
2. UNKNOWN — gaps where we have no evidence or mixed signals
3. CONTRADICTIONS — hesitant swipes or mixed signals
4. SCOUT GUIDANCE — what should scouts probe NEXT? Be specific.
5. PERSONA-ANIMA DIVERGENCE — does revealed taste diverge from stated intent?
```

### Oracle Synthesis Output

```typescript
interface TasteSynthesis {
  known: string[];
  unknown: string[];
  contradictions: string[];
  scout_guidance: string;
  persona_anima_divergence: string | null;
}
```

### What the synthesis enables

1. **Injected into scout prompts** — scouts coordinate without talking to each other
2. **Shown in Anima panel** — this IS the visible taste model forming
3. **Fed to builder** — knows what's settled enough to build from
4. **Divergence detection** — the oracle found persona-anima gaps unprompted:
   > *"The user claims to want a 'personal finance app' (a utility), but their choices reveal a desire for a 'digital talisman' — an emotionally-charged physical artifact."*

### Oracle cadence

- Every 4 swipes (validated — enough evidence per round for meaningful synthesis)
- Uses `gemini-3.1-flash-lite-preview` at temperature 0
- ~2-4s latency — runs in background between swipes, doesn't block UI

---

## Scout Prompt (validated)

```
You are a taste scout — your job is to generate the next visual probe
that will be most informative about this user's preferences.

The user said they want to build: "{INTENT}"

EVIDENCE HISTORY:

{EVIDENCE}

ORACLE SYNTHESIS (if available):
Known: {known}
Unknown: {unknown}
Contradictions: {contradictions}
Divergence: {divergence}
Scout guidance: {guidance}

DIVERSITY: Your last 3 probes tested: "{recent_hypotheses}".
Do NOT probe the same territory again. Find a DIFFERENT gap.

FORMAT: You have {N} swipes of evidence. {format_instruction}

RULES:
- Do NOT repeat patterns the user already rejected
- Do NOT re-confirm things we already know
- Target the GAPS
- A probe the user would HESITATE on is most informative
- Think like Akinator — maximally partition the remaining space
```

### Required scout prompt injections

1. **Evidence history** — raw evidence list
2. **Oracle synthesis** — if available (after first 4 swipes)
3. **Diversity constraint** — last 3 probe hypotheses, with instruction to avoid same territory
4. **Format instruction** — concreteness floor from oracle

**Benchmark:** 6/6 on isolated tests. 4/5 in full flow (format gate + diversity both work).

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
| `TasteAxis` type | **Drop** | No explicit axes — evidence IS the model |
| `confidence: number` | **Drop** | LLM infers confidence from evidence density |
| `leaning?: string` | **Drop** | Embedded in accept/reject history |
| `toAnimaYAML()` serializer | **Replace** with `toEvidencePrompt()` | Serialize evidence list, not axis distributions |
| `getMostUncertainAxis()` | **Drop** | Scout identifies gaps from evidence, not code |
| `addEvidence()` confidence delta | **Simplify** | Just append to evidence array |
| Swipe-count stage transitions | **Replace** | Oracle concreteness floor + scout format choice |
| Axis seeding prompt | **Drop** | First probes ARE the seed questions |

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
| **Oracle (code + LLM)** | Keep | Code: queue health, floor, reveal. LLM: synthesis every 4 swipes. |
| **Latency signal** | Keep | `slow` = hesitant = boundary = most informative |

---

## Anima Panel (UI)

The Anima panel shows the **oracle's taste synthesis**, not confidence bars:

1. **Oracle synthesis text** — known, unknown, contradictions (regenerated every 4 swipes)
2. **Persona-anima divergence** — highlighted when detected
3. **Accepted/rejected facade thumbnails** — visual history of what survived
4. **Anti-patterns list** — what the system will never show again

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

## Cold Start

No axis seeding. On session init:
1. `context.reset(); context.intent = intent; context.sessionId = randomUUID();`
2. Fire 3 scouts in parallel — each generates its "first Akinator question" from just the intent
3. Queue fills with 3 word-level facades before user sees the first card
4. ~2s latency for first facade (Flash Lite word generation)

Validated: H1 Round 1, scouts produce 6/6 quality probes from intent alone with zero evidence.

---

## Implementation Priority

1. **Simplify `types.ts`** — replace `TasteAxis` with `SwipeEvidence`, add `TasteSynthesis`, drop `axisId` from `Facade`
2. **Simplify `context.ts`** — evidence array, `toEvidencePrompt()`, simplified `addEvidence()`
3. **Rewrite oracle** — drop axis seeding, add synthesis every 4 swipes (LLM), keep code guardrails
4. **Rewrite scout prompt** — evidence + synthesis + diversity + format instruction
5. **Rewrite builder prompt** — evidence + synthesis based
6. **Update Anima panel** — show synthesis + evidence thumbnails
7. **Add diversity check** — inject last 3 hypotheses into scout prompt

---

## Validation Artifacts

- **Isolated tests:** `scripts/bench-akinator.mjs` → `scripts/findings/akinator-validation.md` (H1-H3, all pass)
- **Full flow:** `scripts/bench-akinator-flow.mjs` → `scripts/findings/akinator-flow-v2.md` (12-swipe sim, 4/5)
- **Key finding:** Oracle synthesis produces persona-anima divergence detection unprompted
- **Key finding:** Scout needs diversity constraint to avoid hypothesis ruts
- **Key finding:** Images stage is optional — word → mockup is the natural progression
