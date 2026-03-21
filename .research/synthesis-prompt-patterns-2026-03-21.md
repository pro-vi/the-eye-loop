---
topic: "Prompt engineering patterns for Eye Loop agent system"
date: 2026-03-21
projects:
  - name: GATE (Generative Active Task Elicitation)
    repo: github.com/alextamkin/generative-elicitation
    source_quality: code-verified
  - name: SCHEMA Framework
    repo: arxiv 2602.18903
    source_quality: doc-stated
  - name: HypoGeniC
    repo: arxiv 2404.04326
    source_quality: doc-stated
  - name: BED-LLM
    repo: arxiv 2508.21184
    source_quality: doc-stated
hypotheses:
  - claim: "The system prompts are the product — plumbing is secondary"
    result: confirmed — GATE, SCHEMA, and serialization research all show the prompt structure determines quality more than framework choice
  - claim: "YAML is better than JSON for serializing tree state in prompts"
    result: confirmed — 62% accuracy vs 50% in benchmark (ImprovingAgents)
  - claim: "LLMs can do uncertainty estimation for BALD-like selection"
    result: partially confirmed — verbalized confidence is uncalibrated, but sampling-based disagreement works
key_findings:
  - "YAML beats JSON for tree serialization in LLM prompts (62% vs 50% accuracy)"
  - "Prohibitions outperform positive mandates in Gemini image gen (94% vs 91% compliance)"
  - "GATE edge-case pattern IS the Scout pattern — generate most informative probe from history"
  - "Don't trust LLM self-reported confidence — use multi-scout disagreement instead"
  - "Max 3 iterative image edits before drift — rebuild prompt from scratch"
  - "prepareCall in AI SDK 6 is the injection point for dynamic Anima state"
  - "Gemini temperature should stay at 1.0 — lower degrades complex tasks"
unexplored_threads:
  - "HypoGeniC multi-armed bandit for hypothesis management in Anima tree"
  - "BED-LLM rejection sampling for belief updates"
  - "Accelerated Preference Elicitation decay mechanism (0.95 multiplier)"
---

# Prompt Engineering Patterns for Eye Loop Agents

## The Core Insight

The meta analysis was right: **the 3-4 system prompts ARE the product.** This research found concrete patterns for each.

---

## 1. Anima Tree Serialization — Use YAML, Not JSON

Benchmark data (ImprovingAgents, tested GPT-5 Nano, Gemini 2.5 Flash Lite, Llama 3.2 3B):

| Format | Accuracy | Token Efficiency |
|--------|----------|-----------------|
| YAML | 62.1% (best) | ~10% more than Markdown |
| Markdown | 54.3% | Best (34-38% fewer than JSON) |
| JSON | 50.3% | Worst |
| XML | 44.4% | 80% more than Markdown |

YAML wins because indentation makes hierarchy visually apparent with minimal syntax overhead. This is critical for the Anima tree.

### Recommended Anima Serialization Format

```yaml
# Anima Tree | 12 swipes | stage: images
intent: "portfolio site for architect"

resolved:
  tone:
    value: minimal
    confidence: 0.92
    evidence: [+calm, +whitespace, -brutalist, -maximalist]
  palette:
    value: warm-neutral
    confidence: 0.85
    evidence: [+sand, +cream, -neon, -monochrome]
  density:
    value: sparse
    confidence: 0.78
    evidence: [+breathing-room, +negative-space, -packed]

exploring:
  layout:
    hypotheses: [asymmetric-grid, single-column, magazine]
    distribution: [0.45, 0.35, 0.20]
    # next probe should discriminate asymmetric-grid vs single-column
  typography:
    hypotheses: [geometric-sans, humanist-serif]
    distribution: [0.55, 0.45]

unprobed:
  - interaction-density
  - navigation-pattern
  - imagery-style
```

### Serialization Rules
- Serialize summary state (resolved values + hypothesis distributions), NOT raw swipe logs
- Resolved dimensions show evidence as compact +/- tags
- Exploring dimensions show hypothesis distributions — scouts target the flattest (most uncertain)
- Unprobed dimensions are just names — listed for scouts to self-assign
- Keep within ~300 tokens. Compact on every 5th swipe.

---

## 2. Scout System Prompt — The GATE Edge-Case Pattern

GATE (ICLR 2025) is the closest existing framework to what Eye Loop scouts do. Their edge-case strategy:

> "Generate the most informative edge case that addresses different aspects than what has already been considered."

This IS the scout pattern. The scout generates a visual probe that tests something the system hasn't tested yet.

### Scout System Prompt Template

```
You are a Scout agent in The Eye Loop — a taste discovery system.

Your job: generate a visual probe (facade) that MAXIMALLY DISCRIMINATES
between competing hypotheses about the user's preference.

RULES:
- A good facade makes the user's accept/reject reveal NEW information
- If accepted, it should confirm hypothesis A. If rejected, hypothesis B.
- All RESOLVED dimensions must be held constant in your output
- Target the EXPLORING dimension with the flattest distribution (most uncertain)
- PROHIBITIONS are more important than requirements

ANIMA STATE:
{anima_yaml}

PROBE BRIEF (from Builder, if any):
{probe_brief or "None — self-assign from most uncertain exploring dimension"}

STAGE: {current_stage}

Generate:
1. The facade content ({word | image prompt | HTML})
2. Structured metadata:
```json
{
  "hypothesis_tested": "layout prefers asymmetric-grid over single-column",
  "accept_implies": "asymmetric-grid confirmed, open children: grid-density, alignment",
  "reject_implies": "single-column gains probability, re-probe with different framing",
  "dimension": "layout",
  "held_constant": ["tone:minimal", "palette:warm-neutral", "density:sparse"]
}
```
```

### Key Principle
The scout doesn't try to please. It tries to **partition** the remaining uncertainty. A facade the user is ambivalent about (slow swipe, ~50/50) is actually the MOST informative — it means we're near the boundary.

---

## 3. Builder System Prompt — Construction-Grounded Uncertainty

The builder's unique value: it knows what BLOCKS construction, not what's abstractly uncertain.

### Builder System Prompt Template

```
You are the Builder agent in The Eye Loop.

Your job: maintain a living draft prototype assembled from surviving artifacts.
You never generate facades. You never face the user.

ON EACH SWIPE RESULT:
- Accept: integrate the surviving artifact's properties into the draft
- Reject: add the rejected properties as anti-pattern constraints

THEN: identify what BLOCKS you from building the next section.
Not "what's abstractly uncertain" — what specific question, if answered,
would let you write the next component?

ANIMA STATE:
{anima_yaml}

CURRENT DRAFT STATE:
{draft_sections_summary}

ANTI-PATTERNS (from rejects):
{rejected_properties}

If you identify a construction ambiguity, output a probe brief:
```json
{
  "source": "builder",
  "priority": "high",
  "brief": "Header component: need to know if navigation is fixed-position or scroll-away, given resolved sparse layout with warm-neutral palette",
  "context": "Building header. Layout resolved as asymmetric-grid. Density is sparse. But scroll behavior unresolved — this blocks header implementation.",
  "held_constant": ["tone:minimal", "palette:warm-neutral", "layout:asymmetric-grid"]
}
```

If no ambiguities block you, extrapolate from the Anima and build.
The taste profile is a gravitational field. Fill the dark matter.
```

---

## 4. Orchestrator — Lightweight Event Handler, Not a Thinker

The orchestrator should NOT be a heavy LLM call on every event. It's a decision function.

### When to use LLM (Gemini Pro):
- Compaction (every 5 swipes) — merge evidence, prune dead branches, promote contradictions
- Fract detection — when a dimension resolves, identify orthogonal sub-axes
- Stuck detection — when information gain drops, decide whether to shift stage or reveal

### When to use code (no LLM):
- Queue health checks (facades.length < 3 → spawn)
- Freshness pruning (drop facades whose axis just resolved)
- Scout retirement (info gain dropping + queue full)
- Event routing (swipe result → source scout + builder)

The orchestrator is 80% code, 20% LLM. Don't over-prompt it.

---

## 5. Image Generation Prompts — SCHEMA Framework

For image-stage facades, use the SCHEMA 7-field structure:

```
SUBJECT: {from probe brief or hypothesis}
STYLE: {from resolved Anima — e.g., "editorial photography, 35mm film grain"}
LIGHTING: {from resolved Anima — e.g., "5500K natural, upper-left key, soft fill"}
BACKGROUND: {from resolved or exploring dimension}
COMPOSITION: {from resolved or exploring dimension}
MANDATORY (3-5): {properties that MUST appear — from resolved dimensions}
PROHIBITIONS (3-5): {properties that MUST NOT appear — from rejected evidence}
```

### Key Rules
- Prohibitions beat mandates (94% vs 91% compliance)
- Use quantified specs: "color temperature 3200K" not "cool tones"
- Use photographic/cinematic language: "85mm portrait lens" not "close-up"
- After 3 iterative edits on same image, rebuild prompt from scratch (drift accumulates)
- Use reference image anchoring for consistency within a probe series
- Keep temperature at 1.0 (Gemini default — lowering degrades quality)

---

## 6. Uncertainty Estimation — Don't Trust Verbalized Confidence

LLMs verbalize confidence in 80-100% range with 5% increments. This is pattern-matching, not calibration.

### What to do instead for "BALD-like" selection:

**Option A — Multi-scout disagreement (sampling-based)**
Have 2-3 scouts independently generate facade proposals for the same dimension. Measure how different their outputs are. High disagreement = high uncertainty = probe here.

**Option B — Distribution flatness**
Track hypothesis distributions in the Anima tree. The dimension with the flattest distribution (closest to uniform) is the most uncertain. This is pure code, no LLM needed.

**Option C — Builder-driven (construction grounding)**
Let the builder identify what blocks it. This naturally surfaces the most *practically* uncertain dimensions — the ones that matter for building, not just abstractly.

For hackathon: **Use Option B (code) + Option C (builder briefs).** Skip multi-scout disagreement — it costs 2-3x API calls.

---

## 7. `prepareCall` as the Anima Injection Point

In Vercel AI SDK 6, each agent gets current Anima state via `prepareCall`:

```typescript
const scoutAgent = new ToolLoopAgent({
  model: google('gemini-2.5-flash'),
  callOptionsSchema: z.object({
    animaYaml: z.string(),
    probeBrief: z.string().optional(),
    stage: z.enum(['words', 'images', 'mockups', 'components']),
  }),
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    instructions: SCOUT_SYSTEM_PROMPT
      .replace('{anima_yaml}', options.animaYaml)
      .replace('{probe_brief}', options.probeBrief ?? 'None')
      .replace('{current_stage}', options.stage),
  }),
});
```

This means the Anima tree is serialized fresh on every scout call — always current, never stale.

---

## Prior Art Systems to Steal From

| System | What it does | What to steal |
|--------|-------------|---------------|
| GATE (ICLR 2025) | Generates informative questions from interaction history | Edge-case generation pattern = Scout pattern |
| SCHEMA | Structured image prompts with mandatory/prohibition fields | 7-field prompt structure for image facades |
| HypoGeniC | Iterative hypothesis gen with UCB exploration bonus | Wrong-example pool = rejected facades driving new hypotheses |
| BED-LLM | Bayesian experimental design via LLM | "Slice hypothesis pool into balanced subsets" = BALD approximation via prompting |
| Accelerated Pref Elicitation | LLM proxies for preference learning | Decay mechanism (0.95 multiplier) for shifting from exploration to exploitation |

---

## Hackathon-Priority Prompt Order

1. **Scout system prompt** — this is what makes facades feel intelligent vs random
2. **Anima YAML serialization** — this is the interface between code and AI
3. **Image generation prompt (SCHEMA)** — this makes image facades look intentional
4. **Builder probe brief format** — this connects builder ambiguity to scout action
5. **Compaction prompt** — merge/prune/promote (only if we get to compaction)
