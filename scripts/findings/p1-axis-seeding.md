# P1: Axis Seeding

Model: `gemini-3.1-flash-lite-preview`
Date: 2026-03-21
Runs per test: 3

## Summary

- Average axis count: 6.0 (target: 5-7)
- Average measurable axes: 4.3
- Average vibe axes: 1.0 (target: 0)
- All binary poles valid: true

## Recommendation

**GOOD** — axes are measurable and operationalized.



## Raw Results

- weather app for runners run 0: 6 axes, 4 meas, 2 vibes, 1983ms
- weather app for runners run 1: 6 axes, 4 meas, 2 vibes, 1857ms
- weather app for runners run 2: 6 axes, 4 meas, 2 vibes, 1807ms
- personal finance app that doesn't feel like a spreadsheet run 0: 6 axes, 4 meas, 1 vibes, 1959ms
- personal finance app that doesn't feel like a spreadsheet run 1: 6 axes, 4 meas, 1 vibes, 1938ms
- personal finance app that doesn't feel like a spreadsheet run 2: 6 axes, 4 meas, 1 vibes, 1910ms
- portfolio site for an architect run 0: 6 axes, 5 meas, 0 vibes, 2086ms
- portfolio site for an architect run 1: 6 axes, 5 meas, 0 vibes, 2293ms
- portfolio site for an architect run 2: 6 axes, 5 meas, 0 vibes, 2204ms

## Sample Axes

### "weather app for runners"
- layout-alignment: Center-aligned vs Left-aligned
- color-palette-contrast: Monochromatic grayscale vs High-saturation accent colors
- typography-weight: Ultra-light sans-serif vs Bold condensed slab-serif
- information-density: Minimalist single-metric focus vs Dashboard-style multi-data grid
- element-corner-radius: Sharp 0px corners vs Pill-shaped 24px corners
- visual-background-style: Solid flat color vs Glassmorphism blur effect

### "personal finance app that doesn't feel like a spreadsheet"
- layout-structure: Grid-based card system vs Linear vertical feed
- color-palette: Monochromatic grayscale vs High-contrast vibrant accents
- typography-style: Geometric sans-serif vs Humanist serif
- information-density: High-density tabular data vs Low-density conversational UI
- corner-radius: Sharp 0px edges vs Soft 24px rounded corners
- visual-weight: Heavy bold outlines vs Subtle drop shadows and depth

### "portfolio site for an architect"
- grid-structure: Strict modular grid vs Free-form overlapping layers
- color-palette: Monochromatic grayscale vs High-contrast saturated accents
- typography-style: Geometric sans-serif vs High-contrast serif
- information-density: Minimalist whitespace-heavy vs Information-dense tiled gallery
- ui-geometry: Sharp 0px edges vs Fully rounded 24px edges
- image-presentation: Full-bleed edge-to-edge vs Contained within defined borders
