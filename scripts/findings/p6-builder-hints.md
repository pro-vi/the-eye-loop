# P6: Builder Hint Quality

Model: `gemini-3.1-flash-lite-preview`
Date: 2026-03-21
Runs per test: 3

## Summary

- Average checks passed: 5.0/5

## Hint Quality Checks

### Run 1 (5/5)
- **Hint:** "Defining the typography system for the hero heading — need to choose between geometric sans-serif (for a sharp, technical performance feel) or rounded mono (for a more approachable, app-centric aesthetic) to complement the energetic sunset-warm palette."
- PASS: hasHint
- PASS: isConstructionGrounded
- PASS: mentionsSpecificPart
- PASS: mentionsResolvedContext
- PASS: notAbstract
- Updated sections: hero, dashboard
- New anti-patterns: low-contrast text overlays, static, non-angled layout elements

### Run 2 (5/5)
- **Hint:** "Defining the typography system for the hero heading — need to choose between geometric sans-serif (for a sharp, technical performance feel) or rounded mono (for a more approachable, app-centric aesthetic) to complement the energetic sunset-warm palette."
- PASS: hasHint
- PASS: isConstructionGrounded
- PASS: mentionsSpecificPart
- PASS: mentionsResolvedContext
- PASS: notAbstract
- Updated sections: hero, dashboard
- New anti-patterns: low-contrast text overlays, static, non-angled layout elements

### Run 3 (5/5)
- **Hint:** "Defining the typography system for the hero heading — need to choose between geometric sans-serif (for a sharp, technical performance feel) or rounded mono (for a more approachable, app-centric aesthetic) to complement the energetic sunset-warm palette."
- PASS: hasHint
- PASS: isConstructionGrounded
- PASS: mentionsSpecificPart
- PASS: mentionsResolvedContext
- PASS: notAbstract
- Updated sections: hero, dashboard
- New anti-patterns: low-contrast text overlays, static, non-angled layout elements

## Recommendation

**GOOD** — Builder produces construction-grounded hints that reference specific UI components and resolved context.

## Implementation Note

For `src/lib/server/agents/builder.ts`: the GOOD/BAD hint examples in the prompt are critical for quality. Keep them. The builder should always reference what it's trying to build and what resolved dimensions constrain the answer.
