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
const INTENT = "personal finance app that doesn't feel like a spreadsheet";

// ── Hidden user taste (simulation only — never seen by scout/builder) ─

const USER_TASTE = `This user wants:
- Warm, companion-like feel (NOT clinical/dashboard)
- Conversational interaction (chat-like insights, NOT tabbed navigation)
- Organic craft aesthetic (hand-drawn, serif, textured — NOT Swiss/minimal/corporate)
- Moderate density (focused cards, NOT extreme minimalism AND NOT data-dense)
- Narrative over metrics (story of their money, NOT numbers-first)
They hesitate on: gamification (intrigued but unsure), timeline views (like the concept but worried about density)`;

// ── Schemas ───────────────────────────────────────────────────────────

const probeSchema = z.object({
  probe_content: z.string(),
  format: z.enum(['word', 'image', 'mockup']),
  hypothesis: z.string(),
  if_accepted: z.string(),
  if_rejected: z.string(),
  targets_gap: z.string(),
});

// User simulation — only outputs decision + latency, no reasoning
const swipeSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  latency_signal: z.enum(['fast', 'slow']),
});

const synthesisSchema = z.object({
  known: z.array(z.string()),
  unknown: z.array(z.string()),
  contradictions: z.array(z.string()),
  scout_guidance: z.string(),
  persona_anima_divergence: z.nullable(z.string()),
});

const builderSchema = z.object({
  can_build: z.array(z.object({
    component: z.string(),
    decisions: z.string(),
  })),
  anti_patterns: z.array(z.string()),
  probe_brief: z.object({
    component: z.string(),
    question: z.string(),
    option_a: z.string(),
    option_b: z.string(),
  }),
  draft_summary: z.string(),
});

// ── Evidence management ──────────────────────────────────────────────

const evidence = [];
let synthesis = null;

function serializeEvidence() {
  if (evidence.length === 0) return '(no evidence yet — this is the first probe)';
  return evidence.map((e, i) =>
    `${i + 1}. [${e.decision.toUpperCase()}${e.latency_signal === 'slow' ? ' (hesitant)' : ''}] "${e.content}"\n   Hypothesis: ${e.hypothesis}`
  ).join('\n\n');
}

function recentProbes(n = 3) {
  return evidence.slice(-n).map(e => e.hypothesis).join('; ');
}

// ── Concreteness floor ───────────────────────────────────────────────

function concretenessFloor() {
  const n = evidence.length;
  if (n < 4) return 'word';
  if (n < 8) return 'image';
  return 'mockup';
}

function formatInstruction() {
  const floor = concretenessFloor();
  const n = evidence.length;
  if (floor === 'word') {
    return `FORMAT: You have ${n} swipes of evidence. This is early exploration — use a single evocative WORD or short phrase (2-3 words max). You do not know enough for images or mockups yet.`;
  }
  if (floor === 'image') {
    return `FORMAT: You have ${n} swipes of evidence. You know the general direction — describe an IMAGE or moodboard that would test your hypothesis visually. You may use a mockup only if you're testing a specific layout question.`;
  }
  return `FORMAT: You have ${n} swipes of evidence. You know enough to be specific — describe a concrete MOCKUP with layout, components, and interaction details.`;
}

// ── Scout prompt ─────────────────────────────────────────────────────

function scoutPrompt() {
  let prompt = `You are a taste scout — your job is to generate the next visual probe that will be most informative about this user's preferences.

The user said they want to build: "${INTENT}"

EVIDENCE HISTORY:

${serializeEvidence()}`;

  if (synthesis) {
    prompt += `\n\nORACLE SYNTHESIS (strategic assessment):
Known: ${synthesis.known.join('; ')}
Unknown: ${synthesis.unknown.join('; ')}
${synthesis.contradictions.length ? 'Contradictions: ' + synthesis.contradictions.join('; ') : ''}
${synthesis.persona_anima_divergence ? 'Persona-Anima divergence: ' + synthesis.persona_anima_divergence : ''}
Scout guidance: ${synthesis.scout_guidance}`;
  }

  // Diversity enforcement
  if (evidence.length >= 3) {
    prompt += `\n\nDIVERSITY: Your last 3 probes tested: "${recentProbes(3)}". Do NOT probe the same territory again. Find a DIFFERENT gap in the user's taste.`;
  }

  prompt += `\n\n${formatInstruction()}

RULES:
- Do NOT repeat patterns the user already rejected
- Do NOT re-confirm things we already know
- Target the GAPS — what aspects of their taste are we still uncertain about?
- A probe the user would HESITATE on is more informative than one they'd instantly accept or reject
- Think like Akinator — each question should maximally partition the remaining possibility space`;

  return prompt;
}

// ── Simulated user swipe (outputs ONLY decision + latency) ───────────

async function simulateSwipe(probeContent, hypothesis) {
  const result = await generateText({
    model: generator,
    temperature: 0,
    output: Output.object({ schema: swipeSchema }),
    prompt: `You are simulating a user reacting to a design probe. Output ONLY their decision and latency — no reasoning.

USER TASTE (hidden):
${USER_TASTE}

PROBE:
Content: "${probeContent}"
Hypothesis: "${hypothesis}"

Rules:
- accept + fast = clearly aligns with taste
- accept + slow = partially aligns, some hesitation
- reject + fast = clearly conflicts with taste
- reject + slow = partially conflicts, gray zone`,
  });
  return result.output;
}

// ── Oracle synthesis ─────────────────────────────────────────────────

async function oracleSynthesize() {
  const result = await generateText({
    model: generator,
    temperature: 0,
    output: Output.object({ schema: synthesisSchema }),
    prompt: `You are the Oracle — the strategic brain of a taste discovery system.

The user said they want to build: "${INTENT}"

FULL EVIDENCE (accept/reject + latency only — no user reasoning, just their raw choices):

${serializeEvidence()}

Produce a strategic synthesis:
1. KNOWN — consistent patterns in accepts and rejects
2. UNKNOWN — gaps where we have no evidence or mixed signals
3. CONTRADICTIONS — hesitant swipes or mixed signals on the same topic
4. SCOUT GUIDANCE — what should scouts probe NEXT? Be specific and directive.
5. PERSONA-ANIMA DIVERGENCE — does their revealed taste diverge from stated intent?

Be concise. This gets injected into scout prompts.`,
  });
  return result.output;
}

// ── Builder extraction ───────────────────────────────────────────────

async function builderExtract() {
  let prompt = `You are the builder agent. You assemble a prototype from user choices — not words.

The user said they want to build: "${INTENT}"

EVIDENCE (raw choices only):

${serializeEvidence()}`;

  if (synthesis) {
    prompt += `\n\nORACLE SYNTHESIS:
Known: ${synthesis.known.join('; ')}
Unknown: ${synthesis.unknown.join('; ')}
Guidance: ${synthesis.scout_guidance}`;
  }

  prompt += `\n\nTASK:
1. What can you BUILD now from the evidence?
2. ANTI-PATTERNS from rejections (hard constraints)
3. What BLOCKS construction — produce a specific probe brief about a UI COMPONENT
4. Write a one-paragraph prototype draft summary

Ground in evidence. Anti-patterns are HARD CONSTRAINTS.`;

  const result = await generateText({
    model: generator,
    temperature: 0,
    output: Output.object({ schema: builderSchema }),
    prompt,
  });
  return result.output;
}

// ═══════════════════════════════════════════════════════════════════════
//  Run
// ═══════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  AKINATOR FLOW v2 — With Format Gate + Diversity       ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`\nIntent: "${INTENT}"\n`);

const flowLog = [];

for (let swipe = 1; swipe <= 12; swipe++) {
  console.log(`\n${'━'.repeat(58)}`);
  console.log(`  SWIPE ${swipe} | floor: ${concretenessFloor()}${synthesis ? ' | +synthesis' : ''}`);
  console.log(`${'━'.repeat(58)}`);

  // Scout
  const start = Date.now();
  const probeResult = await generateText({
    model: generator,
    output: Output.object({ schema: probeSchema }),
    prompt: scoutPrompt(),
  });
  const probe = probeResult.output;
  const probeMs = Date.now() - start;

  console.log(`\n  Scout (${probeMs}ms):`);
  console.log(`    format: ${probe.format}`);
  console.log(`    content: "${probe.probe_content.slice(0, 80)}"`);
  console.log(`    hypothesis: "${probe.hypothesis.slice(0, 80)}"`);
  console.log(`    gap: "${probe.targets_gap.slice(0, 60)}"`);

  // Simulated swipe (decision + latency only, no reason)
  const swipeStart = Date.now();
  const reaction = await simulateSwipe(probe.probe_content, probe.hypothesis);
  const swipeMs = Date.now() - swipeStart;

  console.log(`  User: [${reaction.decision.toUpperCase()}${reaction.latency_signal === 'slow' ? ' (hesitant)' : ''}] (${swipeMs}ms)`);

  // Record evidence — only what the real system captures
  evidence.push({
    content: probe.probe_content,
    hypothesis: probe.hypothesis,
    decision: reaction.decision,
    latency_signal: reaction.latency_signal,
  });

  flowLog.push({ swipe, probe, reaction, probeMs, swipeMs, hasSynthesis: !!synthesis, floor: concretenessFloor() });

  // Oracle synthesis every 4 swipes
  if (swipe % 4 === 0 && swipe < 12) {
    console.log(`\n  ── Oracle Synthesis (after ${swipe} swipes) ──`);
    const synthStart = Date.now();
    synthesis = await oracleSynthesize();
    const synthMs = Date.now() - synthStart;

    console.log(`  (${synthMs}ms)`);
    console.log(`  Known: ${synthesis.known.slice(0, 3).join('; ').slice(0, 120)}`);
    console.log(`  Unknown: ${synthesis.unknown.slice(0, 2).join('; ').slice(0, 120)}`);
    if (synthesis.persona_anima_divergence) console.log(`  Divergence: ${synthesis.persona_anima_divergence.slice(0, 120)}`);
    console.log(`  Guidance: "${synthesis.scout_guidance.slice(0, 120)}"`);

    flowLog.push({ type: 'synthesis', afterSwipe: swipe, synthesis, synthMs });
  }
}

// Builder
console.log(`\n${'═'.repeat(58)}`);
console.log('  BUILDER (after 12 swipes)');
console.log(`${'═'.repeat(58)}`);

const bStart = Date.now();
const builder = await builderExtract();
const bMs = Date.now() - bStart;

console.log(`\n  (${bMs}ms)`);
console.log(`  Can build: ${builder.can_build.map(c => c.component).join(', ')}`);
console.log(`  Anti-patterns: ${builder.anti_patterns.slice(0, 3).join('; ')}`);
console.log(`  Probe: "${builder.probe_brief.question.slice(0, 80)}"`);
console.log(`    A: ${builder.probe_brief.option_a.slice(0, 60)}`);
console.log(`    B: ${builder.probe_brief.option_b.slice(0, 60)}`);
console.log(`\n  Draft: "${builder.draft_summary.slice(0, 200)}"`);

flowLog.push({ type: 'builder', builder, bMs });

// ── Quality ──────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(58)}`);
console.log('  QUALITY');
console.log(`${'═'.repeat(58)}\n`);

const swipes = flowLog.filter(e => e.swipe);
const formats = swipes.map(e => e.probe.format);
const wc = formats.filter(f => f === 'word').length;
const ic = formats.filter(f => f === 'image').length;
const mc = formats.filter(f => f === 'mockup').length;

// Check 1: Format progression — words first, then images, then mockups
const firstImage = formats.indexOf('image') + 1;
const firstMockup = formats.indexOf('mockup') + 1;
const formatOk = wc >= 2 && (firstMockup === 0 || firstMockup > 4);
console.log(`  Formats: ${wc}w ${ic}i ${mc}m | 1st image: swipe ${firstImage || '-'} | 1st mockup: swipe ${firstMockup || '-'} ${formatOk ? '✓' : '✗'}`);

// Check 2: No rejected pattern repetition
const rejKeywords = [];
let repeats = false;
for (const s of swipes) {
  if (s.reaction.decision === 'reject') {
    rejKeywords.push(...s.probe.probe_content.toLowerCase().split(/\s+/).filter(w => w.length > 5));
  } else {
    const probeWords = s.probe.probe_content.toLowerCase().split(/\s+/).filter(w => w.length > 5);
    const overlap = probeWords.filter(w => rejKeywords.includes(w)).length;
    if (overlap > 3) repeats = true;
  }
}
console.log(`  Avoids rejections: ${!repeats ? '✓' : '✗'}`);

// Check 3: Hypothesis diversity
const hyps = swipes.map(e => e.probe.targets_gap.toLowerCase().slice(0, 30));
const uniqueGaps = new Set(hyps).size;
const diverse = uniqueGaps >= 6;
console.log(`  Gap diversity: ${uniqueGaps}/12 unique ${diverse ? '✓' : '✗'}`);

// Check 4: Builder concrete
const builderOk = builder.can_build.length >= 2 && builder.anti_patterns.length >= 1 && builder.draft_summary.length > 50;
console.log(`  Builder: ${builderOk ? '✓' : '✗'} (${builder.can_build.length} components, ${builder.anti_patterns.length} anti-patterns)`);

// Check 5: Evidence shape
const accepts = swipes.filter(e => e.reaction.decision === 'accept').length;
const rejects = swipes.filter(e => e.reaction.decision === 'reject').length;
const hesitant = swipes.filter(e => e.reaction.latency_signal === 'slow').length;
const hasRejects = rejects >= 2;
console.log(`  Evidence: ${accepts}a ${rejects}r ${hesitant}h ${hasRejects ? '✓' : '✗ not enough rejects'}`);

const passed = [formatOk, !repeats, diverse, builderOk, hasRejects].filter(Boolean).length;
console.log(`\n  OVERALL: ${passed}/5`);

// ── Report ───────────────────────────────────────────────────────────

const report = `# Akinator Flow v2 — Full Loop with Format Gate + Diversity

Model: \`gemini-3.1-flash-lite-preview\`
Date: ${new Date().toISOString().slice(0, 10)}
Intent: "${INTENT}"
Swipes: 12 | Oracle synthesis every 4 | Format floor enforced

## Quality: ${passed}/5

- Format progression: ${formatOk ? 'PASS' : 'FAIL'} (${wc}w ${ic}i ${mc}m)
- Avoids rejections: ${!repeats ? 'PASS' : 'FAIL'}
- Gap diversity: ${diverse ? 'PASS' : 'FAIL'} (${uniqueGaps}/12)
- Builder concrete: ${builderOk ? 'PASS' : 'FAIL'}
- Evidence shape: ${hasRejects ? 'PASS' : 'FAIL'} (${accepts}a ${rejects}r ${hesitant}h)

## Flow

| # | Floor | Format | Content | Decision | Gap |
|---|-------|--------|---------|----------|-----|
${swipes.map(e => `| ${e.swipe} | ${e.floor} | ${e.probe.format} | ${e.probe.probe_content.slice(0, 35)}... | ${e.reaction.decision}${e.reaction.latency_signal === 'slow' ? '*' : ''} | ${e.probe.targets_gap.slice(0, 35)}... |`).join('\n')}

*hesitant

## Oracle Syntheses

${flowLog.filter(e => e.type === 'synthesis').map(s => `### After swipe ${s.afterSwipe} (${s.synthMs}ms)
- **Known:** ${s.synthesis.known.join('; ')}
- **Unknown:** ${s.synthesis.unknown.join('; ')}
- **Contradictions:** ${s.synthesis.contradictions.join('; ') || '(none)'}
- **Divergence:** ${s.synthesis.persona_anima_divergence || '(none)'}
- **Guidance:** ${s.synthesis.scout_guidance}`).join('\n\n')}

## Builder (${bMs}ms)

**Components:** ${builder.can_build.map(c => `${c.component} (${c.decisions})`).join('; ')}
**Anti-patterns:** ${builder.anti_patterns.join('; ')}
**Probe:** ${builder.probe_brief.question}
- A: ${builder.probe_brief.option_a}
- B: ${builder.probe_brief.option_b}

**Draft:** ${builder.draft_summary}

## Evidence Trace

${swipes.map(e => `**Swipe ${e.swipe}** [${e.reaction.decision}${e.reaction.latency_signal === 'slow' ? ' hesitant' : ''}] "${e.probe.probe_content.slice(0, 80)}"
Hypothesis: ${e.probe.hypothesis.slice(0, 100)}`).join('\n\n')}
`;

mkdirSync('scripts/findings', { recursive: true });
writeFileSync('scripts/findings/akinator-flow-v2.md', report);

console.log(`\n${'═'.repeat(58)}`);
console.log('  Report: scripts/findings/akinator-flow-v2.md');
console.log(`${'═'.repeat(58)}\n`);
