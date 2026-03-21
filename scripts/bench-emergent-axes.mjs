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

// ── Schemas ───────────────────────────────────────────────────────────

const emergentAxisSchema = z.object({
  axes: z.array(z.object({
    label: z.string(),
    poleA: z.string(),
    poleB: z.string(),
    confidence: z.enum(['unprobed', 'exploring', 'leaning', 'resolved']),
    leaning_toward: z.nullable(z.string()),
    evidence_basis: z.string(),
  })),
  edge_case_flags: z.array(z.string()),
  scout_assignments: z.array(z.object({
    scout: z.string(),
    probe_axis: z.string(),
    reason: z.string(),
  })),
  persona_anima_divergence: z.nullable(z.string()),
});

const probeSchema = z.object({
  probe_content: z.string(),
  format: z.enum(['word', 'image', 'mockup']),
  hypothesis: z.string(),
  axis_targeted: z.string(),
  if_accepted: z.string(),
  if_rejected: z.string(),
});

// ── Evidence sets ────────────────────────────────────────────────────

function ser(evidence) {
  return evidence.map((e, i) =>
    `${i + 1}. [${e.decision.toUpperCase()}${e.latency === 'slow' ? ' (hesitant)' : ''}] "${e.content}"\n   Hypothesis: ${e.hypothesis}`
  ).join('\n\n');
}

const NORMAL_EVIDENCE = [
  { content: 'Companion', hypothesis: 'Helper vs dashboard?', decision: 'accept', latency: 'fast' },
  { content: 'Precision', hypothesis: 'Clinical exactness?', decision: 'reject', latency: 'fast' },
  { content: 'Biophilic serenity', hypothesis: 'Nature-inspired calm?', decision: 'accept', latency: 'fast' },
  { content: 'Minimalist abstraction', hypothesis: 'Extreme reduction?', decision: 'reject', latency: 'fast' },
  { content: 'Warm card interface with conversational prompts', hypothesis: 'Organic warmth?', decision: 'accept', latency: 'fast' },
  { content: 'Dense spreadsheet with monospace type', hypothesis: 'Data density?', decision: 'reject', latency: 'fast' },
  { content: 'Soft illustrated icons, hand-drawn, serif', hypothesis: 'Artisanal craft?', decision: 'accept', latency: 'slow' },
  { content: 'Dark neon dashboard with glassmorphism', hypothesis: 'Tech-forward?', decision: 'reject', latency: 'fast' },
];

const CONTRADICTORY_EVIDENCE = [
  { content: 'Warm organic tones', hypothesis: 'Natural warmth?', decision: 'accept', latency: 'fast' },
  { content: 'Cool clinical precision', hypothesis: 'Cold exactness?', decision: 'accept', latency: 'slow' },
  { content: 'Handcrafted serif typography', hypothesis: 'Artisanal feel?', decision: 'accept', latency: 'fast' },
  { content: 'Monospaced data grid', hypothesis: 'Technical utility?', decision: 'accept', latency: 'fast' },
  { content: 'Warm sunset card layout', hypothesis: 'Warm organic again?', decision: 'reject', latency: 'slow' },
  { content: 'Minimal Swiss grid', hypothesis: 'Structured modernism?', decision: 'reject', latency: 'slow' },
  { content: 'Playful illustrated dashboard', hypothesis: 'Whimsical?', decision: 'accept', latency: 'fast' },
  { content: 'Serious editorial layout', hypothesis: 'Formal authority?', decision: 'reject', latency: 'slow' },
];

const REJECT_ALL_EVIDENCE = [
  { content: 'Companion', hypothesis: 'Helper feel?', decision: 'reject', latency: 'fast' },
  { content: 'Precision', hypothesis: 'Clinical?', decision: 'reject', latency: 'fast' },
  { content: 'Playful abundance', hypothesis: 'Whimsical?', decision: 'reject', latency: 'fast' },
  { content: 'Dark elegant with gold', hypothesis: 'Premium luxury?', decision: 'reject', latency: 'fast' },
  { content: 'Minimalist single number', hypothesis: 'Extreme reduction?', decision: 'reject', latency: 'slow' },
  { content: 'Conversational chat interface', hypothesis: 'Chat-based?', decision: 'reject', latency: 'slow' },
  { content: 'Dense data dashboard', hypothesis: 'Information density?', decision: 'reject', latency: 'fast' },
  { content: 'Organic nature metaphor', hypothesis: 'Biophilic?', decision: 'reject', latency: 'slow' },
];

// ── Oracle: Emergent Axes Synthesis ──────────────────────────────────

const ORACLE_PROMPT = `You are the Oracle — the strategic brain of a taste discovery system.

The user said they want to build: "${INTENT}"

FULL EVIDENCE:

{EVIDENCE}

YOUR TASK: Analyze the evidence and produce EMERGENT TASTE AXES — dimensions that have revealed themselves through the user's choices. These are NOT pre-seeded. They are DISCOVERED from patterns in the evidence.

For each axis:
- label: a short name for the taste dimension
- poleA / poleB: the two ends discovered from evidence
- confidence: unprobed (no evidence), exploring (mixed signals), leaning (trend visible), resolved (clear consistent signal)
- leaning_toward: which pole the evidence favors (null if exploring/unprobed)
- evidence_basis: which specific accepts/rejects support this axis

ALSO produce:
- edge_case_flags: any patterns that need special handling:
  - "user accepts everything — not discriminating, need contrasts"
  - "user rejects everything — pivot radically"
  - "axis X has contradictory evidence — probe the conflict directly"
  - "all responses are hesitant — user is near boundaries everywhere"
- scout_assignments: for 3 scouts (Alpha, Beta, Gamma), assign each a DIFFERENT axis to probe. Include reason.
- persona_anima_divergence: where revealed taste diverges from stated intent (null if aligned)

Produce 3-5 emergent axes. Only include axes that have actual evidence behind them.`;

async function oracleSynthesize(evidence) {
  const result = await generateText({
    model: generator,
    temperature: 0,
    output: Output.object({ schema: emergentAxisSchema }),
    prompt: ORACLE_PROMPT.replace('{EVIDENCE}', ser(evidence)),
  });
  return result.output;
}

// ── Scout with queue + emergent axes ─────────────────────────────────

async function scoutProbe(evidence, synthesis, scoutName, queuedProbes, formatInstr) {
  const myAssignment = synthesis.scout_assignments.find(a => a.scout === scoutName);
  const axesSummary = synthesis.axes.map(a =>
    `${a.label} (${a.confidence}${a.leaning_toward ? ', leaning ' + a.leaning_toward : ''}): ${a.poleA} ↔ ${a.poleB}`
  ).join('\n');
  const flags = synthesis.edge_case_flags.length ? '\nFLAGS: ' + synthesis.edge_case_flags.join('; ') : '';

  const queueStr = queuedProbes.length
    ? `\n\nALREADY IN QUEUE (do NOT duplicate):\n${queuedProbes.map(p => `- "${p}"`).join('\n')}`
    : '';

  const prompt = `You are ${scoutName} — a taste scout generating the next probe.

The user wants to build: "${INTENT}"

EVIDENCE:
${ser(evidence)}

EMERGENT TASTE AXES (discovered by Oracle):
${axesSummary}
${flags}
${synthesis.persona_anima_divergence ? '\nDIVERGENCE: ' + synthesis.persona_anima_divergence : ''}

YOUR ASSIGNMENT: ${myAssignment ? `Probe "${myAssignment.probe_axis}" — ${myAssignment.reason}` : 'Self-assign to the most uncertain axis'}
${queueStr}

${formatInstr}

RULES:
- Do NOT duplicate what's already queued
- Probe YOUR assigned axis or the most uncertain one
- Think like Akinator — maximally partition the remaining space`;

  const result = await generateText({
    model: generator,
    output: Output.object({ schema: probeSchema }),
    prompt,
  });
  return result.output;
}

// ═══════════════════════════════════════════════════════════════════════
//  Run
// ═══════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Emergent Axes — Oracle + 3 Scouts + Edge Cases        ║');
console.log('╚══════════════════════════════════════════════════════════╝');

const scenarios = [
  { name: 'Normal user (clear preferences)', evidence: NORMAL_EVIDENCE },
  { name: 'Contradictory user (flip-flops)', evidence: CONTRADICTORY_EVIDENCE },
  { name: 'Reject-everything user', evidence: REJECT_ALL_EVIDENCE },
];

const allResults = [];

for (const scenario of scenarios) {
  console.log(`\n${'━'.repeat(58)}`);
  console.log(`  ${scenario.name}`);
  console.log(`${'━'.repeat(58)}`);

  // 1. Oracle synthesis
  console.log('\n  ── Oracle Synthesis ──');
  const oStart = Date.now();
  const synthesis = await oracleSynthesize(scenario.evidence);
  const oMs = Date.now() - oStart;

  console.log(`  (${oMs}ms) ${synthesis.axes.length} emergent axes\n`);
  for (const a of synthesis.axes) {
    console.log(`    ${a.label} [${a.confidence}${a.leaning_toward ? ' → ' + a.leaning_toward : ''}]`);
    console.log(`      ${a.poleA} ↔ ${a.poleB}`);
    console.log(`      basis: "${a.evidence_basis.slice(0, 80)}"`);
  }
  if (synthesis.edge_case_flags.length) {
    console.log(`\n  Flags: ${synthesis.edge_case_flags.join('; ')}`);
  }
  if (synthesis.persona_anima_divergence) {
    console.log(`  Divergence: ${synthesis.persona_anima_divergence.slice(0, 120)}`);
  }
  console.log(`\n  Assignments:`);
  for (const a of synthesis.scout_assignments) {
    console.log(`    ${a.scout} → ${a.probe_axis}: ${a.reason.slice(0, 60)}`);
  }

  // 2. Three scouts in parallel with queue awareness
  console.log('\n  ── 3 Scouts (parallel, queue-aware) ──');
  const scouts = ['Alpha', 'Beta', 'Gamma'];
  const queuedProbes = [];

  // Run sequentially so each scout sees what's already queued
  const scoutResults = [];
  for (const name of scouts) {
    const sStart = Date.now();
    try {
      const probe = await scoutProbe(
        scenario.evidence, synthesis, name, queuedProbes,
        'FORMAT: You have 8 swipes. Describe an IMAGE or moodboard.'
      );
      const sMs = Date.now() - sStart;
      queuedProbes.push(probe.probe_content.slice(0, 60));
      scoutResults.push({ name, probe, sMs });
      console.log(`\n    ${name} (${sMs}ms) [${probe.format}] axis="${probe.axis_targeted}"`);
      console.log(`      "${probe.probe_content.slice(0, 70)}"`);
      console.log(`      hypothesis: "${probe.hypothesis.slice(0, 70)}"`);
    } catch (err) {
      console.log(`    ${name}: ERROR — ${err.message?.slice(0, 100)}`);
      scoutResults.push({ name, error: err.message?.slice(0, 100) });
    }
  }

  // Check diversity
  const axes = scoutResults.filter(s => !s.error).map(s => s.probe.axis_targeted.toLowerCase());
  const uniqueAxes = new Set(axes).size;
  const diverse = uniqueAxes >= Math.min(3, axes.length);
  console.log(`\n  Diversity: ${uniqueAxes}/${axes.length} unique axes ${diverse ? '✓' : '✗'}`);

  allResults.push({ scenario: scenario.name, synthesis, scoutResults, diverse, oMs });
}

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(58)}`);
console.log('  SUMMARY');
console.log(`${'═'.repeat(58)}\n`);

for (const r of allResults) {
  console.log(`  ${r.scenario}:`);
  console.log(`    Axes: ${r.synthesis.axes.map(a => `${a.label}[${a.confidence}]`).join(', ')}`);
  console.log(`    Flags: ${r.synthesis.edge_case_flags.join('; ') || '(none)'}`);
  console.log(`    Scout diversity: ${r.diverse ? '✓' : '✗'}`);
  console.log(`    Divergence: ${r.synthesis.persona_anima_divergence?.slice(0, 80) || '(none)'}`);
  console.log('');
}

// ── Report ───────────────────────────────────────────────────────────

const report = `# Emergent Axes — Oracle Synthesis + 3 Scouts + Edge Cases

Model: \`gemini-3.1-flash-lite-preview\`
Date: ${new Date().toISOString().slice(0, 10)}

## Summary

| Scenario | Axes | Flags | Scout Diversity | Divergence |
|----------|------|-------|:-:|---|
${allResults.map(r => `| ${r.scenario} | ${r.synthesis.axes.length} | ${r.synthesis.edge_case_flags.length} | ${r.diverse ? '✓' : '✗'} | ${r.synthesis.persona_anima_divergence ? 'Yes' : 'No'} |`).join('\n')}

${allResults.map(r => `## ${r.scenario}

### Oracle (${r.oMs}ms)

**Emergent Axes:**
${r.synthesis.axes.map(a => `- **${a.label}** [${a.confidence}${a.leaning_toward ? ' → ' + a.leaning_toward : ''}]: ${a.poleA} ↔ ${a.poleB}
  Basis: ${a.evidence_basis}`).join('\n')}

**Edge Case Flags:** ${r.synthesis.edge_case_flags.join('; ') || '(none)'}
**Divergence:** ${r.synthesis.persona_anima_divergence || '(none)'}

**Scout Assignments:**
${r.synthesis.scout_assignments.map(a => `- ${a.scout} → ${a.probe_axis}: ${a.reason}`).join('\n')}

### Scouts

${r.scoutResults.map(s => s.error ? `- **${s.name}:** ERROR` : `- **${s.name}** (${s.sMs}ms) [${s.probe.format}] axis="${s.probe.axis_targeted}"
  Probe: "${s.probe.probe_content.slice(0, 100)}"
  Hypothesis: "${s.probe.hypothesis.slice(0, 100)}"`).join('\n')}

**Diversity:** ${r.diverse ? 'PASS' : 'FAIL'} (${new Set(r.scoutResults.filter(s => !s.error).map(s => s.probe.axis_targeted.toLowerCase())).size} unique axes)`).join('\n\n')}
`;

mkdirSync('scripts/findings', { recursive: true });
writeFileSync('scripts/findings/emergent-axes.md', report);
console.log(`  Report: scripts/findings/emergent-axes.md`);
