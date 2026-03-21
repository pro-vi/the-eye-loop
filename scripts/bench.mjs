import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import { writeFileSync } from 'fs';

process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;

// ── Mock Anima state (realistic mid-session) ──────────────────────────

const ANIMA_YAML = `# Anima | 8 swipes | stage: images
intent: "a personal finance app that doesn't feel like a spreadsheet"

resolved:
  tone:
    value: warm-organic
    confidence: 0.92
    evidence: [+earthy, +rounded, -corporate, -sharp-edges]
  density:
    value: sparse
    confidence: 0.85
    evidence: [+whitespace, +breathing-room, -packed-grid, -data-heavy]

exploring:
  palette:
    hypotheses: [sunset-warm, forest-muted, ocean-cool]
    distribution: [0.4, 0.35, 0.25]
    probes_spent: 3
  typography:
    hypotheses: [geometric-sans, humanist-serif, rounded-mono]
    distribution: [0.33, 0.34, 0.33]
    probes_spent: 1

unprobed:
  - navigation_style
  - chart_visualization
  - onboarding_flow

anti_patterns:
  - corporate blue + white grid
  - dense data tables as primary view
  - sharp rectangular cards with drop shadows`;

const SCOUT_HISTORY_YAML = `- facade_id: f-007
  dimension: palette
  hypothesis: "sunset-warm vs forest-muted"
  decision: accept
  latency_signal: fast
  lesson: "user gravitates toward warm golden tones immediately"
- facade_id: f-006
  dimension: palette
  hypothesis: "ocean-cool vs sunset-warm"
  decision: reject
  latency_signal: slow
  lesson: "ocean-cool not rejected confidently — may work as accent"
- facade_id: f-005
  dimension: tone
  hypothesis: "organic vs minimal-tech"
  decision: accept
  latency_signal: fast
  lesson: "strong preference for organic textures over clean tech"`;

const SWIPE_RESULT = `facade_id: f-007
decision: accept
content_summary: "Moodboard with sunset-warm palette: amber gradients, soft peach accents, cream backgrounds, organic rounded shapes"
hypothesis: "sunset-warm palette over forest-muted for finance app"
observation:
  decision: accept
  confidence: 0.78
  boundary_proximity: 0.22`;

const DRAFT_SECTIONS_YAML = `hero:
  status: partial
  resolved_from: [f-003, f-005]
  content_summary: "Warm organic hero with curved container, greeting-first layout"
  blocking: "color palette unresolved — cannot finalize gradient and accent colors"
dashboard:
  status: blocked
  resolved_from: []
  content_summary: ""
  blocking: "needs palette + chart_visualization + navigation_style"`;

const EVIDENCE_YAML = `- swipe: 6
  facade_id: f-006
  dimension: palette
  hypothesis: ocean-cool
  decision: reject
  confidence: 0.55
  boundary_proximity: 0.45
- swipe: 7
  facade_id: f-007
  dimension: palette
  hypothesis: sunset-warm
  decision: accept
  confidence: 0.78
  boundary_proximity: 0.22
- swipe: 8
  facade_id: f-008
  dimension: typography
  hypothesis: geometric-sans
  decision: accept
  confidence: 0.6
  boundary_proximity: 0.4`;

// ── Benchmark definitions ─────────────────────────────────────────────

const benchmarks = [
  {
    name: 'Scout: Word Facade',
    role: 'scout',
    prompt: `You are a Scout agent in The Eye Loop — a taste discovery system.

Your job: generate a visual probe (facade) that MAXIMALLY DISCRIMINATES
between competing hypotheses about the user's preference.

RULES:
- A good facade makes the user's accept/reject reveal NEW information
- If accepted, it should confirm hypothesis A. If rejected, hypothesis B.
- Every RESOLVED dimension is LOCKED — your output must hold them constant
- Target the EXPLORING dimension with the flattest distribution (most uncertain)
- PROHIBITIONS are more important than requirements
- You are not trying to please. You are trying to PARTITION remaining uncertainty.

ANIMA STATE:
${ANIMA_YAML}

PROBE BRIEF: None — self-assign from most uncertain exploring dimension

STAGE: words
STAGE RULES:
- words: output a single evocative word or short phrase (2-3 words max)

YOUR LOCAL HISTORY:
${SCOUT_HISTORY_YAML}

OUTPUT:
1. The facade content (single word or short phrase)
2. Metadata:
   hypothesis_tested: "{what accept vs reject would tell us}"
   accept_implies: "{what becomes more likely}"
   reject_implies: "{what becomes more likely}"
   dimension: "{which axis this targets}"
   held_constant: [tone: warm-organic, density: sparse]`,
    maxTokens: 200,
    judge: (text) => {
      const has_word = text.length < 500;
      const has_hypothesis = /hypothesis_tested/i.test(text);
      const has_dimension = /dimension/i.test(text);
      const respects_resolved = !/corporate|sharp|dense/i.test(text.split('\n')[0]);
      return { has_word, has_hypothesis, has_dimension, respects_resolved };
    },
  },
  {
    name: 'Scout: Image SCHEMA Prompt',
    role: 'scout',
    prompt: `You are a Scout agent in The Eye Loop — a taste discovery system.

Your job: generate a visual probe (facade) that MAXIMALLY DISCRIMINATES
between competing hypotheses about the user's preference.

RULES:
- Target the EXPLORING dimension with the flattest distribution
- PROHIBITIONS are more important than requirements
- Use quantified specs: "color temperature 3200K" not "cool tones"
- Use photographic/cinematic language: "85mm portrait lens" not "close-up"

ANIMA STATE:
${ANIMA_YAML}

PROBE BRIEF: None — self-assign from most uncertain exploring dimension

STAGE: images
STAGE RULES:
- images: output an image generation prompt following IMAGE SCHEMA below

IMAGE SCHEMA:
SUBJECT: {from hypothesis or probe brief}
STYLE: {from resolved Anima}
LIGHTING: {quantified}
BACKGROUND: {from resolved or exploring dimension}
COMPOSITION: {from resolved or exploring dimension}
MANDATORY (3-5): {from resolved dimensions}
PROHIBITIONS (3-5): {from anti-patterns + rejected evidence}

YOUR LOCAL HISTORY:
${SCOUT_HISTORY_YAML}

OUTPUT:
1. The IMAGE SCHEMA prompt (all 7 fields)
2. Metadata:
   hypothesis_tested, accept_implies, reject_implies, dimension, held_constant`,
    maxTokens: 400,
    judge: (text) => {
      const has_subject = /SUBJECT:/i.test(text);
      const has_prohibitions = /PROHIBITIONS?:/i.test(text);
      const has_mandatory = /MANDATORY:/i.test(text);
      const has_lighting = /LIGHTING:/i.test(text);
      const quantified = /\d+K|\d+mm|\d+%/i.test(text);
      const has_metadata = /hypothesis_tested/i.test(text);
      return { has_subject, has_prohibitions, has_mandatory, has_lighting, quantified, has_metadata };
    },
  },
  {
    name: 'Scout: HTML Mockup',
    role: 'scout',
    prompt: `You are a Scout agent in The Eye Loop — a taste discovery system.

RULES:
- Target the EXPLORING dimension with the flattest distribution
- Every RESOLVED dimension is LOCKED
- PROHIBITIONS are hard constraints

ANIMA STATE:
${ANIMA_YAML}

PROBE BRIEF: "Building the dashboard — need to know: card-based grid or single-stream feed, given resolved sparse layout with warm-organic tone"

STAGE: mockups
STAGE RULES:
- mockups: output complete HTML+CSS (mobile viewport 375x667, inline styles, no scripts)

YOUR LOCAL HISTORY:
${SCOUT_HISTORY_YAML}

OUTPUT:
1. Complete HTML+CSS mockup
2. Metadata:
   hypothesis_tested, accept_implies, reject_implies, dimension, held_constant`,
    maxTokens: 2000,
    judge: (text) => {
      const has_html = /<html|<!DOCTYPE|<div/i.test(text);
      const has_inline_styles = /style="/i.test(text);
      const mobile_viewport = /375|viewport/i.test(text);
      const warm_palette = /warm|amber|peach|cream|organic|#f|rgb\(2[2-5]/i.test(text);
      const no_corporate = !/corporate.*blue|#0000ff|sharp.*shadow/i.test(text);
      const has_metadata = /hypothesis_tested/i.test(text);
      return { has_html, has_inline_styles, mobile_viewport, warm_palette, no_corporate, has_metadata };
    },
  },
  {
    name: 'Builder: Probe Brief',
    role: 'builder',
    prompt: `You are the Builder agent in The Eye Loop.

Your job: maintain a living draft prototype assembled from surviving artifacts.
You never generate facades. You never face the user.

ON EACH SWIPE RESULT:
- Accept → integrate the surviving artifact's visual properties into the draft
- Reject → add the rejected properties to anti-patterns

THEN: identify what BLOCKS you from building the next section.
Not "what's abstractly uncertain" — what specific question, if answered,
would let you write the next concrete component?

ANIMA STATE:
${ANIMA_YAML}

CURRENT DRAFT STATE:
${DRAFT_SECTIONS_YAML}

ANTI-PATTERNS:
- corporate blue + white grid
- dense data tables as primary view
- sharp rectangular cards with drop shadows

LAST SWIPE:
${SWIPE_RESULT}

OUTPUT:
1. Updated draft sections (only sections that changed)
2. Probe briefs (0 or more)
3. Updated anti-patterns (if reject added new ones)`,
    maxTokens: 600,
    judge: (text) => {
      const updates_hero = /hero/i.test(text);
      const has_probe = /brief|probe|blocking|question/i.test(text);
      const construction_grounded = /header|section|component|layout|grid|card|nav/i.test(text);
      const not_abstract = !/abstractly|generally|overall feel/i.test(text);
      const mentions_palette = /palette|color|sunset|amber/i.test(text);
      return { updates_hero, has_probe, construction_grounded, not_abstract, mentions_palette };
    },
  },
  {
    name: 'Orchestrator: Compaction',
    role: 'orchestrator',
    prompt: `You are the Compactor for The Eye Loop's Anima tree.

CURRENT ANIMA:
${ANIMA_YAML}

RAW EVIDENCE SINCE LAST COMPACTION:
${EVIDENCE_YAML}

TASK: Rewrite the Anima YAML by applying these operations:

MERGE: If multiple pieces of evidence point the same direction, collapse them.
PRUNE: If a dimension is resolved (>0.9), remove evidence list.
PROMOTE CONTRADICTION: If evidence is split, move axis back to exploring with narrower hypotheses.
BRANCH ISOLATION: Evidence from one branch must NOT influence siblings.

TOKEN BUDGET: Output Anima YAML must be under 300 tokens.
Preserve anti-patterns — they are hard constraints.

OUTPUT:
1. Rewritten Anima YAML
2. Probe briefs for any promoted contradictions (0 or more)
3. List of pruned dimensions (for logging)`,
    maxTokens: 600,
    judge: (text) => {
      const has_yaml = /resolved:|exploring:|intent:/i.test(text);
      const updates_palette = /palette/i.test(text) && /sunset|warm/i.test(text);
      const preserves_anti = /anti.?pattern/i.test(text);
      const updates_distribution = /distribution|confidence/i.test(text);
      const concise = text.length < 2500;
      return { has_yaml, updates_palette, preserves_anti, updates_distribution, concise };
    },
  },
];

// ── Models to test ────────────────────────────────────────────────────

const TEXT_MODELS = [
  { id: 'gemini-3.1-pro-preview', label: '3.1 Pro' },
  { id: 'gemini-3.1-flash-lite-preview', label: '3.1 Flash Lite' },
  { id: 'gemini-2.5-flash', label: '2.5 Flash' },
  { id: 'gemini-2.5-pro', label: '2.5 Pro' },
];

const IMAGE_MODELS = [
  { id: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2' },
  { id: 'gemini-2.5-flash-image', label: 'Nano Banana OG' },
  { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro' },
];

// ── Run benchmarks ────────────────────────────────────────────────────

const results = [];

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║           MODEL BENCHMARK — The Eye Loop               ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// Text model benchmarks
for (const bench of benchmarks) {
  console.log(`\n${'━'.repeat(58)}`);
  console.log(`  ${bench.name}`);
  console.log(`${'━'.repeat(58)}`);

  for (const model of TEXT_MODELS) {
    try {
      const start = Date.now();
      const result = await generateText({
        model: google(model.id),
        prompt: bench.prompt,
        maxTokens: bench.maxTokens,
      });
      const elapsed = Date.now() - start;
      const scores = bench.judge(result.text);
      const passed = Object.values(scores).filter(Boolean).length;
      const total = Object.values(scores).length;
      const pct = Math.round((passed / total) * 100);

      results.push({
        bench: bench.name,
        model: model.label,
        latency: elapsed,
        tokens: result.usage?.totalTokens ?? 0,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        score: `${passed}/${total}`,
        pct,
        scores,
      });

      const bar = pct === 100 ? '██████' : pct >= 80 ? '█████░' : pct >= 60 ? '████░░' : '███░░░';
      console.log(`  ${model.label.padEnd(16)} ${bar} ${pct}%  ${elapsed}ms  ${result.usage?.totalTokens}tok`);

      const failures = Object.entries(scores).filter(([, v]) => !v).map(([k]) => k);
      if (failures.length) console.log(`  ${''.padEnd(16)} ✗ ${failures.join(', ')}`);
    } catch (err) {
      console.log(`  ${model.label.padEnd(16)} ERROR: ${err.message?.slice(0, 80)}`);
      results.push({ bench: bench.name, model: model.label, error: err.message?.slice(0, 80) });
    }
  }
}

// Image model benchmark
console.log(`\n${'━'.repeat(58)}`);
console.log(`  Image Generation: Moodboard Quality`);
console.log(`${'━'.repeat(58)}`);

const imgPrompt = `Generate a moodboard for a personal finance app.
Style: warm-organic, sparse, rounded shapes.
Palette: sunset-warm — amber gradients, soft peach, cream.
Must include: example UI card, color swatches, typography sample.
Must NOT include: corporate blue, dense grids, sharp rectangles.`;

for (const model of IMAGE_MODELS) {
  try {
    const start = Date.now();
    const result = await generateText({
      model: google(model.id),
      prompt: imgPrompt,
      providerOptions: {
        google: { responseModalities: ['TEXT', 'IMAGE'] },
      },
      maxTokens: 200,
    });
    const elapsed = Date.now() - start;
    const hasFile = (result.files?.length ?? 0) > 0;
    const fileSize = hasFile ? Buffer.from(result.files[0].base64, 'base64').length : 0;

    if (hasFile) {
      const buf = Buffer.from(result.files[0].base64, 'base64');
      writeFileSync(`/tmp/bench-${model.id}.png`, buf);
    }

    results.push({
      bench: 'Image Generation',
      model: model.label,
      latency: elapsed,
      tokens: result.usage?.totalTokens ?? 0,
      hasImage: hasFile,
      fileSize,
      mediaType: hasFile ? result.files[0].mediaType : 'none',
    });

    console.log(`  ${model.label.padEnd(18)} ${hasFile ? '██████' : '░░░░░░'} ${elapsed}ms  ${Math.round(fileSize/1024)}KB  ${result.files?.[0]?.mediaType ?? 'no image'}`);
  } catch (err) {
    console.log(`  ${model.label.padEnd(18)} ERROR: ${err.message?.slice(0, 80)}`);
    results.push({ bench: 'Image Generation', model: model.label, error: err.message?.slice(0, 80) });
  }
}

// ── Summary table ─────────────────────────────────────────────────────

console.log(`\n\n${'═'.repeat(58)}`);
console.log('  SUMMARY');
console.log(`${'═'.repeat(58)}\n`);

// Group by benchmark
const byBench = {};
for (const r of results) {
  if (!byBench[r.bench]) byBench[r.bench] = [];
  byBench[r.bench].push(r);
}

for (const [bench, entries] of Object.entries(byBench)) {
  console.log(`  ${bench}:`);
  // Sort by score then latency
  entries.sort((a, b) => {
    if (a.error) return 1;
    if (b.error) return -1;
    if (a.pct !== undefined && b.pct !== undefined) {
      if (b.pct !== a.pct) return b.pct - a.pct;
    }
    return a.latency - b.latency;
  });
  for (const e of entries) {
    if (e.error) {
      console.log(`    ${e.model.padEnd(18)} ERROR`);
    } else if (e.pct !== undefined) {
      console.log(`    ${e.model.padEnd(18)} ${String(e.pct).padStart(3)}%  ${String(e.latency).padStart(6)}ms  ${String(e.tokens).padStart(5)}tok`);
    } else {
      console.log(`    ${e.model.padEnd(18)} ${String(e.latency).padStart(6)}ms  ${e.hasImage ? 'OK' : 'FAIL'}  ${Math.round((e.fileSize||0)/1024)}KB`);
    }
  }
  console.log('');
}

// ── Recommendation ────────────────────────────────────────────────────

console.log(`${'═'.repeat(58)}`);
console.log('  RECOMMENDATIONS');
console.log(`${'═'.repeat(58)}\n`);

// Find best per role
const roles = {
  'Scout Words': results.filter(r => r.bench === 'Scout: Word Facade' && !r.error),
  'Scout Images (prompt)': results.filter(r => r.bench === 'Scout: Image SCHEMA Prompt' && !r.error),
  'Scout HTML': results.filter(r => r.bench === 'Scout: HTML Mockup' && !r.error),
  'Builder': results.filter(r => r.bench === 'Builder: Probe Brief' && !r.error),
  'Compaction': results.filter(r => r.bench === 'Orchestrator: Compaction' && !r.error),
  'Image Gen': results.filter(r => r.bench === 'Image Generation' && !r.error),
};

for (const [role, entries] of Object.entries(roles)) {
  if (!entries.length) { console.log(`  ${role}: no data`); continue; }
  // Score quality first, then latency
  entries.sort((a, b) => {
    if (a.pct !== undefined && b.pct !== undefined) {
      if (b.pct !== a.pct) return b.pct - a.pct;
    }
    return a.latency - b.latency;
  });
  const best = entries[0];
  const tag = best.pct !== undefined ? `${best.pct}% ${best.latency}ms` : `${best.latency}ms`;
  console.log(`  ${role.padEnd(22)} → ${best.model} (${tag})`);
}

console.log('');

// Save raw results
writeFileSync('/tmp/bench-results.json', JSON.stringify(results, null, 2));
console.log('Raw results saved to /tmp/bench-results.json');
