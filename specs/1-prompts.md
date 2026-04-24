# Prompt Architecture — The Eye Loop

The system prompts ARE the product. The plumbing (SSE, queues, events) is commodity. These prompts + the evidence format determine whether facades feel intelligent or random.

> Priority order: Scout (Akinator probe) > Oracle synthesis (strategic coordination) > Builder (construction-grounded)

**Source of truth for Akinator pattern:** `specs/4-akinator.md` (validated via benchmarks).

---

## 1. Evidence Serialization

All agents receive evidence as a flat numbered list. No axes, no confidence scores, no distributions. The LLM navigates taste hyperspace implicitly from raw accept/reject + latency signals.

### Format

```
# Evidence | {swipeCount} swipes
intent: "{user's original input}"

1. [ACCEPT] "{content}"
   Hypothesis: {hypothesis}

2. [REJECT (hesitant)] "{content}"
   Hypothesis: {hypothesis}

3. [REJECT] "{content}"
   Hypothesis: {hypothesis}

anti_patterns:
  - {extracted from rejects by builder}
  - {extracted from rejects by builder}
```

### Rules

- `(hesitant)` tag = slow latency = near decision boundary = most informative
- Anti-patterns are accumulated from rejections by the builder — hard constraints for all agents
- Between swipes: just push to evidence array (no distribution math, no axis updates)
- Session state keeps `toEvidencePrompt()` for serialization (see `src/lib/server/session/eye-loop-session.ts`)

---

## 2. Scout System Prompt

Scouts are Akinator for taste. Each probe should maximally partition the remaining possibility space. Validated in `specs/4-akinator.md` (6/6 on isolated tests, 4/5 in full flow).

### Template

```
You are {SCOUT_NAME} — a taste scout generating the next probe.

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

FORMAT: You have {N} swipes of evidence. {format_instruction}

RULES:
- Do NOT duplicate what's already queued
- Probe YOUR assigned axis or the most uncertain one
- Do NOT repeat patterns the user already rejected
- Think like Akinator — maximally partition the remaining space
- PROHIBITIONS (anti-patterns) are hard constraints — never violate them

OUTPUT (structured):
  content: "{the word or HTML}"
  label: "{short display label for the card}"
  hypothesis_tested: "{what accept vs reject would tell us}"
  accept_implies: "{what becomes more likely}"
  reject_implies: "{what becomes more likely, what gets added to anti-patterns}"
  format: "word" | "mockup"
  axis_targeted: "{which emergent axis you probed}"
```

Before the first oracle synthesis (swipes 1-3), scouts get just intent + evidence. No axes, no assignment. Each generates its "first Akinator question" independently.

Scout prompts receive five injections:
1. **Evidence history** — raw evidence list
2. **Emergent axes** — from oracle synthesis (after first 4 swipes)
3. **Scout assignment** — which axis this scout should probe, from oracle
4. **Queue contents** — facades already pending, to prevent duplication
5. **Format instruction** — concreteness floor from oracle

### Format Instructions (injected by concreteness floor)

- `< 4 swipes`: "This is early exploration — use a single evocative WORD or short phrase."
- `>= 4 swipes`: "Describe a concrete MOCKUP with layout, typography, and interaction details."

The floor is 2-tier, matching `EyeLoopSession.concretenessFloor` in `src/lib/server/session/eye-loop-session.ts` (returns `'word'` when evidence < 4, `'mockup'` otherwise) and `Facade.format` in `src/lib/context/types.ts` (`'word' | 'mockup'`). The session runtime sets the minimum floor; scouts emit the corresponding format.

### Stage Progression Example

The same taste dimension gets probed at increasing fidelity across stages:

| Dimension          | Word Probe                     | Mockup Probe                                  |
|--------------------|--------------------------------|-----------------------------------------------|
| information stance | "Dashboard" vs "Story"         | Dense multi-widget vs single-scroll narrative |
| interaction model  | "Control" vs "Flow"            | Settings panel vs swipe-to-act                |
| visual heritage    | "Swiss" vs "Craft"             | Helvetica grid vs illustrated organic         |
| density philosophy | "Observatory" vs "Companion"   | Jira density vs Linear breathing room         |
| personality        | "Invisible" vs "Expressive"    | System-default chrome vs branded experience   |

Later-stage probes build on earlier evidence. If the user accepted "Dashboard" in words, the mockup should test WITHIN that resolved region.

### Diversity Constraint

Inject last 3 probe hypotheses into the prompt. Without this, scouts fall into hypothesis ruts (validated finding from `specs/4-akinator.md`).

<details>
<summary>Appendix: historical image-format scout (cut from V0)</summary>

The V0 Akinator pattern collapsed scout formats to a 2-tier progression (`word` → `mockup`). The image-format scout below was the Gemini-era middle tier; it is preserved here as research/pattern context for any future image-capable tier, but it is NOT part of the current Anthropic runtime. `Facade.format` in `src/lib/context/types.ts` is `'word' | 'mockup'` and `EyeLoopSession.concretenessFloor` is 2-tier.

### IMAGE SCHEMA (for image-format facades — NOT in V0)

When scout chose `format: "image"`, the content field was a structured image prompt:

```
SUBJECT: {from hypothesis}
STYLE: {from evidence patterns — e.g., "editorial photography, 35mm film grain"}
LIGHTING: {quantified: "5500K natural, upper-left key, soft fill"}
BACKGROUND: {from evidence or gap being tested}
COMPOSITION: {from evidence or gap being tested}
MANDATORY (3-5): {properties that MUST appear — from accepted evidence}
PROHIBITIONS (3-5): {properties that MUST NOT appear — from anti-patterns}
```

Rules for image prompts (Gemini Nano Banana, historical):
- Prohibitions outperform positive mandates (94% vs 91% compliance) `.research/synthesis-prompt-patterns`
- Use quantified specs: "color temperature 3200K" not "cool tones"
- Use photographic/cinematic language: "85mm portrait lens" not "close-up"
- After 3 iterative edits on same reference, rebuild prompt from scratch (drift) `.research/synthesis-gemini-projects`
- Must pass `providerOptions.google.responseModalities: ['TEXT', 'IMAGE']` (Gemini-specific — Anthropic has no image-generation surface in this SDK)
- Image config: `imageConfig: { aspectRatio: '3:2', imageSize: '1K' }`
- Reference images go FIRST in parts array, text prompt LAST `.research/synthesis-gemini-projects`

</details>

---

## 3. Builder System Prompt

The builder's unique value: it knows what BLOCKS construction, not what's abstractly uncertain. It never generates facades. It reads results and builds. Validated in `specs/4-akinator.md` (6/6 quality checks).

### Template

```
You are the builder agent. You assemble a prototype from what users
have shown through their choices — not from what they said.

The user said they want to build: "{INTENT}"

EVIDENCE HISTORY:

{EVIDENCE}

ORACLE SYNTHESIS (if available):
Emergent Axes: {axes_summary}
Edge Case Flags: {edge_case_flags}
Divergence: {persona_anima_divergence}

CURRENT DRAFT:
{draft_html}

ACCEPTED PATTERNS: {accepted_patterns}
REJECTED PATTERNS (HARD CONSTRAINTS): {rejected_patterns}

LAST SWIPE:
  facade: "{content_summary}"
  hypothesis: "{hypothesis}"
  decision: {accept | reject}
  latency: {fast | slow}

RULES:
- Ground everything in the evidence
- Anti-patterns (rejected things) are HARD CONSTRAINTS — never include them
- Reference specific accepted/rejected items as justification
- Probe briefs must be about SPECIFIC UI COMPONENTS, not abstract dimensions
  BAD:  "color direction unresolved"
  GOOD: "Building the header — need to know: fixed-position or scroll-away?"

OUTPUT:
  title: string
  summary: string
  html: string (full updated draft)
  acceptedPatterns: string[] (DELTAS — only new patterns from THIS swipe)
  rejectedPatterns: string[] (DELTAS — only new patterns from THIS swipe)
  probeBriefs: array of { source: "builder", priority, brief, context, heldConstant }
  nextHint: string | null (what I need to know next)
```

### Builder does NOT use `stopWhen` agent loop

Builder is called reactively on each `swipe-result` event, not as a continuous LLM loop. Each invocation is one `generateText` call. Serialization gate: skip LLM when outstanding probes exist, do sync-only pattern updates instead.

---

## 4. Oracle Synthesis Prompt

The oracle watches the whole game while scouts are individual Akinator instances. Every 4 swipes, it produces a strategic synthesis that coordinates all agents. Validated in `specs/4-akinator.md`.

### Template

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

### Output

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
  edge_case_flags: string[];
  scout_assignments: Array<{
    scout: string;
    probe_axis: string;
    reason: string;
  }>;
  persona_anima_divergence: string | null;
}
```

### What the synthesis enables

1. **Scout coordination** — each scout is assigned a different emergent axis. No duplication.
2. **Edge case handling** — oracle flags "all responses hesitant", "axis X contradictory", "user not discriminating". Scouts adapt accordingly.
3. **Anima panel** — emergent axes with confidence levels ARE the visible taste model.
4. **Builder grounding** — knows which axes are resolved (build from), exploring (wait), or contradictory (needs probe).
5. **Divergence detection** — persona-anima gaps detected unprompted.

### Cadence

- Every 4 swipes (validated — enough evidence per round for meaningful synthesis)
- Temperature 0 (deterministic)
- ~2-4s latency — runs in background between swipes, doesn't block UI
- Busy gate: if synthesis running and another 4th-swipe fires, skip

---

## Oracle Code Functions (no LLM)

- **Queue health:** `session.queueStats` exposes ready/pending/min/target/max/stale reservoir counts
- **Concreteness floor:** `EyeLoopSession.concretenessFloor` getter (`word` before 4 pieces of evidence, then `mockup`)
- **Reveal trigger:** evidence >= 42
- **Freshness pruning:** age-based — facades older than N swipes dropped on stage change

---

## Structured Output Constraints

All structured output uses Vercel AI SDK `Output.object()` with Zod schemas against Anthropic Claude via `src/lib/server/ai.ts` (`SCOUT_MODEL`, `ORACLE_MODEL`, `BUILDER_MODEL`, `REVEAL_MODEL`; defaults: Haiku 4.5 for non-reveal paths, Sonnet 4.6 for reveal).

Keep schemas flat. Use string enums over unions. If a field is sometimes absent, use `.nullable()` not `.optional()` with union types — Claude's tool-use schema conversion handles flat, JSON-Schema-shaped Zod objects reliably, and flat shapes travel the fewest SDK conversion layers.

<details>
<summary>Appendix: historical Gemini-era limitations (NOT in V0)</summary>

Gemini used an OpenAPI 3.0 subset which disallowed `z.union()`, `z.record()`, and deeply nested optionals. These constraints drove the original "keep schemas flat" rule; the rule survived the Anthropic migration because flat schemas remain the safest cross-provider shape.

</details>

---

## Temperature

- **Scouts:** 1.0 (creative generation — diversity from prompt variation)
- **Builder:** 0 (deterministic analysis)
- **Oracle synthesis:** 0 (deterministic)
