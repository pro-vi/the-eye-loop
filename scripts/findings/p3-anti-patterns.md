# P3: Anti-pattern Enforcement

Model: `gemini-3.1-flash-lite-preview`
Date: 2026-03-21
Runs per test: 3

## Summary

- Clean rate: 100% (3/3 runs)

## Violation Frequency

(none)

## Recommendation

**GOOD** — anti-patterns are respected at 100% rate.

## Implementation Note

For `src/lib/server/agents/scout.ts`: always place PROHIBITIONS before MANDATORY in the prompt. The model processes them in order and gives more weight to earlier constraints.

## Raw Results

- Run 0: CLEAN (2941ms)
- Run 1: CLEAN (2401ms)
- Run 2: CLEAN (3271ms)
