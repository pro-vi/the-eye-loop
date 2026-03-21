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
const RUNS = 3;
const INTENT = "personal finance app that doesn't feel like a spreadsheet";

// ── Simulated evidence trajectory ─────────────────────────────────────

const EVIDENCE_ROUND_1 = [
  {
    content: 'Companion',
    hypothesis: 'Does the user want a tool that feels like a helper or a dashboard?',
    decision: 'accept',
    latency_signal: 'fast',
  },
  {
    content: 'Precision',
    hypothesis: 'Does the user want clinical exactness or something looser?',
    decision: 'reject',
    latency_signal: 'fast',
  },
  {
    content: 'Ledger',
    hypothesis: 'Does the user want traditional accounting aesthetics?',
    decision: 'reject',
    latency_signal: 'slow',
  },
];

const EVIDENCE_ROUND_2 = [
  ...EVIDENCE_ROUND_1,
  {
    content: 'Warm-toned card interface with conversational prompts and rounded shapes',
    hypothesis: 'Does the user prefer organic warmth over structured grids?',
    decision: 'accept',
    latency_signal: 'fast',
  },
  {
    content: 'Dense multi-column spreadsheet with monospaced typography',
    hypothesis: 'Does the user want data-dense overview style?',
    decision: 'reject',
    latency_signal: 'fast',
  },
  {
    content: 'Minimalist single-number display showing only net worth',
    hypothesis: 'Is extreme minimalism preferred over moderate detail?',
    decision: 'reject',
    latency_signal: 'slow',
  },
  {
    content: 'Soft illustrated icons with hand-drawn quality, serif typography',
    hypothesis: 'Does the user prefer craft/artisanal visual language?',
    decision: 'accept',
    latency_signal: 'slow',
  },
  {
    content: 'Dark mode dashboard with neon accent charts and glassmorphism',
    hypothesis: 'Does the user want tech-forward visual language?',
    decision: 'reject',
    latency_signal: 'fast',
  },
];

const EVIDENCE_ROUND_3 = [
  ...EVIDENCE_ROUND_2,
  {
    content: 'Card-based spending summary with 3 categories, warm cream background, friendly serif headings, progress ring for monthly budget',
    hypothesis: 'Does the user want a guided narrative layout with focused key metrics?',
    decision: 'accept',
    latency_signal: 'fast',
  },
  {
    content: 'Timeline-based transaction history with category color-coding and monthly comparison bars',
    hypothesis: 'Does the user want chronological data presentation?',
    decision: 'accept',
    latency_signal: 'slow',
  },
  {
    content: 'Full-screen savings goal visualization with animated growth chart and motivational milestones',
    hypothesis: 'Does the user want gamified goal tracking?',
    decision: 'reject',
    latency_signal: 'slow',
  },
  {
    content: 'Conversational interface with chat bubbles showing spending insights and suggested actions',
    hypothesis: 'Does the user want a chat-like interaction model for finance?',
    decision: 'accept',
    latency_signal: 'fast',
  },
  {
    content: 'Tabbed dashboard with separate views for accounts, budget, goals, and reports',
    hypothesis: 'Does the user want traditional app navigation with segmented views?',
    decision: 'reject',
    latency_signal: 'fast',
  },
];

function serializeEvidence(evidence) {
  return evidence.map((e, i) =>
    `${i + 1}. [${e.decision.toUpperCase()}${e.latency_signal === 'slow' ? ' (hesitant)' : ''}] "${e.content}"\n   Hypothesis: ${e.hypothesis}`
  ).join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════════
//  H1: Scout Next-Probe from Raw Evidence
// ═══════════════════════════════════════════════════════════════════════

const h1Schema = z.object({
  probe_content: z.string(),
  stage_suggestion: z.enum(['word', 'image_description', 'mockup_description']),
  hypothesis: z.string(),
  if_accepted: z.string(),
  if_rejected: z.string(),
  targets_gap: z.string(),
  avoids_patterns: z.array(z.string()),
});

const H1_PROMPT = `You are a taste scout — your job is to generate the next visual probe that will be most informative about this user's preferences.

The user said they want to build: "${INTENT}"

Here is everything we know from their choices so far:

EVIDENCE HISTORY (accept = they liked it, reject = they didn't, hesitant = they took a long time to decide):

{EVIDENCE}

YOUR TASK:
Generate the next probe — the single thing to show the user that would teach us the MOST about what they actually want.

RULES:
- Do NOT repeat patterns the user already rejected
- Do NOT re-confirm things we already know (they clearly prefer warmth over clinical precision — stop testing that)
- Target the GAPS — what aspects of their taste are we still uncertain about?
- A probe the user would HESITATE on is more informative than one they'd instantly accept or reject
- Include a hypothesis: what would accept vs reject tell us that we don't already know?

Think like Akinator — each question should maximally partition the remaining possibility space.`;

function judgeH1(output, evidence) {
  const rejectedKeywords = ['precision', 'spreadsheet', 'dense', 'monospaced', 'neon', 'dark mode', 'glass', 'tabbed dashboard', 'ledger'];
  const acceptedKeywords = ['companion', 'warm', 'card', 'conversational', 'serif', 'friendly'];
  const probeLC = output.probe_content.toLowerCase();

  const avoidsRejected = !rejectedKeywords.some(kw => probeLC.includes(kw));
  const isNotRedundant = !acceptedKeywords.every(kw => probeLC.includes(kw));
  const hasRealHypothesis = output.hypothesis.length > 20
    && output.if_accepted.length > 15
    && output.if_rejected.length > 15
    && output.if_accepted !== output.if_rejected;
  const hasGap = output.targets_gap.length > 10;
  const acknowledgesAntiPatterns = output.avoids_patterns.length >= 1;

  const allPriorContent = evidence.map(e => e.content.toLowerCase()).join(' ');
  const probeWords = probeLC.split(/\s+/);
  const novelWords = probeWords.filter(w => w.length > 4 && !allPriorContent.includes(w));
  const hasNovelty = novelWords.length >= 1;

  const checks = { avoidsRejected, isNotRedundant, hasRealHypothesis, hasGap, acknowledgesAntiPatterns, hasNovelty };
  return { ...checks, passed: Object.values(checks).filter(Boolean).length, total: 6 };
}

async function testH1() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  H1: Scout Next-Probe from Raw Evidence                ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const rounds = [
    { label: 'Round 1 (3 swipes)', evidence: EVIDENCE_ROUND_1 },
    { label: 'Round 2 (8 swipes)', evidence: EVIDENCE_ROUND_2 },
    { label: 'Round 3 (13 swipes)', evidence: EVIDENCE_ROUND_3 },
  ];

  const results = [];
  for (const round of rounds) {
    console.log(`\n━━━ ${round.label} ━━━`);
    for (let i = 0; i < RUNS; i++) {
      try {
        const start = Date.now();
        const result = await generateText({
          model: generator,
          output: Output.object({ schema: h1Schema }),
          prompt: H1_PROMPT.replace('{EVIDENCE}', serializeEvidence(round.evidence)),
        });
        const elapsed = Date.now() - start;
        const o = result.output;
        const j = judgeH1(o, round.evidence);
        results.push({ round: round.label, run: i, elapsed, output: o, judgment: j });

        const failed = Object.entries(j).filter(([k, v]) => v === false).map(([k]) => k);
        console.log(`  Run ${i + 1}: ${j.passed}/${j.total} | gap="${o.targets_gap.slice(0, 60)}" | ${elapsed}ms`);
        console.log(`    probe: "${o.probe_content.slice(0, 80)}"`);
        console.log(`    hypothesis: "${o.hypothesis.slice(0, 80)}"`);
        if (failed.length) console.log(`    FAILED: ${failed.join(', ')}`);
      } catch (err) {
        console.log(`  Run ${i + 1}: ERROR — ${err.message?.slice(0, 150)}`);
        results.push({ round: round.label, run: i, error: err.message?.slice(0, 150) });
      }
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  H2: Emergent Concreteness Progression
// ═══════════════════════════════════════════════════════════════════════

const h2Schema = z.object({
  probe_content: z.string(),
  chosen_format: z.enum(['word', 'image', 'mockup']),
  format_reasoning: z.string(),
  hypothesis: z.string(),
  if_accepted: z.string(),
  if_rejected: z.string(),
});

const H2_PROMPT = `You are a taste scout — your job is to generate the next visual probe that will be most informative about this user's preferences.

The user said they want to build: "${INTENT}"

EVIDENCE HISTORY:

{EVIDENCE}

YOUR TASK:
Generate the next probe. Choose the format that best matches how much you know:
- If evidence is sparse and you're still mapping broad territory, use a single evocative WORD or short phrase
- If you have moderate evidence and can form visual hypotheses, describe an IMAGE or moodboard
- If you have strong evidence and can envision specific UI decisions, describe a concrete MOCKUP with layout details

Do NOT artificially escalate — match your confidence to the evidence depth.`;

function judgeH2(output, roundIndex) {
  const expectedByRound = [
    ['word'],
    ['word', 'image'],
    ['image', 'mockup'],
  ];
  const matchesExpected = expectedByRound[roundIndex].includes(output.chosen_format);
  const contentLength = output.probe_content.length;
  const contentMatchesFormat =
    (output.chosen_format === 'word' && contentLength < 50) ||
    (output.chosen_format === 'image' && contentLength >= 20 && contentLength < 500) ||
    (output.chosen_format === 'mockup' && contentLength >= 50);
  const reasoningMentionsEvidence = /evidence|know|seen|accepted|rejected|swipe|clear|uncertain|enough|sparse|strong|moderate/i.test(output.format_reasoning);

  const checks = { matchesExpected, contentMatchesFormat, reasoningMentionsEvidence };
  return { ...checks, chosenFormat: output.chosen_format, passed: Object.values(checks).filter(Boolean).length, total: 3 };
}

async function testH2() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  H2: Emergent Concreteness Progression                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const rounds = [
    { label: 'Round 1 (3 swipes — expect word)', evidence: EVIDENCE_ROUND_1 },
    { label: 'Round 2 (8 swipes — expect image)', evidence: EVIDENCE_ROUND_2 },
    { label: 'Round 3 (13 swipes — expect mockup)', evidence: EVIDENCE_ROUND_3 },
  ];

  const results = [];
  for (let ri = 0; ri < rounds.length; ri++) {
    const round = rounds[ri];
    console.log(`\n━━━ ${round.label} ━━━`);
    for (let i = 0; i < RUNS; i++) {
      try {
        const start = Date.now();
        const result = await generateText({
          model: generator,
          output: Output.object({ schema: h2Schema }),
          prompt: H2_PROMPT.replace('{EVIDENCE}', serializeEvidence(round.evidence)),
        });
        const elapsed = Date.now() - start;
        const o = result.output;
        const j = judgeH2(o, ri);
        results.push({ round: round.label, roundIndex: ri, run: i, elapsed, output: o, judgment: j });

        const tag = j.matchesExpected ? 'MATCH' : 'MISMATCH';
        console.log(`  Run ${i + 1}: ${tag} format=${o.chosen_format} | ${j.passed}/${j.total} | ${elapsed}ms`);
        console.log(`    reasoning: "${o.format_reasoning.slice(0, 100)}"`);
        console.log(`    probe: "${o.probe_content.slice(0, 80)}"`);
      } catch (err) {
        console.log(`  Run ${i + 1}: ERROR — ${err.message?.slice(0, 150)}`);
        results.push({ round: round.label, roundIndex: ri, run: i, error: err.message?.slice(0, 150) });
      }
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  H3: Builder Extraction from Raw Evidence
// ═══════════════════════════════════════════════════════════════════════

const h3Schema = z.object({
  can_build_now: z.array(z.object({
    component: z.string(),
    design_decisions: z.string(),
    grounded_in: z.string(),
  })),
  anti_patterns: z.array(z.string()),
  blocking_questions: z.array(z.object({
    component: z.string(),
    question: z.string(),
    options: z.string(),
  })),
  probe_brief: z.object({
    target_component: z.string(),
    question: z.string(),
    context: z.string(),
    option_a: z.string(),
    option_b: z.string(),
  }),
});

const H3_PROMPT = `You are the builder agent. You assemble a prototype from what users have shown through their choices — not from what they said.

The user said they want to build: "${INTENT}"

Here is the complete evidence from their swipe session:

{EVIDENCE}

YOUR TASK:
1. Identify what you CAN build now — what design decisions are resolved by the evidence?
2. Identify what BLOCKS construction — what specific question, answered, would let you build the next component?
3. Produce a construction-grounded probe brief — not "color axis unresolved" but "Building the transaction list — need to know: grouped by category with totals, or chronological stream with tags?"

RULES:
- Ground everything in the evidence. Do not invent preferences the user hasn't shown.
- Anti-patterns (rejected things) are HARD CONSTRAINTS — never violate them.
- Reference specific accepted/rejected items as justification.
- The probe brief must be about a SPECIFIC UI COMPONENT you're trying to build, not an abstract taste dimension.`;

function judgeH3(output, evidence) {
  const hasConcreteComponents = output.can_build_now.length >= 2
    && output.can_build_now.every(c => c.component.length > 3);

  const isGrounded = output.can_build_now.some(c =>
    /accepted|rejected|chose|liked|evidence|swipe|companion|warm|card|conversational/i.test(c.grounded_in)
  );

  const rejectedKeywords = ['precision', 'spreadsheet', 'dense', 'monospaced', 'neon', 'dark mode', 'glass', 'tabbed', 'ledger', 'minimal single-number'];
  const hasAntiPatterns = output.anti_patterns.length >= 2
    && output.anti_patterns.some(ap =>
      rejectedKeywords.some(kw => ap.toLowerCase().includes(kw))
    );

  const hasSpecificBlocker = output.blocking_questions.length >= 1
    && output.blocking_questions.every(bq =>
      /card|list|header|section|view|component|chart|nav|tab|panel|screen|layout|page|feed|transaction|budget|goal|account/i.test(bq.component)
    );

  const brief = output.probe_brief;
  const briefIsGrounded = brief.target_component.length > 3
    && brief.question.length > 20
    && brief.option_a.length > 5
    && brief.option_b.length > 5
    && brief.option_a !== brief.option_b;

  const allText = JSON.stringify(output).toLowerCase();
  const avoidsAxisLanguage = !/\baxis\b|\bdimension\b|\bconfidence score\b/.test(allText);

  const checks = { hasConcreteComponents, isGrounded, hasAntiPatterns, hasSpecificBlocker, briefIsGrounded, avoidsAxisLanguage };
  return { ...checks, passed: Object.values(checks).filter(Boolean).length, total: 6 };
}

async function testH3() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  H3: Builder Extraction from Raw Evidence              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const results = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const start = Date.now();
      const result = await generateText({
        model: generator,
        temperature: 0,
        output: Output.object({ schema: h3Schema }),
        prompt: H3_PROMPT.replace('{EVIDENCE}', serializeEvidence(EVIDENCE_ROUND_3)),
      });
      const elapsed = Date.now() - start;
      const o = result.output;
      const j = judgeH3(o, EVIDENCE_ROUND_3);
      results.push({ run: i, elapsed, output: o, judgment: j });

      const failed = Object.entries(j).filter(([k, v]) => v === false && k !== 'passed' && k !== 'total').map(([k]) => k);
      console.log(`  Run ${i + 1}: ${j.passed}/${j.total} | ${elapsed}ms`);
      console.log(`    can_build: ${o.can_build_now.map(c => c.component).join(', ')}`);
      console.log(`    anti_patterns: ${o.anti_patterns.slice(0, 3).join('; ')}`);
      console.log(`    probe: "${o.probe_brief.question.slice(0, 80)}"`);
      console.log(`      A: ${o.probe_brief.option_a.slice(0, 60)}`);
      console.log(`      B: ${o.probe_brief.option_b.slice(0, 60)}`);
      if (failed.length) console.log(`    FAILED: ${failed.join(', ')}`);
    } catch (err) {
      console.log(`  Run ${i + 1}: ERROR — ${err.message?.slice(0, 150)}`);
      results.push({ run: i, error: err.message?.slice(0, 150) });
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  Report
// ═══════════════════════════════════════════════════════════════════════

function writeReport(h1, h2, h3) {
  const h1v = h1.filter(r => !r.error);
  const h2v = h2.filter(r => !r.error);
  const h3v = h3.filter(r => !r.error);

  const h1Avg = h1v.reduce((s, r) => s + r.judgment.passed, 0) / h1v.length;
  const h2Avg = h2v.reduce((s, r) => s + r.judgment.passed, 0) / h2v.length;
  const h3Avg = h3v.reduce((s, r) => s + r.judgment.passed, 0) / h3v.length;

  const h2ByRound = [0, 1, 2].map(ri => {
    const rr = h2v.filter(r => r.roundIndex === ri);
    return {
      formats: rr.map(r => r.output.chosen_format),
      matchRate: rr.filter(r => r.judgment.matchesExpected).length / rr.length,
    };
  });

  const report = `# Akinator Validation — Raw Evidence Scout Pattern

Model: \`gemini-3.1-flash-lite-preview\`
Date: ${new Date().toISOString().slice(0, 10)}
Runs per test: ${RUNS}
Intent: "${INTENT}"

## Summary

| Hypothesis | Avg Score | Verdict |
|-----------|-----------|---------|
| H1: Scout next-probe from raw evidence | ${h1Avg.toFixed(1)}/6 | ${h1Avg >= 4 ? '**PASS**' : '**NEEDS WORK**'} |
| H2: Emergent concreteness progression | ${h2Avg.toFixed(1)}/3 | ${h2Avg >= 2 ? '**PASS**' : '**NEEDS WORK**'} |
| H3: Builder extraction from raw evidence | ${h3Avg.toFixed(1)}/6 | ${h3Avg >= 4 ? '**PASS**' : '**NEEDS WORK**'} |

## H1: Scout Next-Probe from Raw Evidence

${h1v.map(r => `### ${r.round} — Run ${r.run + 1} (${r.judgment.passed}/${r.judgment.total}, ${r.elapsed}ms)
- **Probe:** "${r.output.probe_content}"
- **Hypothesis:** "${r.output.hypothesis}"
- **Gap:** "${r.output.targets_gap}"
- **If accepted:** "${r.output.if_accepted}"
- **If rejected:** "${r.output.if_rejected}"
- **Avoids:** ${r.output.avoids_patterns.join(', ')}
${Object.entries(r.judgment).filter(([k]) => !['passed', 'total'].includes(k)).map(([k, v]) => `- ${v ? 'PASS' : 'FAIL'}: ${k}`).join('\n')}`).join('\n\n')}

## H2: Emergent Concreteness Progression

### Format Progression

| Round | Expected | Actual | Match Rate |
|-------|----------|--------|------------|
| 1 (3 swipes) | word | ${h2ByRound[0].formats.join(', ')} | ${(h2ByRound[0].matchRate * 100).toFixed(0)}% |
| 2 (8 swipes) | word/image | ${h2ByRound[1].formats.join(', ')} | ${(h2ByRound[1].matchRate * 100).toFixed(0)}% |
| 3 (13 swipes) | image/mockup | ${h2ByRound[2].formats.join(', ')} | ${(h2ByRound[2].matchRate * 100).toFixed(0)}% |

${h2v.map(r => `### ${r.round} — Run ${r.run + 1}
- **Format:** ${r.output.chosen_format}
- **Reasoning:** "${r.output.format_reasoning}"
- **Probe:** "${r.output.probe_content.slice(0, 120)}"
${Object.entries(r.judgment).filter(([k]) => !['passed', 'total', 'chosenFormat'].includes(k)).map(([k, v]) => `- ${v ? 'PASS' : 'FAIL'}: ${k}`).join('\n')}`).join('\n\n')}

## H3: Builder Extraction from Raw Evidence

${h3v.map(r => `### Run ${r.run + 1} (${r.judgment.passed}/${r.judgment.total}, ${r.elapsed}ms)
- **Can build:** ${r.output.can_build_now.map(c => `${c.component} (${c.design_decisions.slice(0, 60)})`).join('; ')}
- **Anti-patterns:** ${r.output.anti_patterns.join('; ')}
- **Blocking:** ${r.output.blocking_questions.map(bq => `${bq.component}: ${bq.question.slice(0, 80)}`).join('; ')}
- **Probe brief:** "${r.output.probe_brief.question}"
  - Component: ${r.output.probe_brief.target_component}
  - Option A: ${r.output.probe_brief.option_a}
  - Option B: ${r.output.probe_brief.option_b}
${Object.entries(r.judgment).filter(([k]) => !['passed', 'total'].includes(k)).map(([k, v]) => `- ${v ? 'PASS' : 'FAIL'}: ${k}`).join('\n')}`).join('\n\n')}

## Implications

${h1Avg >= 4 ? '**H1 PASS:** Scouts can work with raw evidence — no structured Anima YAML needed. The evidence list IS the Anima.' : '**H1 FAIL:** Raw evidence alone is insufficient. Scouts need some structured summary.'}

${h2Avg >= 2 ? '**H2 PASS:** Concreteness emerges from information density. Stage transitions can be LLM-driven.' : '**H2 FAIL:** Model does not naturally escalate concreteness. Keep oracle-driven swipe-count stage gates.'}

${h3Avg >= 4 ? '**H3 PASS:** Builder can extract construction decisions from raw evidence. Same evidence format works for scouts and builder.' : '**H3 FAIL:** Builder needs more structure. Consider keeping Anima YAML for builder while simplifying scout prompt.'}

${h1Avg >= 4 && h2Avg >= 2 && h3Avg >= 4
  ? '### GO: Rewrite scout/builder prompts to use raw evidence. Drop axis seeding. Stage transitions become emergent with oracle as fallback guardrail.'
  : '### PARTIAL: See individual results for failure modes and prompt tuning opportunities.'}
`;

  mkdirSync('scripts/findings', { recursive: true });
  writeFileSync('scripts/findings/akinator-validation.md', report);
}

// ═══════════════════════════════════════════════════════════════════════
//  Run
// ═══════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  AKINATOR VALIDATION — Raw Evidence Scout Pattern       ║');
console.log('╚══════════════════════════════════════════════════════════╝');

const h1 = await testH1();
const h2 = await testH2();
const h3 = await testH3();

writeReport(h1, h2, h3);

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Report: scripts/findings/akinator-validation.md');
console.log('═══════════════════════════════════════════════════════════\n');
