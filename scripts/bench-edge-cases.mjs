import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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
const renderer = google('gemini-3.1-flash-image-preview');
const INTENT = "personal finance app that doesn't feel like a spreadsheet";

const probeSchema = z.object({
  probe_content: z.string(),
  format: z.enum(['word', 'image', 'mockup']),
  hypothesis: z.string(),
  if_accepted: z.string(),
  if_rejected: z.string(),
  targets_gap: z.string(),
});

const builderHtmlSchema = z.object({
  html: z.string(),
  components_used: z.array(z.string()),
  anti_patterns_respected: z.array(z.string()),
  next_question: z.string(),
});

function serializeEvidence(evidence) {
  if (!evidence.length) return '(no evidence yet)';
  return evidence.map((e, i) =>
    `${i + 1}. [${e.decision.toUpperCase()}${e.latency === 'slow' ? ' (hesitant)' : ''}] "${e.content}"\n   Hypothesis: ${e.hypothesis}`
  ).join('\n\n');
}

function scoutPrompt(evidence, synthesis, recentHyps, formatInstr) {
  let p = `You are a taste scout — generate the next probe most informative about this user's preferences.

The user said they want to build: "${INTENT}"

EVIDENCE HISTORY:

${serializeEvidence(evidence)}`;

  if (synthesis) p += `\n\nORACLE SYNTHESIS:\n${synthesis}`;
  if (recentHyps) p += `\n\nDIVERSITY: Recent probes tested: "${recentHyps}". Find a DIFFERENT gap.`;
  p += `\n\n${formatInstr}

RULES:
- Do NOT repeat rejected patterns
- Do NOT re-confirm known preferences
- Target GAPS — what's still uncertain?
- Think like Akinator — maximally partition remaining space`;
  return p;
}

// ═══════════════════════════════════════════════════════════════════════
//  TEST 1: Edge Case Users
// ═══════════════════════════════════════════════════════════════════════

async function testEdgeCases() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Edge Case Users                                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const cases = [
    {
      name: 'Reject-everything user (6 straight rejects)',
      evidence: [
        { content: 'Companion', hypothesis: 'Helper vs dashboard?', decision: 'reject', latency: 'fast' },
        { content: 'Precision', hypothesis: 'Clinical exactness?', decision: 'reject', latency: 'fast' },
        { content: 'Playful abundance', hypothesis: 'Whimsical vs serious?', decision: 'reject', latency: 'fast' },
        { content: 'Dark elegant dashboard with gold accents', hypothesis: 'Premium luxury aesthetic?', decision: 'reject', latency: 'fast' },
        { content: 'Minimalist single number', hypothesis: 'Extreme reduction?', decision: 'reject', latency: 'slow' },
        { content: 'Conversational chat interface', hypothesis: 'Chat-based interaction?', decision: 'reject', latency: 'slow' },
      ],
    },
    {
      name: 'Accept-everything user (6 straight accepts)',
      evidence: [
        { content: 'Companion', hypothesis: 'Helper vs dashboard?', decision: 'accept', latency: 'fast' },
        { content: 'Precision', hypothesis: 'Clinical exactness?', decision: 'accept', latency: 'fast' },
        { content: 'Organic warmth', hypothesis: 'Natural textures?', decision: 'accept', latency: 'fast' },
        { content: 'Dense data grid with sparklines', hypothesis: 'Data-heavy overview?', decision: 'accept', latency: 'fast' },
        { content: 'Minimalist single number', hypothesis: 'Extreme reduction?', decision: 'accept', latency: 'fast' },
        { content: 'Dark neon dashboard', hypothesis: 'Tech-forward aesthetic?', decision: 'accept', latency: 'fast' },
      ],
    },
    {
      name: 'Contradictory user (flip-flops on same dimension)',
      evidence: [
        { content: 'Warm organic tones', hypothesis: 'Natural warmth?', decision: 'accept', latency: 'fast' },
        { content: 'Cool clinical precision', hypothesis: 'Cold exactness?', decision: 'accept', latency: 'slow' },
        { content: 'Handcrafted serif typography', hypothesis: 'Artisanal feel?', decision: 'accept', latency: 'fast' },
        { content: 'Monospaced data grid', hypothesis: 'Technical utility?', decision: 'accept', latency: 'fast' },
        { content: 'Warm sunset card layout', hypothesis: 'Warm organic again?', decision: 'reject', latency: 'slow' },
        { content: 'Minimal Swiss grid', hypothesis: 'Structured modernism?', decision: 'reject', latency: 'slow' },
      ],
    },
    {
      name: 'Slow-on-everything user (all hesitant)',
      evidence: [
        { content: 'Companion', hypothesis: 'Helper feel?', decision: 'accept', latency: 'slow' },
        { content: 'Dashboard', hypothesis: 'Overview control?', decision: 'reject', latency: 'slow' },
        { content: 'Playful', hypothesis: 'Whimsical tone?', decision: 'accept', latency: 'slow' },
        { content: 'Structured', hypothesis: 'Formal organization?', decision: 'reject', latency: 'slow' },
        { content: 'Warm card with progress ring', hypothesis: 'Guided progress?', decision: 'accept', latency: 'slow' },
        { content: 'Timeline transaction list', hypothesis: 'Chronological data?', decision: 'reject', latency: 'slow' },
      ],
    },
  ];

  const results = [];

  for (const c of cases) {
    console.log(`\n━━━ ${c.name} ━━━`);
    try {
      const start = Date.now();
      const result = await generateText({
        model: generator,
        output: Output.object({ schema: probeSchema }),
        prompt: scoutPrompt(
          c.evidence, null, null,
          'FORMAT: You have 6 swipes. Describe an IMAGE or moodboard.'
        ),
      });
      const elapsed = Date.now() - start;
      const o = result.output;

      // Check: does the scout adapt to the pattern?
      const allRejects = c.evidence.every(e => e.decision === 'reject');
      const allAccepts = c.evidence.every(e => e.decision === 'accept');
      const contradictory = c.evidence.filter(e => e.decision === 'accept').length >= 2 &&
        c.evidence.filter(e => e.decision === 'reject').length >= 2;
      const allSlow = c.evidence.every(e => e.latency === 'slow');

      let adaptation = '';
      if (allRejects) {
        // Should try something totally different
        adaptation = o.targets_gap.length > 20 ? 'explores new territory' : 'stuck';
      } else if (allAccepts) {
        // Should probe for discrimination — user isn't discriminating
        const probesDiscrimination = /discriminat|distinguish|differ|contrast|boundary|split|partition/i.test(o.hypothesis + o.targets_gap);
        adaptation = probesDiscrimination ? 'probes for discrimination' : 'keeps adding';
      } else if (contradictory) {
        // Should acknowledge the contradiction
        const seesContradiction = /contradict|conflict|tension|inconsisten|flip|both|mixed/i.test(o.hypothesis + o.targets_gap);
        adaptation = seesContradiction ? 'identifies contradiction' : 'ignores contradiction';
      } else if (allSlow) {
        // Should note boundary proximity
        const seesHesitation = /hesita|uncertain|boundary|unsure|indeci|careful|slow/i.test(o.hypothesis + o.targets_gap);
        adaptation = seesHesitation ? 'reads hesitation' : 'ignores hesitation';
      }

      results.push({ name: c.name, elapsed, output: o, adaptation });

      console.log(`  probe: "${o.probe_content.slice(0, 80)}"`);
      console.log(`  hypothesis: "${o.hypothesis.slice(0, 80)}"`);
      console.log(`  gap: "${o.targets_gap.slice(0, 80)}"`);
      console.log(`  adaptation: ${adaptation} ${elapsed}ms`);
    } catch (err) {
      console.log(`  ERROR: ${err.message?.slice(0, 120)}`);
      results.push({ name: c.name, error: err.message?.slice(0, 120) });
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  TEST 2: Cross-Scout Diversity (3 parallel probes)
// ═══════════════════════════════════════════════════════════════════════

async function testCrossScout() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Cross-Scout Diversity (3 parallel probes)             ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const evidence = [
    { content: 'Companion', hypothesis: 'Helper vs dashboard?', decision: 'accept', latency: 'fast' },
    { content: 'Precision', hypothesis: 'Clinical exactness?', decision: 'reject', latency: 'fast' },
    { content: 'Ledger', hypothesis: 'Traditional accounting?', decision: 'reject', latency: 'slow' },
    { content: 'Warm card interface with rounded shapes', hypothesis: 'Organic warmth?', decision: 'accept', latency: 'fast' },
    { content: 'Dense spreadsheet with monospace type', hypothesis: 'Data density?', decision: 'reject', latency: 'fast' },
  ];

  const synthesis = `Known: Warm/organic preferred, clinical/dense rejected
Unknown: Interaction model (chat vs cards vs timeline), typography, navigation pattern
Contradictions: (none yet)
Scout guidance: Probe interaction model and typography — warmth is settled.`;

  const scoutNames = ['Scout Alpha', 'Scout Beta', 'Scout Gamma'];
  const rounds = [
    { label: 'Round 1: words stage (evidence 5)', floor: 'FORMAT: You have 5 swipes. Use a single evocative WORD or short phrase.' },
    { label: 'Round 2: image stage (evidence 5)', floor: 'FORMAT: You have 5 swipes. Describe an IMAGE or moodboard.' },
  ];

  const results = [];

  for (const round of rounds) {
    console.log(`\n━━━ ${round.label} ━━━`);

    // Fire 3 scouts in parallel
    const start = Date.now();
    const probes = await Promise.all(
      scoutNames.map((name, i) =>
        generateText({
          model: generator,
          output: Output.object({ schema: probeSchema }),
          prompt: scoutPrompt(
            evidence, synthesis,
            i > 0 ? `(You are ${name} — other scouts are also generating probes. Be distinctive.)` : null,
            round.floor
          ),
        }).then(r => ({ name, output: r.output }))
          .catch(err => ({ name, error: err.message?.slice(0, 100) }))
      )
    );
    const elapsed = Date.now() - start;

    // Check diversity
    const validProbes = probes.filter(p => !p.error);
    const gaps = validProbes.map(p => p.output.targets_gap.toLowerCase());
    const contents = validProbes.map(p => p.output.probe_content.toLowerCase());

    // Pairwise similarity check
    let duplicates = 0;
    for (let i = 0; i < gaps.length; i++) {
      for (let j = i + 1; j < gaps.length; j++) {
        const wordsA = new Set(gaps[i].split(/\s+/).filter(w => w.length > 4));
        const wordsB = gaps[j].split(/\s+/).filter(w => w.length > 4);
        const overlap = wordsB.filter(w => wordsA.has(w)).length;
        if (wordsA.size > 0 && overlap / wordsA.size > 0.4) duplicates++;
      }
    }

    const diverse = duplicates === 0;

    results.push({ round: round.label, probes: validProbes, elapsed, duplicates, diverse });

    for (const p of probes) {
      if (p.error) {
        console.log(`  ${p.name}: ERROR — ${p.error}`);
      } else {
        console.log(`  ${p.name}: [${p.output.format}] "${p.output.probe_content.slice(0, 50)}" gap="${p.output.targets_gap.slice(0, 50)}"`);
      }
    }
    console.log(`  Diversity: ${diverse ? '✓' : `✗ (${duplicates} overlapping pairs)`} | ${elapsed}ms (parallel)`);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  TEST 3: Builder Producing Actual HTML
// ═══════════════════════════════════════════════════════════════════════

async function testBuilderHtml() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Builder Producing Actual HTML from Evidence           ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const evidence = [
    { content: 'Companion', hypothesis: 'Helper feel?', decision: 'accept', latency: 'fast' },
    { content: 'Precision', hypothesis: 'Clinical exactness?', decision: 'reject', latency: 'fast' },
    { content: 'Biophilic serenity', hypothesis: 'Calm nature-inspired?', decision: 'accept', latency: 'fast' },
    { content: 'Minimalist abstraction', hypothesis: 'Extreme reduction?', decision: 'reject', latency: 'fast' },
    { content: 'Warm card interface with conversational prompts', hypothesis: 'Organic warmth?', decision: 'accept', latency: 'fast' },
    { content: 'Dense spreadsheet with monospace type', hypothesis: 'Data density?', decision: 'reject', latency: 'fast' },
    { content: 'Soft illustrated icons with hand-drawn quality', hypothesis: 'Artisanal craft?', decision: 'accept', latency: 'slow' },
    { content: 'Dark neon dashboard with glassmorphism', hypothesis: 'Tech-forward?', decision: 'reject', latency: 'fast' },
    { content: 'Card-based spending summary, warm cream bg, serif headings, progress ring', hypothesis: 'Guided narrative layout?', decision: 'accept', latency: 'fast' },
    { content: 'Conversational chat interface for spending insights', hypothesis: 'Chat-like interaction?', decision: 'accept', latency: 'fast' },
  ];

  const synthesis = `Known: Warm/organic/companion feel, conversational interaction, card-based layout, serif + hand-drawn aesthetic, progress indicators welcome
Unknown: Navigation pattern, specific color palette values, transaction list format
Anti-patterns: Dense grids, monospace, dark mode, neon, glassmorphism, extreme minimalism, clinical precision
Guidance: Enough to build a first draft. Focus on the spending summary and conversational insight components.`;

  console.log('--- Generating HTML prototype from 10 swipes of evidence ---\n');

  try {
    const start = Date.now();
    const result = await generateText({
      model: generator,
      output: Output.object({ schema: builderHtmlSchema }),
      prompt: `You are the builder agent. Generate a WORKING HTML+CSS prototype from user evidence.

The user said they want to build: "${INTENT}"

EVIDENCE (10 swipes):

${serializeEvidence(evidence)}

ORACLE SYNTHESIS:
${synthesis}

YOUR TASK:
Generate a complete, working HTML+CSS mobile mockup (375x667 viewport, inline styles, no scripts).

This is the builder's DRAFT PROTOTYPE — assembled from what survived selection.

RULES:
- Every design decision must trace to accepted evidence
- ANTI-PATTERNS are hard constraints — NEVER use: dense grids, monospace, dark mode, neon, glassmorphism, extreme minimalism
- Use warm colors (#FFxxxx range), rounded corners (16px+), serif or hand-drawn typography
- Include: a spending summary card, a conversational insight, a progress indicator
- Mobile-first, 375px width
- The output html field should be complete, renderable HTML`,
      maxTokens: 3000,
    });
    const elapsed = Date.now() - start;
    const o = result.output;

    // Quality checks
    const hasHtml = /<div|<html/i.test(o.html);
    const hasInlineStyles = /style="/i.test(o.html);
    const warmColors = /#[fF][fF]|#[fF][eE]|cream|amber|peach|warm/i.test(o.html);
    const noBlue = !/#0{1,2}[0-6][0-6][cCfF][cCfF]|#[12][0-9a-fA-F]{2}[eEfF][0-9a-fA-F]|neon|glassmorphism/i.test(o.html);
    const hasRadius = /border-radius/i.test(o.html);
    const hasSerif = /serif|Georgia|Playfair|Lora/i.test(o.html);

    console.log(`  ${elapsed}ms | ${o.html.length} chars`);
    console.log(`  Components: ${o.components_used.join(', ')}`);
    console.log(`  Anti-patterns respected: ${o.anti_patterns_respected.join(', ')}`);
    console.log(`  Next question: "${o.next_question.slice(0, 80)}"`);
    console.log(`\n  Quality:`);
    console.log(`    Valid HTML: ${hasHtml ? '✓' : '✗'}`);
    console.log(`    Inline styles: ${hasInlineStyles ? '✓' : '✗'}`);
    console.log(`    Warm colors: ${warmColors ? '✓' : '✗'}`);
    console.log(`    No blue/neon: ${noBlue ? '✓' : '✗'}`);
    console.log(`    Rounded corners: ${hasRadius ? '✓' : '✗'}`);
    console.log(`    Serif typography: ${hasSerif ? '✓' : '✗'}`);

    // Save the HTML
    writeFileSync('/tmp/builder-draft.html', o.html);
    console.log(`\n  Saved to /tmp/builder-draft.html`);

    return { elapsed, output: o, checks: { hasHtml, hasInlineStyles, warmColors, noBlue, hasRadius, hasSerif } };
  } catch (err) {
    console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
    return { error: err.message?.slice(0, 200) };
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Run all 3 in sequence
// ═══════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  RESEARCH BENCH — Edge Cases + Cross-Scout + Builder    ║');
console.log('╚══════════════════════════════════════════════════════════╝');

const edge = await testEdgeCases();
const cross = await testCrossScout();
const builder = await testBuilderHtml();

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(58)}`);
console.log('  SUMMARY');
console.log(`${'═'.repeat(58)}\n`);

console.log('  Edge Cases:');
for (const r of edge) {
  if (r.error) { console.log(`    ${r.name}: ERROR`); continue; }
  console.log(`    ${r.name}: ${r.adaptation}`);
}

console.log('\n  Cross-Scout Diversity:');
for (const r of cross) {
  console.log(`    ${r.round}: ${r.diverse ? '✓ diverse' : `✗ ${r.duplicates} overlaps`}`);
}

console.log('\n  Builder HTML:');
if (builder.error) {
  console.log(`    ERROR`);
} else {
  const passed = Object.values(builder.checks).filter(Boolean).length;
  console.log(`    ${passed}/6 checks | ${builder.elapsed}ms | ${builder.output.html.length} chars`);
}

// ── Write report ─────────────────────────────────────────────────────

const report = `# Research Bench — Edge Cases + Cross-Scout + Builder HTML

Model: \`gemini-3.1-flash-lite-preview\`
Date: ${new Date().toISOString().slice(0, 10)}

## Edge Case Users

${edge.map(r => r.error ? `### ${r.name}\nERROR` : `### ${r.name}
- **Probe:** "${r.output.probe_content.slice(0, 100)}"
- **Hypothesis:** "${r.output.hypothesis.slice(0, 100)}"
- **Gap:** "${r.output.targets_gap.slice(0, 100)}"
- **Adaptation:** ${r.adaptation}`).join('\n\n')}

## Cross-Scout Diversity

${cross.map(r => `### ${r.round}
${r.probes.map(p => `- **${p.name}:** [${p.output.format}] "${p.output.probe_content.slice(0, 60)}" → gap: "${p.output.targets_gap.slice(0, 60)}"`).join('\n')}
- **Diverse:** ${r.diverse ? 'YES' : `NO (${r.duplicates} overlapping pairs)`}
- **Latency:** ${r.elapsed}ms (3 parallel calls)`).join('\n\n')}

## Builder HTML

${builder.error ? 'ERROR' : `- **Latency:** ${builder.elapsed}ms
- **HTML length:** ${builder.output.html.length} chars
- **Components:** ${builder.output.components_used.join(', ')}
- **Anti-patterns respected:** ${builder.output.anti_patterns_respected.join(', ')}
- **Next question:** ${builder.output.next_question}
- **Quality:** ${Object.entries(builder.checks).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join(' | ')}

### Rendered HTML saved to /tmp/builder-draft.html`}
`;

mkdirSync('scripts/findings', { recursive: true });
writeFileSync('scripts/findings/research-bench.md', report);
console.log(`\n  Report: scripts/findings/research-bench.md`);
