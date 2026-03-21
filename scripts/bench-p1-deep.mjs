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

const SEED_PROMPT = `You are seeding the initial taste axes for The Eye Loop, a preference discovery system.

The user's intent: "{INTENT}"

Generate 5-7 binary taste axes that will be probed through visual facades (words, images, UI mockups).

RULES:
- Each axis must be a measurable visual/design control, NOT a vibe or adjective
- Each axis has exactly two poles (optionA vs optionB)
- Axes must be operationally distinct — varying one should produce visually different output
- Good: "color temperature" (warm 3200K vs cool 6500K), "density" (sparse vs packed), "corner radius" (rounded 16px vs sharp 0px)
- Bad: "mood" (happy vs sad), "quality" (good vs bad), "feel" (modern vs classic)
- Include at least one axis about: layout, color, typography, and density
- id should be kebab-case`;

const axisSchema = z.object({
  axes: z.array(z.object({
    id: z.string(),
    label: z.string(),
    optionA: z.string(),
    optionB: z.string(),
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

const vibeWords = /\b(mood|feel|vibe|quality|style|aesthetic|energy|spirit|tone|character|ambiance|atmosphere|emotion|sentiment)\b/i;
const measurableSignals = /px|rem|%|K|\d+x\d+|\d+pt|\d+ms|\b\d{2,}\b|dense|sparse|packed|rounded|sharp|serif|sans|mono|grid|column|stack|bleed|blur|gradient|shadow|flat|solid|outline|fill|thin|bold|heavy|light|condensed|expanded|modular|freeform|overlapping|centered|left|right|justified|full-width|contained|fixed|scroll|pill|card|tile|tab|list|single|multi|split|asymmetric|symmetric/i;

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  P1 Deep: Axis Seeding — 10 Intents                    ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

const allResults = [];

for (const intent of intents) {
  console.log(`--- "${intent}" ---`);
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
      const labelVibe = vibeWords.test(a.label);
      const poleVibe = vibeWords.test(a.optionA) || vibeWords.test(a.optionB);
      const isVibe = labelVibe || poleVibe;
      const isMeasurable = measurableSignals.test(a.optionA) || measurableSignals.test(a.optionB);
      const hasTwoPoles = a.optionA && a.optionB && a.optionA !== a.optionB;
      const poleContrast = a.optionA.length > 3 && a.optionB.length > 3;
      return { ...a, isVibe, isMeasurable, hasTwoPoles, poleContrast };
    });

    const vibeCount = scored.filter(a => a.isVibe).length;
    const measCount = scored.filter(a => a.isMeasurable).length;
    const allPoles = scored.every(a => a.hasTwoPoles);

    // Check coverage of required categories
    const hasLayout = scored.some(a => /layout|grid|column|align|structure|position/i.test(a.label) || /layout|grid|column|align|structure|position/i.test(a.id));
    const hasColor = scored.some(a => /color|palette|hue|saturation|chroma/i.test(a.label) || /color|palette|hue|saturation|chroma/i.test(a.id));
    const hasTypo = scored.some(a => /typo|font|serif|weight|letter/i.test(a.label) || /typo|font|serif|weight|letter/i.test(a.id));
    const hasDensity = scored.some(a => /densit|spacing|whitespace|packed|sparse|information/i.test(a.label) || /densit|spacing|whitespace|packed|sparse|information/i.test(a.id));
    const coverage = [hasLayout && 'layout', hasColor && 'color', hasTypo && 'typo', hasDensity && 'density'].filter(Boolean);

    allResults.push({
      intent, elapsed, axes: scored,
      vibeCount, measCount, allPoles, coverage,
      coverageScore: coverage.length,
    });

    console.log(`  ${axes.length} axes | ${measCount} measurable | ${vibeCount} vibes | coverage: ${coverage.join(',')} | ${elapsed}ms`);
    scored.forEach(a => {
      const tag = a.isVibe ? ' [VIBE]' : a.isMeasurable ? '' : ' [?]';
      console.log(`    ${a.id}: ${a.optionA} ↔ ${a.optionB}${tag}`);
    });
  } catch (err) {
    console.log(`  ERROR: ${err.message?.slice(0, 120)}`);
    allResults.push({ intent, error: err.message?.slice(0, 120) });
  }
  console.log('');
}

// ── Build report ──────────────────────────────────────────────────────

const valid = allResults.filter(r => !r.error);
const avgAxes = valid.reduce((s, r) => s + r.axes.length, 0) / valid.length;
const avgMeas = valid.reduce((s, r) => s + r.measCount, 0) / valid.length;
const avgVibes = valid.reduce((s, r) => s + r.vibeCount, 0) / valid.length;
const avgCoverage = valid.reduce((s, r) => s + r.coverageScore, 0) / valid.length;
const fullCoverage = valid.filter(r => r.coverageScore === 4).length;

// Collect all vibe axes across all intents
const allVibeAxes = valid.flatMap(r => r.axes.filter(a => a.isVibe).map(a => ({ intent: r.intent, ...a })));

// Collect all non-measurable, non-vibe axes
const unclearAxes = valid.flatMap(r => r.axes.filter(a => !a.isVibe && !a.isMeasurable).map(a => ({ intent: r.intent, ...a })));

const report = `# P1 Deep: Axis Seeding — 10 Intents

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
| Average axis count | ${avgAxes.toFixed(1)} (target: 5-7) |
| Average measurable | ${avgMeas.toFixed(1)} |
| Average vibes | ${avgVibes.toFixed(1)} (target: 0) |
| Average category coverage | ${avgCoverage.toFixed(1)}/4 (layout, color, typo, density) |
| Full 4/4 coverage | ${fullCoverage}/${valid.length} intents |

## Per-Intent Results

${valid.map(r => `### "${r.intent}"
${r.axes.length} axes | ${r.measCount} measurable | ${r.vibeCount} vibes | coverage: ${r.coverage.join(', ')} | ${r.elapsed}ms

| ID | Option A | Option B | Measurable | Vibe |
|----|----------|----------|:----------:|:----:|
${r.axes.map(a => `| ${a.id} | ${a.optionA} | ${a.optionB} | ${a.isMeasurable ? 'Y' : ''} | ${a.isVibe ? 'Y' : ''} |`).join('\n')}
`).join('\n')}

## Vibe Axes Found (${allVibeAxes.length} total)

${allVibeAxes.length === 0 ? '(none)' : allVibeAxes.map(a => `- **${a.intent}** → \`${a.id}\`: ${a.optionA} ↔ ${a.optionB}`).join('\n')}

## Unclear Axes (not measurable, not vibe — ${unclearAxes.length} total)

${unclearAxes.length === 0 ? '(none)' : unclearAxes.map(a => `- **${a.intent}** → \`${a.id}\`: ${a.optionA} ↔ ${a.optionB}`).join('\n')}

## Coverage Gaps

${valid.filter(r => r.coverageScore < 4).map(r => `- **"${r.intent}"** missing: ${['layout', 'color', 'typo', 'density'].filter(c => !r.coverage.includes(c)).join(', ')}`).join('\n') || '(all intents have full coverage)'}

## Recommendation

${avgVibes <= 1 ? '**GOOD** — average vibe count is low enough for production use.' : '**NEEDS TUNING** — too many vibe axes. Add more negative examples.'}

${fullCoverage >= 8 ? '**GOOD** — category coverage is reliable.' : `**NOTE** — ${valid.length - fullCoverage} intents missed coverage categories. Consider adding a verification step: "VERIFY: your axes include at least one about layout, color, typography, and density."`}

## Implementation Notes

For \`src/lib/server/agents/scout.ts\` (axis seeding on session init):

1. Use this exact prompt template with \`Output.object({ schema: axisSchema })\`
2. Temperature: 0 for deterministic seeding
3. Post-process: filter out any axis where label matches vibe words, replace with a measurable alternative
4. Verify 4-category coverage in code; if missing, append a default axis for the missing category
5. Latency: ~2s — fast enough to run during session init before first facade
`;

writeFileSync('scripts/findings/p1-axis-seeding-deep.md', report);
console.log('═══════════════════════════════════════════════════════════');
console.log('  Report written to scripts/findings/p1-axis-seeding-deep.md');
console.log('═══════════════════════════════════════════════════════════');
