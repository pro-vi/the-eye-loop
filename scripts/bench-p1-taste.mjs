import { readFileSync, writeFileSync } from 'fs';
try {
  const env = readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}
process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;

import { google } from '@ai-sdk/google';
import { generateText, Output } from 'ai';
import { z } from 'zod';

const generator = google('gemini-3.1-flash-lite-preview');

// ── The new taste-level seeding prompt ────────────────────────────────

const SEED_PROMPT = `You are seeding initial taste axes for The Eye Loop — a system that discovers what a user wants to build through instinctive selection (swipe accept/reject), not specification.

The user's intent: "{INTENT}"

Generate exactly 5 binary taste axes. These are DESIGN TASTE dimensions, not CSS properties.

Each axis will be probed at progressively concrete levels:
- First as a single evocative WORD (e.g., "Precision" vs "Warmth")
- Then as a MOODBOARD IMAGE (e.g., Swiss grid design vs hand-crafted illustration)
- Then as an HTML MOCKUP (e.g., dense data dashboard vs spacious narrative page)

RULES:
- Each axis captures a PRODUCT EXPERIENCE choice, not a visual property
- Poles should be nameable design philosophies, product references, or interaction paradigms
- Good: "information stance: observatory dashboard vs companion narrative"
- Good: "visual heritage: swiss modernism vs organic craft"
- Good: "interaction model: direct manipulation vs guided flow"
- Bad: "corner-radius: 0px vs 24px" (this is a CSS property, not taste)
- Bad: "color-saturation: grayscale vs vibrant" (this is a visual knob, not a design philosophy)
- Bad: "layout-alignment: center vs left" (this is a layout detail, not a product decision)
- Each axis must be INTENT-SPECIFIC — it should matter for THIS product, not be a generic design axis
- Poles must be roughly equally appealing — avoid "good vs bad" framings
- For each axis, provide a concrete example of how it would appear as a word-stage facade and an image-stage facade

id should be kebab-case.`;

const axisSchema = z.object({
  axes: z.array(z.object({
    id: z.string(),
    label: z.string(),
    poleA: z.string(),
    poleB: z.string(),
    wordFacadeA: z.string(),
    wordFacadeB: z.string(),
    imageFacadeA: z.string(),
    imageFacadeB: z.string(),
  })),
});

const intents = [
  'weather app for runners',
  'personal finance app that doesn\'t feel like a spreadsheet',
  'portfolio site for an architect',
  'meditation timer with ambient soundscapes',
  'recipe app for people who hate cooking',
  'dating profile builder',
  'indie game studio landing page',
  'collaborative playlist curator for road trips',
  'plant care tracker with watering reminders',
  'freelancer invoice and time tracking tool',
];

// ── Quality checks ───────────────────────────────────────────────────

const cssWords = /\b(px|rem|border-radius|font-weight|box-shadow|color-saturation|margin|padding|opacity|z-index|line-height|letter-spacing)\b/i;
const genericAxes = /\b(corner.?radius|color.?palette|typography.?weight|layout.?alignment|font.?size|background.?style)\b/i;
const tasteSignals = /\b(philosophy|heritage|stance|model|personality|paradigm|approach|language|identity|narrative|companion|observatory|craft|modernism|editorial|utility|playful|serious|intimate|expansive|guided|direct|ambient|focused|linear|notion|jira|spotify|airbnb|duolingo)\b/i;

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  P1 Taste: Axis Seeding — Design Taste Dimensions      ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

const allResults = [];

for (const intent of intents) {
  console.log(`\n━━━ "${intent}" ━━━`);
  try {
    const start = Date.now();
    const result = await generateText({
      model: generator,
      temperature: 0,
      output: Output.object({ schema: axisSchema }),
      prompt: SEED_PROMPT.replace('{INTENT}', intent),
    });
    const elapsed = Date.now() - start;
    const axes = result.output?.axes ?? [];

    const scored = axes.map(a => {
      const isCss = cssWords.test(a.poleA) || cssWords.test(a.poleB) || genericAxes.test(a.id) || genericAxes.test(a.label);
      const isTaste = tasteSignals.test(a.label) || tasteSignals.test(a.poleA) || tasteSignals.test(a.poleB);
      const hasWordExample = a.wordFacadeA?.length > 0 && a.wordFacadeB?.length > 0;
      const hasImageExample = a.imageFacadeA?.length > 0 && a.imageFacadeB?.length > 0;
      const polesBalanced = a.poleA.length > 5 && a.poleB.length > 5;
      return { ...a, isCss, isTaste, hasWordExample, hasImageExample, polesBalanced };
    });

    const cssCount = scored.filter(a => a.isCss).length;
    const tasteCount = scored.filter(a => a.isTaste).length;

    allResults.push({ intent, elapsed, axes: scored, cssCount, tasteCount, count: axes.length });

    console.log(`  ${axes.length} axes | ${tasteCount} taste | ${cssCount} css-leaks | ${elapsed}ms\n`);
    for (const a of scored) {
      const tag = a.isCss ? ' ⚠️ CSS' : a.isTaste ? ' ✓' : '';
      console.log(`  ${a.id}: ${a.poleA} ↔ ${a.poleB}${tag}`);
      console.log(`    word:  "${a.wordFacadeA}" vs "${a.wordFacadeB}"`);
      console.log(`    image: "${a.imageFacadeA?.slice(0, 60)}..." vs "${a.imageFacadeB?.slice(0, 60)}..."`);
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message?.slice(0, 150)}`);
    allResults.push({ intent, error: err.message?.slice(0, 150) });
  }
}

// ── Report ────────────────────────────────────────────────────────────

const valid = allResults.filter(r => !r.error);
const avgTaste = valid.reduce((s, r) => s + r.tasteCount, 0) / valid.length;
const avgCss = valid.reduce((s, r) => s + r.cssCount, 0) / valid.length;
const avgCount = valid.reduce((s, r) => s + r.count, 0) / valid.length;

const report = `# P1 Taste: Axis Seeding — Design Taste Dimensions

Model: \`gemini-3.1-flash-lite-preview\`
Temperature: 0
Date: ${new Date().toISOString().slice(0, 10)}

## Prompt Used

\`\`\`
${SEED_PROMPT}
\`\`\`

## Aggregate Scores

| Metric | Value |
|--------|-------|
| Average axis count | ${avgCount.toFixed(1)} (target: 5) |
| Average taste-level axes | ${avgTaste.toFixed(1)} |
| Average CSS-level leaks | ${avgCss.toFixed(1)} (target: 0) |

## Per-Intent Results

${valid.map(r => `### "${r.intent}"
${r.count} axes | ${r.tasteCount} taste | ${r.cssCount} css-leaks | ${r.elapsed}ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
${r.axes.map(a => `| **${a.label}** (${a.id}) | ${a.poleA} | ${a.poleB} | ${a.isTaste ? '✓' : ''} | ${a.isCss ? '⚠️' : ''} |`).join('\n')}

**Word facades:**
${r.axes.map(a => `- ${a.id}: "${a.wordFacadeA}" vs "${a.wordFacadeB}"`).join('\n')}

**Image facades:**
${r.axes.map(a => `- ${a.id}: "${a.imageFacadeA}" vs "${a.imageFacadeB}"`).join('\n')}
`).join('\n')}

## CSS Leaks

${valid.flatMap(r => r.axes.filter(a => a.isCss).map(a => `- **${r.intent}** → \`${a.id}\`: ${a.poleA} ↔ ${a.poleB}`)).join('\n') || '(none)'}

## Recommendation

${avgCss <= 0.5 ? '**GOOD** — CSS leaks are minimal.' : '**NEEDS TUNING** — too many CSS-level axes leaking through.'}
${avgTaste >= 3 ? '**GOOD** — most axes are at the taste level.' : '**NEEDS TUNING** — not enough taste-level axes.'}

## Implementation Notes

For \`src/lib/server/context.ts\` (session init):

1. Use this prompt with \`Output.object({ schema: axisSchema })\`
2. The word/image facade examples from each axis feed directly into scout prompts
3. As stages progress, scouts use the axis label + poles to generate stage-appropriate probes
4. The axis itself stays constant; only the facade concreteness changes
`;

writeFileSync('scripts/findings/p1-axis-seeding-taste.md', report);
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Report: scripts/findings/p1-axis-seeding-taste.md');
console.log('═══════════════════════════════════════════════════════════\n');
