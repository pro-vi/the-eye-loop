---
topic: "Builder prompt patterns from v0, Lovable, Bolt, Same.dev, Stitch"
date: 2026-03-21
projects:
  - name: v0.dev (Vercel)
    repo: github.com/2-fly-4-ai/V0-system-prompt
    source_quality: code-verified (leaked prompt)
  - name: Lovable.dev
    repo: github.com/x1xhlol/system-prompts-and-models-of-ai-tools
    source_quality: code-verified (leaked prompt)
  - name: Bolt.new (StackBlitz)
    repo: github.com/jujumilk3/leaked-system-prompts
    source_quality: code-verified (leaked prompt)
  - name: Same.dev
    repo: github.com/x1xhlol/system-prompts-and-models-of-ai-tools
    source_quality: code-verified (leaked prompt)
  - name: Stitch (Google Labs)
    repo: stitch.withgoogle.com
    source_quality: doc-stated (no prompt leak, public docs only)
hypotheses:
  - claim: "Production UI generators enforce strict color/styling rules to prevent ugly defaults"
    result: confirmed — all four leaked prompts have explicit color prohibitions and styling mandates
  - claim: "They use Tailwind variable-based colors, not raw hex values"
    result: confirmed for v0 and Lovable; Bolt/Same.dev are framework-agnostic but default to Tailwind
  - claim: "There are shared anti-patterns across all tools"
    result: confirmed — default components, indigo/blue defaults, partial code, placeholder comments
key_findings:
  - "ALL tools prohibit default blue/indigo — it's the universal 'ugly AI output' signal"
  - "v0 and Same.dev both say NEVER use default shadcn — always customize"
  - "Lovable's core insight: semantic color tokens, not raw values"
  - "ALL require COMPLETE code — never partial, never placeholders"
  - "Responsive is a universal mandate, not a nice-to-have"
  - "Same.dev: NEVER use emojis in web applications"
unexplored_threads:
  - "Stitch auto-generates design systems (seed color → full palette + typography + corner radius) — could inform builder's CSS generation"
  - "v0's CodeProject artifact format for multi-file React output"
---

# Builder Prompt Patterns — UI Code Generation Tools

## What We're Stealing For

The Eye Loop builder generates HTML+CSS prototypes from evidence. It needs to produce code that LOOKS GOOD in an iframe — not production React, just visually convincing mockups. These tools solve the same problem: make LLM-generated UI look professional.

## Universal Rules (all 4 tools agree)

### 1. Never Use Default Blue/Indigo

| Tool | Rule |
|------|------|
| **v0** | "v0 DOES NOT use indigo or blue colors unless specified" |
| **Same.dev** | "Avoid using purple, indigo, or blue colors unless specified" |
| **Lovable** | "Never use explicit color classes like `text-white`, `bg-white`" |

Blue/indigo is the universal marker of "AI-generated default." Every tool explicitly bans it.

**Eye Loop application:** Add to builder prompt: "NEVER use blue (#0066CC, #2196F3, indigo) or default purple. These scream 'AI-generated'. Use warm, intentional colors from the evidence."

### 2. Never Use Default Components

| Tool | Rule |
|------|------|
| **v0** | Uses shadcn but customizes via Tailwind variable colors |
| **Same.dev** | "NEVER stay with default shadcn/ui components. Always customize...AS THOUGHTFULLY DESIGNED AS POSSIBLE" |
| **Lovable** | "Shadcn components are made to be customized! Review and customize to make them beautiful" |

**Eye Loop application:** Our builder generates raw HTML, not shadcn. But the principle applies: never output generic-looking UI. Every element should have intentional styling — specific border-radius, specific padding, specific font choice.

### 3. Always Complete Code, Never Placeholders

| Tool | Rule |
|------|------|
| **v0** | "ALWAYS writes COMPLETE code snippets. NEVER writes partial code or includes comments for the user to fill in" |
| **Bolt** | "CRITICAL: Always provide the FULL, updated content. NEVER use placeholders like '// rest of the code remains the same'" |
| **Same.dev** | "ERROR-FREE. It is EXTREMELY important that your generated code can be run immediately" |

**Eye Loop application:** Builder HTML must render immediately in `<iframe srcdoc>`. No "TODO" comments. No placeholder sections. Every section must have real content, even if it's inferred from evidence.

### 4. Responsive Is Mandatory

All four tools mandate responsive design. v0: "MUST generate responsive designs." Same.dev and Lovable echo this.

**Eye Loop application:** Our mockups render at 375x667 (mobile). But the HTML should use relative units and flex/grid so it doesn't break at different iframe sizes.

## Tool-Specific Insights Worth Stealing

### From Lovable: Semantic Color Tokens

Lovable's most sophisticated insight: "USE SEMANTIC TOKENS FOR COLORS. Define ambitious styles and animations in one place."

Instead of `bg-blue-500`, use `bg-primary`. Instead of `text-gray-800`, use `text-foreground`. Colors defined once in CSS variables, referenced everywhere.

**Eye Loop application:** Our builder should define a color palette at the top of the HTML (in a `<style>` tag with CSS variables) derived from accepted evidence, then reference variables throughout. This makes the output look intentional, not random.

```html
<style>
  :root {
    --bg: #FFF8F0;
    --card: #FFFFFF;
    --accent: #FF8C69;
    --text: #4A3E38;
    --text-muted: #A1887F;
    --radius: 16px;
  }
</style>
<div style="background: var(--bg); color: var(--text);">...</div>
```

### From Lovable: Dark Mode Awareness

"Pay attention to dark vs light mode styles. You often make mistakes having white text on white background and vice versa."

**Eye Loop application:** Our builder should always ensure sufficient contrast. Add to prompt: "Verify text is readable against its background. Never place light text on light backgrounds or dark text on dark backgrounds."

### From Same.dev: No Emojis

"NEVER use emojis in your web application."

**Eye Loop application:** The boss test showed the builder producing things like "Hello, Friend." — which is fine. But emojis in UI text look unprofessional. Add this prohibition.

### From v0: Placeholder Images

"v0 uses `/placeholder.svg?height={height}&width={width}` for placeholder images."

**Eye Loop application:** Our builder can't reference external URLs in `srcdoc` iframes. Use CSS gradient placeholders instead:

```html
<div style="width:100%;height:200px;background:linear-gradient(135deg, var(--accent), var(--bg));border-radius:var(--radius)"></div>
```

### From v0: Icon Handling

"v0 DOES NOT output `<svg>` for icons. ALWAYS uses icons from the 'lucide-react' package."

**Eye Loop application:** We can't use React icon packages in raw HTML. Two options:
1. Use Unicode symbols: ☰ ⚙ ← → ✕ ♡ 🔔 (carefully — some are emoji)
2. Use simple CSS shapes: circles, lines, dots
3. Just use text: "Menu", "Settings", "Back"

Option 3 is safest for iframe rendering. No external dependencies.

### From Bolt: Modular Code

"Use coding best practices and split functionality into smaller modules instead of putting everything in a single gigantic file."

**Eye Loop application:** Our builder outputs single-file HTML. But it should still be STRUCTURED — semantic sections, commented regions, organized CSS at the top.

### From Stitch: Auto-Generated Design System

Stitch "auto-generates a named system with a seed color, full palette, typography scale, corner radius, and component rules."

**Eye Loop application:** The builder should derive a mini design system from evidence:
- **Seed color:** from accepted warm/cool evidence
- **Palette:** seed → accent, background, surface, text (computed relationships)
- **Typography:** serif vs sans from evidence, with scale (14/16/20/28px)
- **Radius:** from evidence (rounded vs sharp)
- **Spacing:** from evidence (sparse vs dense → 24px vs 12px base)

This is the most actionable insight. The builder doesn't just generate HTML — it generates a DESIGN SYSTEM from taste evidence, then applies it.

## Anti-Pattern Checklist (for builder prompt)

From all tools combined, these produce ugly AI output:

1. Default blue/indigo/purple colors
2. Unstyled default components (no custom padding, radius, colors)
3. Placeholder comments ("// TODO", "rest remains the same")
4. Missing responsive consideration
5. Inconsistent spacing (mixing 4px and 20px randomly)
6. Light text on light backgrounds (contrast failure)
7. Emojis in UI text
8. Raw `<svg>` icons (complex, break rendering)
9. External resource references (fonts, images, scripts that won't load in srcdoc)
10. Monospace fonts in non-code UI elements

## Builder Prompt Additions

Based on this research, add to the builder's HTML generation prompt:

```
HTML QUALITY RULES:
1. Define a CSS variable palette at the top derived from evidence:
   --bg, --card, --accent, --text, --text-muted, --radius, --spacing
2. NEVER use blue (#0066CC, #2196F3, indigo) or purple unless evidence demands it
3. NEVER leave placeholder comments or TODO sections — every section has real content
4. ALWAYS ensure text contrast — no light-on-light or dark-on-dark
5. Use relative units (%, rem, vh) and flex/grid for layout
6. No emojis in UI text
7. No external resources (fonts, images, scripts) — everything inline
8. For placeholder images use CSS gradients: linear-gradient(135deg, var(--accent), var(--bg))
9. For icons use text labels ("Menu", "Back") not SVGs or emoji
10. Every element needs intentional styling — specific radius, padding, color. No defaults.
```

## Sources

- [v0 system prompt (Nov 2024)](https://github.com/2-fly-4-ai/V0-system-prompt)
- [v0 system prompt (Jun 2025)](https://gist.github.com/hiddenest/992eb025dc342983503e8edb83ad3b7b)
- [Lovable agent prompt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Lovable/Agent%20Prompt.txt)
- [Bolt.new system prompt](https://github.com/jujumilk3/leaked-system-prompts/blob/main/bolt.new_20241009.md)
- [Same.dev system prompt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/tree/main/Same.dev)
- [Stitch by Google Labs](https://stitch.withgoogle.com/)
- [Leaked prompts mega-repo](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
