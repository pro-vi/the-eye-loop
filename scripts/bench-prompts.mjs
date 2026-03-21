import { readFileSync, writeFileSync, mkdirSync } from 'fs';
// Load .env manually (pnpm strict mode doesn't hoist dotenv)
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
const RUNS = 3; // repeat each test for consistency measurement

const findings = {};

function log(probe, msg) {
  if (!findings[probe]) findings[probe] = [];
  findings[probe].push(msg);
  console.log(msg);
}

function writeFinding(id, title, content) {
  writeFileSync(
    `scripts/findings/${id}.md`,
    `# ${title}\n\nModel: \`gemini-3.1-flash-lite-preview\`\nDate: ${new Date().toISOString().slice(0, 10)}\nRuns per test: ${RUNS}\n\n${content}`
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  P1: Axis Seeding
// ═══════════════════════════════════════════════════════════════════════

async function p1_axisSeed() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  P1: Axis Seeding                                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

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
  ];

  const results = [];

  for (const intent of intents) {
    console.log(`--- Intent: "${intent}" ---`);
    for (let i = 0; i < RUNS; i++) {
      try {
        const start = Date.now();
        const result = await generateText({
          model: generator,
          temperature: 0,
          output: Output.object({ schema: axisSchema }),
          prompt: `You are seeding the initial taste axes for The Eye Loop, a preference discovery system.

The user's intent: "${intent}"

Generate 5-7 binary taste axes that will be probed through visual facades (words, images, UI mockups).

RULES:
- Each axis must be a measurable visual/design control, NOT a vibe or adjective
- Each axis has exactly two poles (optionA vs optionB)
- Axes must be operationally distinct — varying one should produce visually different output
- Good: "color temperature" (warm 3200K vs cool 6500K), "density" (sparse vs packed), "corner radius" (rounded 16px vs sharp 0px)
- Bad: "mood" (happy vs sad), "quality" (good vs bad), "feel" (modern vs classic)
- Include at least one axis about: layout, color, typography, and density
- id should be kebab-case`,
        });
        const elapsed = Date.now() - start;
        const axes = result.output?.axes ?? [];

        // Judge quality
        const vibeWords = /mood|feel|vibe|quality|style|aesthetic|energy|spirit|tone|character/i;
        const measurable = /px|rem|%|K|\d+|dense|sparse|packed|rounded|sharp|serif|sans|mono|grid|column|stack/i;

        const vibeCount = axes.filter(a =>
          vibeWords.test(a.label) || vibeWords.test(a.optionA) || vibeWords.test(a.optionB)
        ).length;
        const measurableCount = axes.filter(a =>
          measurable.test(a.optionA) || measurable.test(a.optionB)
        ).length;
        const hasBinaryPoles = axes.every(a => a.optionA && a.optionB && a.optionA !== a.optionB);
        const rightCount = axes.length >= 5 && axes.length <= 7;
        const uniqueIds = new Set(axes.map(a => a.id)).size === axes.length;

        results.push({
          intent, run: i, elapsed, axisCount: axes.length,
          vibeCount, measurableCount, hasBinaryPoles, rightCount, uniqueIds,
          axes: axes.map(a => `${a.id}: ${a.optionA} vs ${a.optionB}`),
        });

        console.log(`  Run ${i+1}: ${axes.length} axes, ${measurableCount} measurable, ${vibeCount} vibes, ${elapsed}ms`);
        if (i === 0) axes.forEach(a => console.log(`    ${a.id}: ${a.optionA} ↔ ${a.optionB}`));
      } catch (err) {
        console.log(`  Run ${i+1}: ERROR — ${err.message?.slice(0, 100)}`);
        results.push({ intent, run: i, error: err.message?.slice(0, 100) });
      }
    }
  }

  const avgMeasurable = results.filter(r => !r.error).reduce((s, r) => s + r.measurableCount, 0) / results.filter(r => !r.error).length;
  const avgVibes = results.filter(r => !r.error).reduce((s, r) => s + r.vibeCount, 0) / results.filter(r => !r.error).length;
  const avgCount = results.filter(r => !r.error).reduce((s, r) => s + r.axisCount, 0) / results.filter(r => !r.error).length;

  const summary = `## Summary

- Average axis count: ${avgCount.toFixed(1)} (target: 5-7)
- Average measurable axes: ${avgMeasurable.toFixed(1)}
- Average vibe axes: ${avgVibes.toFixed(1)} (target: 0)
- All binary poles valid: ${results.filter(r => !r.error).every(r => r.hasBinaryPoles)}

## Recommendation

${avgVibes > 1 ? '**NEEDS PROMPT TUNING** — too many vibe axes. Add explicit negative examples to prompt.' : '**GOOD** — axes are measurable and operationalized.'}

${avgCount < 5 ? '**NEEDS PROMPT TUNING** — generating fewer than 5 axes.' : ''}

## Raw Results

${results.map(r => r.error ? `- ${r.intent} run ${r.run}: ERROR` : `- ${r.intent} run ${r.run}: ${r.axisCount} axes, ${r.measurableCount} meas, ${r.vibeCount} vibes, ${r.elapsed}ms`).join('\n')}

## Sample Axes

${results.filter(r => !r.error && r.run === 0).map(r => `### "${r.intent}"\n${r.axes.map(a => `- ${a}`).join('\n')}`).join('\n\n')}
`;

  writeFinding('p1-axis-seeding', 'P1: Axis Seeding', summary);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  P2: SCHEMA 7-field Compliance
// ═══════════════════════════════════════════════════════════════════════

async function p2_schemaCompliance() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  P2: SCHEMA 7-field Compliance                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const ANIMA = `# Anima | 8 swipes | stage: images
intent: "portfolio site for an architect"
resolved:
  tone:
    value: minimal
    confidence: 0.92
    evidence: [+calm, +whitespace, -brutalist, -maximalist]
exploring:
  palette:
    hypotheses: [warm-neutral, cool-monochrome, earth-toned]
    distribution: [0.4, 0.35, 0.25]
anti_patterns:
  - corporate blue + white grid
  - dense data tables`;

  // Version A: original prompt from bench (scored 67%)
  const promptA = `You are a Scout agent in The Eye Loop.
Target the EXPLORING dimension with the flattest distribution.
PROHIBITIONS are more important than requirements.
Use quantified specs: "color temperature 3200K" not "cool tones".

ANIMA STATE:
${ANIMA}

STAGE: images
Output an image generation prompt following IMAGE SCHEMA:
SUBJECT, STYLE, LIGHTING, BACKGROUND, COMPOSITION, MANDATORY (3-5), PROHIBITIONS (3-5)

Then output metadata: hypothesis_tested, accept_implies, reject_implies, dimension, held_constant`;

  // Version B: explicit field template
  const promptB = `You are a Scout agent in The Eye Loop.
Target the EXPLORING dimension with the flattest distribution.
Use quantified specs: "color temperature 3200K" not "cool tones".
Use photographic/cinematic language: "85mm portrait lens" not "close-up".

ANIMA STATE:
${ANIMA}

STAGE: images

Output an IMAGE SCHEMA prompt with ALL 7 fields in this EXACT format:

SUBJECT: [from hypothesis — what the image depicts]
STYLE: [from resolved Anima — e.g., "editorial photography, 35mm film grain"]
LIGHTING: [quantified — e.g., "5500K natural, upper-left key, soft fill"]
BACKGROUND: [from resolved or exploring dimension]
COMPOSITION: [from resolved or exploring dimension]
MANDATORY (3-5): [properties that MUST appear — from resolved dimensions]
PROHIBITIONS (3-5): [properties that MUST NOT appear — from anti-patterns]

Then output metadata:
hypothesis_tested: "..."
accept_implies: "..."
reject_implies: "..."
dimension: "..."
held_constant: [...]`;

  const versions = [
    { label: 'A (original)', prompt: promptA },
    { label: 'B (explicit template)', prompt: promptB },
  ];

  const results = [];

  for (const v of versions) {
    console.log(`--- ${v.label} ---`);
    for (let i = 0; i < RUNS; i++) {
      try {
        const start = Date.now();
        const result = await generateText({ model: generator, prompt: v.prompt, maxTokens: 600 });
        const elapsed = Date.now() - start;
        const text = result.text;

        const fields = {
          SUBJECT: /SUBJECT:/i.test(text),
          STYLE: /STYLE:/i.test(text),
          LIGHTING: /LIGHTING:/i.test(text),
          BACKGROUND: /BACKGROUND:/i.test(text),
          COMPOSITION: /COMPOSITION:/i.test(text),
          MANDATORY: /MANDATORY\s*\(/i.test(text),
          PROHIBITIONS: /PROHIBITIONS?\s*\(/i.test(text),
        };
        const fieldCount = Object.values(fields).filter(Boolean).length;
        const quantified = /\d+K|\d+mm|\d+px|\d+%/i.test(text);
        const hasMetadata = /hypothesis_tested/i.test(text);

        results.push({
          version: v.label, run: i, elapsed, fieldCount, fields, quantified, hasMetadata,
          sample: i === 0 ? text.slice(0, 500) : null,
        });

        const missing = Object.entries(fields).filter(([,v]) => !v).map(([k]) => k);
        console.log(`  Run ${i+1}: ${fieldCount}/7 fields, quant=${quantified}, meta=${hasMetadata}, ${elapsed}ms${missing.length ? ` MISSING: ${missing.join(', ')}` : ''}`);
      } catch (err) {
        console.log(`  Run ${i+1}: ERROR — ${err.message?.slice(0, 100)}`);
        results.push({ version: v.label, run: i, error: err.message?.slice(0, 100) });
      }
    }
  }

  const byVersion = {};
  for (const r of results.filter(r => !r.error)) {
    if (!byVersion[r.version]) byVersion[r.version] = [];
    byVersion[r.version].push(r);
  }

  let summary = '## Results by Prompt Version\n\n';
  for (const [ver, runs] of Object.entries(byVersion)) {
    const avgFields = runs.reduce((s, r) => s + r.fieldCount, 0) / runs.length;
    const allQuant = runs.every(r => r.quantified);
    const allMeta = runs.every(r => r.hasMetadata);
    summary += `### ${ver}\n- Average fields: ${avgFields.toFixed(1)}/7\n- All quantified: ${allQuant}\n- All metadata: ${allMeta}\n`;
    const sample = runs.find(r => r.sample);
    if (sample) summary += `\n\`\`\`\n${sample.sample}\n\`\`\`\n`;
    summary += '\n';
  }

  const best = Object.entries(byVersion).sort((a, b) => {
    const avgA = a[1].reduce((s, r) => s + r.fieldCount, 0) / a[1].length;
    const avgB = b[1].reduce((s, r) => s + r.fieldCount, 0) / b[1].length;
    return avgB - avgA;
  })[0];

  summary += `## Recommendation\n\n**Use prompt version ${best[0]}** (${(best[1].reduce((s, r) => s + r.fieldCount, 0) / best[1].length).toFixed(1)}/7 avg fields).\n`;
  summary += `\nFor implementation: use the winning prompt template in \`src/lib/server/agents/scout.ts\` for image-stage facades.\n`;

  writeFinding('p2-schema-compliance', 'P2: SCHEMA 7-field Compliance', summary);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  P3: Anti-pattern Enforcement
// ═══════════════════════════════════════════════════════════════════════

async function p3_antiPatterns() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  P3: Anti-pattern Enforcement                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const prompt = `Generate a complete HTML+CSS mobile mockup (375x667, inline styles, no scripts) for a personal finance dashboard.

RESOLVED TASTE PROFILE:
- tone: warm-organic (rounded corners, natural textures)
- density: sparse (generous whitespace, max 3 visible sections)
- color temperature: warm (amber, peach, cream — color values in #FFxxxx and #FFF range)

PROHIBITIONS (MUST NOT appear — these override everything else):
1. NO corporate blue (#0000FF, #0066CC, #1a73e8, #2196F3, or any hue 200-240 in HSL)
2. NO dense data tables (no <table> with more than 2 columns)
3. NO sharp rectangular cards (all containers must have border-radius >= 12px)
4. NO drop shadows with blur > 4px
5. NO sans-serif font stacks starting with Arial or Helvetica

Generate ONLY the HTML. No explanation.`;

  const results = [];

  for (let i = 0; i < RUNS; i++) {
    try {
      const start = Date.now();
      const result = await generateText({ model: generator, prompt, maxTokens: 2500 });
      const elapsed = Date.now() - start;
      const html = result.text;

      // Check violations
      const blueHex = /#[0-9a-f]{6}/gi;
      const hexMatches = html.match(blueHex) || [];
      const blueViolations = hexMatches.filter(hex => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return b > 150 && b > r * 1.3 && b > g * 1.3; // clearly blue-dominant
      });

      const tableViolation = /<table/i.test(html);
      const sharpCorners = /border-radius:\s*0(?:px)?[^1-9]/i.test(html) || (!/border-radius/i.test(html) && /<div/i.test(html));
      const bigShadow = /box-shadow:[^;]*\b([5-9]|[1-9]\d+)px/i.test(html);
      const arialFont = /font-family:[^;]*(Arial|Helvetica)/i.test(html);

      const violations = [];
      if (blueViolations.length) violations.push(`blue colors: ${blueViolations.join(', ')}`);
      if (tableViolation) violations.push('contains <table>');
      if (sharpCorners) violations.push('sharp corners (missing border-radius)');
      if (bigShadow) violations.push('large drop shadow');
      if (arialFont) violations.push('Arial/Helvetica font');

      const clean = violations.length === 0;

      results.push({ run: i, elapsed, clean, violations, htmlLength: html.length, hexColors: hexMatches });

      console.log(`  Run ${i+1}: ${clean ? 'CLEAN' : 'VIOLATIONS: ' + violations.join(', ')} (${elapsed}ms, ${html.length} chars)`);
      console.log(`    Colors found: ${hexMatches.slice(0, 8).join(', ')}`);
    } catch (err) {
      console.log(`  Run ${i+1}: ERROR — ${err.message?.slice(0, 100)}`);
      results.push({ run: i, error: err.message?.slice(0, 100) });
    }
  }

  const cleanRate = results.filter(r => !r.error && r.clean).length / results.filter(r => !r.error).length;
  const allViolations = results.filter(r => !r.error).flatMap(r => r.violations);
  const violationFreq = {};
  allViolations.forEach(v => { violationFreq[v] = (violationFreq[v] || 0) + 1; });

  const summary = `## Summary

- Clean rate: ${(cleanRate * 100).toFixed(0)}% (${results.filter(r => !r.error && r.clean).length}/${results.filter(r => !r.error).length} runs)

## Violation Frequency

${Object.entries(violationFreq).map(([v, c]) => `- ${v}: ${c}/${results.filter(r => !r.error).length} runs`).join('\n') || '(none)'}

## Recommendation

${cleanRate >= 0.8 ? '**GOOD** — anti-patterns are respected at ' + (cleanRate * 100).toFixed(0) + '% rate.' : '**NEEDS PROMPT TUNING** — violation rate too high. Consider:\n- Making PROHIBITIONS the FIRST section (before resolved profile)\n- Adding "VERIFY: before outputting, check each prohibition is satisfied"\n- Using structured output to force compliance checks'}

## Implementation Note

For \`src/lib/server/agents/scout.ts\`: always place PROHIBITIONS before MANDATORY in the prompt. The model processes them in order and gives more weight to earlier constraints.

## Raw Results

${results.map(r => r.error ? `- Run ${r.run}: ERROR` : `- Run ${r.run}: ${r.clean ? 'CLEAN' : r.violations.join(', ')} (${r.elapsed}ms)`).join('\n')}
`;

  writeFinding('p3-anti-patterns', 'P3: Anti-pattern Enforcement', summary);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  P4: Anima YAML Round-trip
// ═══════════════════════════════════════════════════════════════════════

async function p4_animaRoundtrip() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  P4: Anima YAML Round-trip                             ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const animaBefore = `# Anima | 6 swipes | stage: images
intent: "weather app for runners"

resolved:
  tone:
    value: energetic
    confidence: 0.90
    evidence: [+bold, +dynamic, -calm, -muted]

exploring:
  palette:
    hypotheses: [sunset-warm, ocean-cool, forest-green]
    distribution: [0.35, 0.35, 0.30]
    probes_spent: 2
  density:
    hypotheses: [sparse, moderate]
    distribution: [0.50, 0.50]
    probes_spent: 1

unprobed:
  - typography
  - layout_pattern

anti_patterns:
  - muted pastels
  - heavy gradients`;

  const swipe = `facade_id: f-007
dimension: palette
hypothesis_tested: "sunset-warm vs ocean-cool"
option_shown: sunset-warm
decision: accept
confidence: 0.75`;

  const results = [];

  for (let i = 0; i < RUNS; i++) {
    try {
      const start = Date.now();
      const result = await generateText({
        model: generator,
        temperature: 0,
        prompt: `You maintain the Anima state for The Eye Loop.

CURRENT ANIMA:
${animaBefore}

SWIPE RESULT:
${swipe}

TASK: Update the Anima YAML to reflect this swipe result.

RULES:
- Increase confidence on the targeted dimension's winning hypothesis
- Decrease the losing hypothesis proportionally
- Update swipe count (6 → 7)
- Do NOT touch resolved dimensions
- Do NOT remove anti-patterns
- Keep the EXACT same YAML format
- Output ONLY the updated YAML, no explanation

TOKEN BUDGET: under 300 tokens.`,
        maxTokens: 400,
      });
      const elapsed = Date.now() - start;
      const text = result.text;

      // Check quality
      const hasIntent = /intent:/.test(text);
      const hasResolved = /resolved:/.test(text);
      const hasExploring = /exploring:/.test(text);
      const hasAntiPatterns = /anti_patterns:/.test(text);
      const swipeUpdated = /[78] swipes/.test(text);
      const sunsetIncreased = /sunset.*0\.[4-9]/s.test(text) || /\[0\.[4-9]/.test(text);
      const oceanDecreased = /ocean.*0\.[12]/s.test(text);
      const toneUntouched = /tone:[\s\S]*?value: energetic/.test(text);
      const under300 = text.split(/\s+/).length < 300;

      const checks = { hasIntent, hasResolved, hasExploring, hasAntiPatterns, swipeUpdated, sunsetIncreased, toneUntouched, under300 };
      const passed = Object.values(checks).filter(Boolean).length;

      results.push({ run: i, elapsed, passed, total: Object.keys(checks).length, checks, text: text.slice(0, 600) });

      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      console.log(`  Run ${i+1}: ${passed}/${Object.keys(checks).length} checks, ${elapsed}ms${failed.length ? ` FAILED: ${failed.join(', ')}` : ''}`);
    } catch (err) {
      console.log(`  Run ${i+1}: ERROR — ${err.message?.slice(0, 100)}`);
      results.push({ run: i, error: err.message?.slice(0, 100) });
    }
  }

  const avgPassed = results.filter(r => !r.error).reduce((s, r) => s + r.passed, 0) / results.filter(r => !r.error).length;
  const total = results[0]?.total ?? 8;

  const summary = `## Summary

- Average checks passed: ${avgPassed.toFixed(1)}/${total}
- Consistent across runs: ${results.filter(r => !r.error).every(r => r.passed === results.filter(r2 => !r2.error)[0].passed)}

## Check Details

${results.filter(r => !r.error).map(r => `### Run ${r.run + 1} (${r.passed}/${r.total})\n${Object.entries(r.checks).map(([k, v]) => `- ${v ? 'PASS' : 'FAIL'}: ${k}`).join('\n')}`).join('\n\n')}

## Recommendation

${avgPassed >= 7 ? '**GOOD** — Flash Lite handles YAML round-trips reliably.' : '**NEEDS WORK** — Consider using structured output (Output.object) instead of free-text YAML generation for between-compaction updates. Or keep updates as pure code (the V0 spec says between-compaction updates are code, not LLM).'}

## Implementation Note

For \`src/lib/server/context.ts\`: between-compaction Anima updates should be **pure code** (shift distributions by fixed amounts based on swipe result). LLM-based YAML rewriting is only needed for compaction (every 5 swipes). This test validates the compaction path.

## Sample Output

\`\`\`yaml
${results.find(r => !r.error)?.text ?? '(no output)'}
\`\`\`
`;

  writeFinding('p4-anima-roundtrip', 'P4: Anima YAML Round-trip', summary);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  P5: Scout Semantic Correctness
// ═══════════════════════════════════════════════════════════════════════

async function p5_scoutSemantics() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  P5: Scout Semantic Correctness                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const facadeSchema = z.object({
    content: z.string(),
    hypothesis_tested: z.string(),
    accept_implies: z.string(),
    reject_implies: z.string(),
    dimension: z.string(),
    held_constant: z.array(z.string()),
  });

  // Anima with a clear weakest axis (typography at 0.50/0.50) and clear resolved (tone at 0.95)
  const anima = `# Anima | 5 swipes | stage: words
intent: "portfolio site for an architect"

resolved:
  tone:
    value: minimal-calm
    confidence: 0.95
    evidence: [+whitespace, +subtle, -loud, -maximalist]
  color_temp:
    value: warm-neutral
    confidence: 0.88
    evidence: [+sand, +cream, -neon, -cool-blue]

exploring:
  typography:
    hypotheses: [geometric-sans, humanist-serif]
    distribution: [0.50, 0.50]
    probes_spent: 1
  layout:
    hypotheses: [asymmetric-grid, single-column]
    distribution: [0.60, 0.40]
    probes_spent: 2

unprobed:
  - imagery_style

anti_patterns:
  - loud maximalist colors
  - cool blue corporate palette`;

  const results = [];

  for (let i = 0; i < RUNS; i++) {
    try {
      const start = Date.now();
      const result = await generateText({
        model: generator,
        output: Output.object({ schema: facadeSchema }),
        prompt: `You are a Scout agent in The Eye Loop — a taste discovery system.

Your job: generate a visual probe (facade) that MAXIMALLY DISCRIMINATES between competing hypotheses.

RULES:
- Target the EXPLORING dimension with the FLATTEST distribution (most uncertain = closest to 0.50/0.50)
- Every RESOLVED dimension is LOCKED — your output must hold them constant
- PROHIBITIONS are hard constraints — never violate anti-patterns
- You are trying to PARTITION remaining uncertainty, not please

ANIMA STATE:
${anima}

STAGE: words
Output a single evocative word or short phrase (2-3 words max) as the facade content.`,
      });
      const elapsed = Date.now() - start;
      const o = result.output;

      // Semantic checks
      const targetsTypography = /typograph/i.test(o.dimension);
      const targetsWeakest = targetsTypography; // typography is 0.50/0.50, the flattest
      const holdsResolved = o.held_constant?.some(h => /tone|minimal|calm/i.test(h)) &&
                            o.held_constant?.some(h => /color|warm|neutral/i.test(h));
      const noAntiPattern = !/loud|maximalist|neon|cool.*blue|corporate/i.test(o.content);
      const shortContent = o.content.split(/\s+/).length <= 4;
      const hasHypothesis = o.hypothesis_tested.length > 10;

      const checks = { targetsWeakest, holdsResolved, noAntiPattern, shortContent, hasHypothesis };
      const passed = Object.values(checks).filter(Boolean).length;

      results.push({ run: i, elapsed, passed, total: Object.keys(checks).length, checks, output: o });

      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      console.log(`  Run ${i+1}: ${passed}/${Object.keys(checks).length} | dim="${o.dimension}" content="${o.content}" ${elapsed}ms${failed.length ? ` FAILED: ${failed.join(', ')}` : ''}`);
    } catch (err) {
      console.log(`  Run ${i+1}: ERROR — ${err.message?.slice(0, 100)}`);
      results.push({ run: i, error: err.message?.slice(0, 100) });
    }
  }

  const avgPassed = results.filter(r => !r.error).reduce((s, r) => s + r.passed, 0) / results.filter(r => !r.error).length;
  const total = results[0]?.total ?? 5;
  const weakestRate = results.filter(r => !r.error && r.checks?.targetsWeakest).length / results.filter(r => !r.error).length;

  const summary = `## Summary

- Average checks passed: ${avgPassed.toFixed(1)}/${total}
- Targets weakest axis (typography 50/50): ${(weakestRate * 100).toFixed(0)}% of runs

## Semantic Checks

${results.filter(r => !r.error).map(r => `### Run ${r.run + 1}
- Dimension targeted: \`${r.output.dimension}\`
- Content: "${r.output.content}"
- Hypothesis: "${r.output.hypothesis_tested}"
- Held constant: ${JSON.stringify(r.output.held_constant)}
${Object.entries(r.checks).map(([k, v]) => `- ${v ? 'PASS' : 'FAIL'}: ${k}`).join('\n')}`).join('\n\n')}

## Recommendation

${weakestRate >= 0.8 ? '**GOOD** — Scout reliably targets the most uncertain axis.' : '**NEEDS PROMPT TUNING** — Scout is not consistently targeting the flattest distribution. Consider adding explicit instruction: "The most uncertain axis right now is typography (0.50/0.50). Target it."'}

## Implementation Note

For \`src/lib/server/agents/scout.ts\`: the code should compute the weakest axis and inject it into the prompt explicitly, not rely on the LLM to parse distributions from YAML. Pre-compute: \`const weakest = axes.sort((a,b) => a.confidence - b.confidence)[0]\`.
`;

  writeFinding('p5-scout-semantics', 'P5: Scout Semantic Correctness', summary);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  P6: Builder Hint Quality
// ═══════════════════════════════════════════════════════════════════════

async function p6_builderHints() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  P6: Builder Hint Quality                              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const hintSchema = z.object({
    updated_sections: z.array(z.object({
      name: z.string(),
      status: z.string(),
      content_summary: z.string(),
    })),
    next_hint: z.nullable(z.string()),
    new_anti_patterns: z.array(z.string()),
  });

  const results = [];

  for (let i = 0; i < RUNS; i++) {
    try {
      const start = Date.now();
      const result = await generateText({
        model: generator,
        temperature: 0,
        output: Output.object({ schema: hintSchema }),
        prompt: `You are the Builder agent in The Eye Loop.

You maintain a living draft prototype. You never generate facades. You never face the user.

ANIMA STATE:
# Anima | 7 swipes | stage: images
intent: "weather app for runners"
resolved:
  tone: { value: energetic, confidence: 0.90 }
  palette: { value: sunset-warm, confidence: 0.82 }
exploring:
  density: { hypotheses: [sparse, packed], distribution: [0.55, 0.45], probes_spent: 2 }
  typography: { hypotheses: [geometric-sans, rounded-mono], distribution: [0.50, 0.50], probes_spent: 1 }
anti_patterns:
  - muted pastels
  - corporate blue

CURRENT DRAFT:
  hero:
    status: partial
    content_summary: "Energetic hero with sunset gradient, runner silhouette placeholder"
    blocking: "typography unresolved — can't set heading font"
  dashboard:
    status: blocked
    content_summary: ""
    blocking: "needs density + typography to start layout"

LAST SWIPE:
  facade_id: f-008
  decision: accept
  content_summary: "Moodboard with bold amber tones, dynamic angled composition, runner in motion"
  hypothesis: "sunset-warm palette with energetic composition"
  observation: { confidence: 0.78, boundary_proximity: 0.22 }

Update the draft and identify what blocks you. If blocked, output a construction-grounded next_hint.
BAD hint: "typography axis unresolved"
GOOD hint: "Building the hero heading — need to know: geometric sans-serif (sharp, technical feel) or rounded mono (playful, app-like), given resolved energetic tone with sunset palette"`,
      });
      const elapsed = Date.now() - start;
      const o = result.output;

      // Judge hint quality
      const hint = o.next_hint ?? '';
      const isConstructionGrounded = /build|heading|header|section|component|layout|card|nav|font|set|place/i.test(hint);
      const mentionsSpecificPart = /hero|dashboard|header|card|section|component/i.test(hint);
      const mentionsResolvedContext = /energetic|sunset|warm|resolved/i.test(hint);
      const notAbstract = !/unresolved|axis|dimension|uncertain|unknown/i.test(hint) || /need to know/i.test(hint);
      const hasHint = hint.length > 20;

      const checks = { hasHint, isConstructionGrounded, mentionsSpecificPart, mentionsResolvedContext, notAbstract };
      const passed = Object.values(checks).filter(Boolean).length;

      results.push({ run: i, elapsed, passed, total: Object.keys(checks).length, checks, hint, output: o });

      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      console.log(`  Run ${i+1}: ${passed}/${Object.keys(checks).length} | hint="${hint.slice(0, 100)}" ${elapsed}ms${failed.length ? ` FAILED: ${failed.join(', ')}` : ''}`);
    } catch (err) {
      console.log(`  Run ${i+1}: ERROR — ${err.message?.slice(0, 100)}`);
      results.push({ run: i, error: err.message?.slice(0, 100) });
    }
  }

  const avgPassed = results.filter(r => !r.error).reduce((s, r) => s + r.passed, 0) / results.filter(r => !r.error).length;
  const total = results[0]?.total ?? 5;

  const summary = `## Summary

- Average checks passed: ${avgPassed.toFixed(1)}/${total}

## Hint Quality Checks

${results.filter(r => !r.error).map(r => `### Run ${r.run + 1} (${r.passed}/${r.total})
- **Hint:** "${r.hint}"
${Object.entries(r.checks).map(([k, v]) => `- ${v ? 'PASS' : 'FAIL'}: ${k}`).join('\n')}
- Updated sections: ${r.output.updated_sections.map(s => s.name).join(', ')}
- New anti-patterns: ${r.output.new_anti_patterns.length ? r.output.new_anti_patterns.join(', ') : '(none)'}`).join('\n\n')}

## Recommendation

${avgPassed >= 4 ? '**GOOD** — Builder produces construction-grounded hints that reference specific UI components and resolved context.' : '**NEEDS PROMPT TUNING** — Hints are too abstract. Add more BAD/GOOD examples to the prompt, or force structured output that requires a component name.'}

## Implementation Note

For \`src/lib/server/agents/builder.ts\`: the GOOD/BAD hint examples in the prompt are critical for quality. Keep them. The builder should always reference what it's trying to build and what resolved dimensions constrain the answer.
`;

  writeFinding('p6-builder-hints', 'P6: Builder Hint Quality', summary);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  Run All
// ═══════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  PROMPT TUNING BENCHMARK SUITE                         ║');
console.log('╚══════════════════════════════════════════════════════════╝');

const probes = [
  { id: 'p1', fn: p1_axisSeed },
  { id: 'p2', fn: p2_schemaCompliance },
  { id: 'p3', fn: p3_antiPatterns },
  { id: 'p4', fn: p4_animaRoundtrip },
  { id: 'p5', fn: p5_scoutSemantics },
  { id: 'p6', fn: p6_builderHints },
];

for (const probe of probes) {
  await probe.fn();
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  ALL DONE — findings in scripts/findings/p1-p6*.md');
console.log('═══════════════════════════════════════════════════════════\n');
