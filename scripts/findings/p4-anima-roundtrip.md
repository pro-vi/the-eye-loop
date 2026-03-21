# P4: Anima YAML Round-trip

Model: `gemini-3.1-flash-lite-preview`
Date: 2026-03-21
Runs per test: 3

## Summary

- Average checks passed: 8.0/8
- Consistent across runs: true

## Check Details

### Run 1 (8/8)
- PASS: hasIntent
- PASS: hasResolved
- PASS: hasExploring
- PASS: hasAntiPatterns
- PASS: swipeUpdated
- PASS: sunsetIncreased
- PASS: toneUntouched
- PASS: under300

### Run 2 (8/8)
- PASS: hasIntent
- PASS: hasResolved
- PASS: hasExploring
- PASS: hasAntiPatterns
- PASS: swipeUpdated
- PASS: sunsetIncreased
- PASS: toneUntouched
- PASS: under300

### Run 3 (8/8)
- PASS: hasIntent
- PASS: hasResolved
- PASS: hasExploring
- PASS: hasAntiPatterns
- PASS: swipeUpdated
- PASS: sunsetIncreased
- PASS: toneUntouched
- PASS: under300

## Recommendation

**GOOD** — Flash Lite handles YAML round-trips reliably.

## Implementation Note

For `src/lib/server/context.ts`: between-compaction Anima updates should be **pure code** (shift distributions by fixed amounts based on swipe result). LLM-based YAML rewriting is only needed for compaction (every 5 swipes). This test validates the compaction path.

## Sample Output

```yaml
# Anima | 7 swipes | stage: images
intent: "weather app for runners"

resolved:
  tone:
    value: energetic
    confidence: 0.90
    evidence: [+bold, +dynamic, -calm, -muted]

exploring:
  palette:
    hypotheses: [sunset-warm, ocean-cool, forest-green]
    distribution: [0.60, 0.10, 0.30]
    probes_spent: 3
  density:
    hypotheses: [sparse, moderate]
    distribution: [0.50, 0.50]
    probes_spent: 1

unprobed:
  - typography
  - layout_pattern

anti_patterns:
  - muted pastels
  - heavy gradients
```
