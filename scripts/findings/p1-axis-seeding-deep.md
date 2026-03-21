# P1 Deep: Axis Seeding — 10 Intents

Model: `gemini-3.1-flash-lite-preview`
Temperature: 0
Date: 2026-03-21

## Prompt Used

```
You are seeding the initial taste axes for The Eye Loop, a preference discovery system.

The user's intent: "{INTENT}"

Generate 5-7 binary taste axes that will be probed through visual facades (words, images, UI mockups).

RULES:
- Each axis must be a measurable visual/design control, NOT a vibe or adjective
- Each axis has exactly two poles (optionA vs optionB)
- Axes must be operationally distinct — varying one should produce visually different output
- Good: "color temperature" (warm 3200K vs cool 6500K), "density" (sparse vs packed), "corner radius" (rounded 16px vs sharp 0px)
- Bad: "mood" (happy vs sad), "quality" (good vs bad), "feel" (modern vs classic)
- Include at least one axis about: layout, color, typography, and density
- id should be kebab-case
```

## Aggregate Scores

| Metric | Value |
|--------|-------|
| Average axis count | 6.0 (target: 5-7) |
| Average measurable | 5.7 |
| Average vibes | 0.6 (target: 0) |
| Average category coverage | 4.0/4 (layout, color, typo, density) |
| Full 4/4 coverage | 10/10 intents |

## Per-Intent Results

### "weather app for runners"
6 axes | 6 measurable | 2 vibes | coverage: layout, color, typo, density | 1848ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| layout-alignment | Center-aligned | Left-aligned | Y |  |
| color-palette-contrast | Monochromatic grayscale | High-saturation accent colors | Y |  |
| typography-weight | Ultra-light sans-serif | Bold condensed slab-serif | Y |  |
| information-density | Minimalist single-metric focus | Dashboard-style multi-data grid | Y | Y |
| element-corner-radius | Sharp 0px corners | Pill-shaped 24px corners | Y |  |
| visual-background-style | Solid flat color | Glassmorphism blur effect | Y | Y |

### "personal finance app that doesn't feel like a spreadsheet"
6 axes | 6 measurable | 1 vibes | coverage: layout, color, typo, density | 1968ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| layout-structure | Grid-based card system | Linear vertical feed | Y |  |
| color-palette | Monochromatic grayscale | High-contrast vibrant accents | Y |  |
| typography-style | Geometric sans-serif | Humanist serif | Y | Y |
| information-density | High-density tabular data | Low-density conversational UI | Y |  |
| corner-radius | Sharp 0px edges | Soft 24px rounded corners | Y |  |
| visual-weight | Heavy bold outlines | Subtle drop shadows and depth | Y |  |

### "portfolio site for an architect"
6 axes | 6 measurable | 0 vibes | coverage: layout, color, typo, density | 2159ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| grid-structure | Strict modular grid | Free-form overlapping layers | Y |  |
| color-palette | Monochromatic grayscale | High-contrast saturated accents | Y |  |
| typography-style | Geometric sans-serif | High-contrast serif | Y |  |
| information-density | Minimalist whitespace-heavy | Information-dense tiled gallery | Y |  |
| ui-geometry | Sharp 0px edges | Fully rounded 24px edges | Y |  |
| image-presentation | Full-bleed edge-to-edge | Contained within defined borders | Y |  |

### "meditation timer with ambient soundscapes"
6 axes | 5 measurable | 0 vibes | coverage: layout, color, typo, density | 2126ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| layout-alignment | Center-aligned | Left-aligned | Y |  |
| color-palette-saturation | Monochromatic desaturated | High-contrast vibrant | Y |  |
| typography-weight | Light weight sans-serif | Bold weight serif | Y |  |
| interface-density | High whitespace padding | Compact information density |  |  |
| element-geometry | Fully rounded 40px corners | Sharp 0px corners | Y |  |
| visual-texture | Flat vector graphics | Grainy photographic overlays | Y |  |

### "recipe app for people who hate cooking"
6 axes | 6 measurable | 0 vibes | coverage: layout, color, typo, density | 1907ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| layout-alignment | Center-aligned | Left-aligned | Y |  |
| color-saturation | Monochromatic grayscale | High-saturation primary colors | Y |  |
| typography-weight | Light weight sans-serif | Extra-bold display serif | Y |  |
| information-density | High-density list view | Low-density card view | Y |  |
| element-geometry | Fully rounded corners 24px | Sharp square corners 0px | Y |  |
| visual-complexity | Minimalist line art icons | High-fidelity photographic imagery | Y |  |

### "dating profile builder"
6 axes | 6 measurable | 0 vibes | coverage: layout, color, typo, density | 2097ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| layout-alignment | Center-aligned | Left-aligned | Y |  |
| color-saturation | Monochromatic grayscale | High-vibrancy polychromatic | Y |  |
| typography-weight | Ultra-light 200 weight | Extra-bold 800 weight | Y |  |
| element-density | High-whitespace sparse | Information-dense packed | Y |  |
| corner-radius | Sharp 0px corners | Fully-rounded 32px pill corners | Y |  |
| image-aspect-ratio | Portrait 3:4 | Landscape 16:9 | Y |  |

### "indie game studio landing page"
6 axes | 6 measurable | 1 vibes | coverage: layout, color, typo, density | 1851ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| layout-alignment | Center-aligned | Grid-based asymmetrical | Y |  |
| color-palette-saturation | Monochromatic grayscale | High-saturation neon | Y |  |
| typography-style | Geometric sans-serif | High-contrast serif | Y | Y |
| element-density | Minimalist whitespace | Information-dense collage | Y |  |
| border-radius | Sharp 0px corners | Soft 24px rounded corners | Y |  |
| motion-profile | Static and rigid | Fluid and kinetic | Y |  |

### "collaborative playlist curator for road trips"
6 axes | 5 measurable | 0 vibes | coverage: layout, color, typo, density | 1738ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| layout-alignment | Center-aligned grid | Left-aligned list | Y |  |
| color-saturation | Monochromatic grayscale | High-saturation neon | Y |  |
| typography-weight | Ultra-light hairline | Extra-bold display | Y |  |
| element-density | High-density compact | Low-density spacious |  |  |
| corner-radius | Sharp 0px corners | Fully rounded 32px pills | Y |  |
| visual-contrast | Low-contrast soft shadows | High-contrast hard borders | Y |  |

### "plant care tracker with watering reminders"
6 axes | 5 measurable | 1 vibes | coverage: layout, color, typo, density | 2428ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| layout-alignment | Center-aligned cards | Left-aligned list view | Y |  |
| color-palette-saturation | High-saturation neon accents | Desaturated earth tones |  |  |
| typography-weight | Bold geometric sans-serif | Lightweight humanist serif | Y |  |
| information-density | High-density data tables | Low-density card-based layout | Y |  |
| corner-radius | Sharp 0px corners | Soft 24px rounded corners | Y |  |
| visual-style | Flat vector illustrations | High-fidelity photographic imagery | Y | Y |

### "freelancer invoice and time tracking tool"
6 axes | 6 measurable | 1 vibes | coverage: layout, color, typo, density | 1709ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
| layout-structure | Single-column vertical flow | Multi-column dashboard grid | Y |  |
| color-palette | Monochromatic grayscale | High-contrast primary accent | Y |  |
| typography-style | Geometric sans-serif | Humanist serif | Y | Y |
| information-density | Spacious with large whitespace | Compact with dense data tables | Y |  |
| element-geometry | Fully rounded corners (24px) | Sharp square corners (0px) | Y |  |
| visual-weight | Thin hairline borders | Bold filled containers | Y |  |


## Vibe Axes Found (6 total)

- **weather app for runners** → `information-density`: Minimalist single-metric focus ↔ Dashboard-style multi-data grid
- **weather app for runners** → `visual-background-style`: Solid flat color ↔ Glassmorphism blur effect
- **personal finance app that doesn't feel like a spreadsheet** → `typography-style`: Geometric sans-serif ↔ Humanist serif
- **indie game studio landing page** → `typography-style`: Geometric sans-serif ↔ High-contrast serif
- **plant care tracker with watering reminders** → `visual-style`: Flat vector illustrations ↔ High-fidelity photographic imagery
- **freelancer invoice and time tracking tool** → `typography-style`: Geometric sans-serif ↔ Humanist serif

## Unclear Axes (not measurable, not vibe — 3 total)

- **meditation timer with ambient soundscapes** → `interface-density`: High whitespace padding ↔ Compact information density
- **collaborative playlist curator for road trips** → `element-density`: High-density compact ↔ Low-density spacious
- **plant care tracker with watering reminders** → `color-palette-saturation`: High-saturation neon accents ↔ Desaturated earth tones

## Coverage Gaps

(all intents have full coverage)

## Recommendation

**GOOD** — average vibe count is low enough for production use.

**GOOD** — category coverage is reliable.

## Implementation Notes

For `src/lib/server/agents/scout.ts` (axis seeding on session init):

1. Use this exact prompt template with `Output.object({ schema: axisSchema })`
2. Temperature: 0 for deterministic seeding
3. Post-process: filter out any axis where label matches vibe words, replace with a measurable alternative
4. Verify 4-category coverage in code; if missing, append a default axis for the missing category
5. Latency: ~2s — fast enough to run during session init before first facade
