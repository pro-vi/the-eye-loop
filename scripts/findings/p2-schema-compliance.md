# P2: SCHEMA 7-field Compliance

Model: `gemini-3.1-flash-lite-preview`
Date: 2026-03-21
Runs per test: 3

## Results by Prompt Version

### A (original)
- Average fields: 5.0/7
- All quantified: true
- All metadata: true

```
SUBJECT: A minimalist architectural portfolio website displayed on a sleek, matte-finish tablet held by a person in a workspace.

STYLE: Architectural photography, high-end editorial, clean lines, high-fidelity UI design.

LIGHTING: Soft, directional natural light, color temperature 3400K, subtle soft-box diffusion.

BACKGROUND: A clean, out-of-focus workspace featuring a light oak desk surface, a single ceramic vase, and a neutral grey wall.

COMPOSITION: Flat lay, centered framing, shallow dep
```

### B (explicit template)
- Average fields: 7.0/7
- All quantified: true
- All metadata: true

```
SUBJECT: A singular, unadorned structural column intersecting a limestone wall, captured with an 85mm portrait lens to compress depth and isolate material texture.
STYLE: Architectural editorial photography, high-dynamic-range minimal aesthetic, slight 35mm film grain.
LIGHTING: 3200K warm-neutral tungsten glow, lateral grazing light source creating soft, elongated shadows, high-key ambient fill.
BACKGROUND: A seamless, off-white gallery wall with deliberate negative space, emphasizing the absen
```

## Recommendation

**Use prompt version B (explicit template)** (7.0/7 avg fields).

For implementation: use the winning prompt template in `src/lib/server/agents/scout.ts` for image-stage facades.
