# P5: Scout Semantic Correctness

Model: `gemini-3.1-flash-lite-preview`
Date: 2026-03-21
Runs per test: 3

## Summary

- Average checks passed: 4.0/5
- Targets weakest axis (typography 50/50): 100% of runs

## Semantic Checks

### Run 1
- Dimension targeted: `typography`
- Content: "Structural Resonance"
- Hypothesis: "typography"
- Held constant: ["minimal-calm","warm-neutral","asymmetric-grid"]
- PASS: targetsWeakest
- PASS: holdsResolved
- PASS: noAntiPattern
- PASS: shortContent
- FAIL: hasHypothesis

### Run 2
- Dimension targeted: `typography`
- Content: "Constructed Silence"
- Hypothesis: "typography"
- Held constant: ["minimal-calm","warm-neutral","asymmetric-grid"]
- PASS: targetsWeakest
- PASS: holdsResolved
- PASS: noAntiPattern
- PASS: shortContent
- FAIL: hasHypothesis

### Run 3
- Dimension targeted: `typography`
- Content: "Structural Resonance"
- Hypothesis: "typography"
- Held constant: ["tone: minimal-calm","color_temp: warm-neutral"]
- PASS: targetsWeakest
- PASS: holdsResolved
- PASS: noAntiPattern
- PASS: shortContent
- FAIL: hasHypothesis

## Recommendation

**GOOD** — Scout reliably targets the most uncertain axis.

## Implementation Note

For `src/lib/server/agents/scout.ts`: the code should compute the weakest axis and inject it into the prompt explicitly, not rely on the LLM to parse distributions from YAML. Pre-compute: `const weakest = axes.sort((a,b) => a.confidence - b.confidence)[0]`.
