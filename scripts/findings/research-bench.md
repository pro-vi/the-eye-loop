# Research Bench — Edge Cases + Cross-Scout + Builder HTML

Model: `gemini-3.1-flash-lite-preview`
Date: 2026-03-21

## Edge Case Users

### Reject-everything user (6 straight rejects)
- **Probe:** "An abstract, soft-focus moodboard featuring organic, fluid shapes, warm tactile textures like brushe"
- **Hypothesis:** "Does the user equate 'not a spreadsheet' with an organic, tactile, and non-linear interface rather t"
- **Gap:** "Determining if the aversion to 'spreadsheets' is about visual complexity (grids) or the cold, data-f"
- **Adaptation:** explores new territory

### Accept-everything user (6 straight accepts)
- **Probe:** "An abstract, fluid UI interface composed of soft, translucent glassmorphism layers and blurred gradi"
- **Hypothesis:** "The user prefers a fluid, atmospheric representation of finance that prioritizes emotional state and"
- **Gap:** "Determining if the user values 'sensory feedback' (fluidity) over 'functional interface' (structured"
- **Adaptation:** keeps adding

### Contradictory user (flip-flops on same dimension)
- **Probe:** "A high-fidelity moodboard featuring a 'tactile digital' aesthetic: thick, clay-like 3D UI elements w"
- **Hypothesis:** "The user desires a 'tangible' physical interaction metaphor (clay/paper) rather than standard flat-s"
- **Gap:** "The intersection of the user's preference for 'handcrafted' feel and 'data utility' is unexplored; I"
- **Adaptation:** ignores contradiction

### Slow-on-everything user (all hesitant)
- **Probe:** "A high-fidelity mockup of a conversational chat interface where money management feels like a text-b"
- **Hypothesis:** "The user prefers an narrative-driven or conversational interaction model over a visual-centric UI."
- **Gap:** "Determining if the user prefers 'Conversational/Storytelling' UI versus 'Spatial/Abstract' UI when d"
- **Adaptation:** ignores contradiction

## Cross-Scout Diversity

### Round 1: words stage (evidence 5)
- **Scout Alpha:** [word] "Conversational narrative stream" → gap: "Determining the primary interaction model for financial guid"
- **Scout Beta:** [word] "Conversational stream" → gap: "The fundamental interaction model (timeline vs. stack) remai"
- **Scout Gamma:** [word] "Conversational" → gap: "Determining the fundamental interaction model between 'conve"
- **Diverse:** NO (2 overlapping pairs)
- **Latency:** 1797ms (3 parallel calls)

### Round 2: image stage (evidence 5)
- **Scout Alpha:** [image] "A high-fidelity moodboard featuring two distinct interaction" → gap: "Determining whether the 'organic' feel is better achieved th"
- **Scout Beta:** [image] "A high-fidelity moodboard featuring a conversational, natura" → gap: "Determining the interaction paradigm (how the user communica"
- **Scout Gamma:** [image] "A high-fidelity moodboard featuring a conversational, natura" → gap: "Determining the primary interaction loop (Conversational vs."
- **Diverse:** YES
- **Latency:** 1783ms (3 parallel calls)

## Builder HTML

- **Latency:** 3105ms
- **HTML length:** 1303 chars
- **Components:** Spending Summary Card, Conversational Insight Module, Progress Indicator Ring, Warm Serif Typography
- **Anti-patterns respected:** No dense grids, No monospace font, No dark mode, No neon colors, No glassmorphism, No clinical precision
- **Next question:** Would you like to adjust the tone of the conversational companion or add a category-specific breakdown for your spending?
- **Quality:** ✓ hasHtml | ✓ hasInlineStyles | ✓ warmColors | ✓ noBlue | ✓ hasRadius | ✓ hasSerif

### Rendered HTML saved to /tmp/builder-draft.html
