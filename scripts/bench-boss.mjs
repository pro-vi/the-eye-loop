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
const oracleModel = google('gemini-3.1-pro-preview');
const renderer = google('gemini-3.1-flash-image-preview');
const INTENT = "personal finance app that doesn't feel like a spreadsheet";
const OUT = 'scripts/boss-run';

// ── Match actual codebase names + schemas ─────────────────────────────

const SCOUTS = ['Iris', 'Prism', 'Lumen'];

// From src/lib/server/agents/scout.ts ScoutOutputSchema
const ScoutOutputSchema = z.object({
  label: z.string(),
  hypothesis: z.string(),
  axis_targeted: z.string(),
  format: z.enum(['word', 'image', 'mockup']),
  content: z.string(),
  accept_implies: z.string(),
  reject_implies: z.string(),
});

// From src/lib/server/agents/oracle.ts synthesisSchema
const synthesisSchema = z.object({
  axes: z.array(z.object({
    label: z.string(),
    poleA: z.string(),
    poleB: z.string(),
    confidence: z.enum(['unprobed', 'exploring', 'leaning', 'resolved']),
    leaning_toward: z.string().nullable(),
    evidence_basis: z.string(),
  })),
  edge_case_flags: z.array(z.string()),
  scout_assignments: z.array(z.object({
    scout: z.string(),
    probe_axis: z.string(),
    reason: z.string(),
  })),
  persona_anima_divergence: z.string().nullable(),
});

// From src/lib/server/agents/builder.ts DraftUpdateSchema
const DraftUpdateSchema = z.object({
  title: z.string(),
  summary: z.string(),
  html: z.string(),
  acceptedPatterns: z.array(z.string()),
  rejectedPatterns: z.array(z.string()),
  probeBriefs: z.array(z.object({
    source: z.literal('builder'),
    priority: z.enum(['high', 'normal']),
    brief: z.string(),
    context: z.string(),
    heldConstant: z.array(z.string()),
  })),
  nextHint: z.string().nullable(),
});

const swipeSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  latency_signal: z.enum(['fast', 'slow']),
});

// ── User profiles ────────────────────────────────────────────────────

const COOPERATIVE_USER = `Taste: warm companion-like feel, conversational interaction, organic craft aesthetic (hand-drawn, serif, textured), moderate density (focused cards), narrative over metrics. Hesitates on: gamification, timeline views.`;

const ADVERSARIAL_USER = `Taste: contradictory and hard to please. Rejects ~70% of probes. Accepts warm things sometimes but also accepts cold clinical things. Rejects both extremes (too minimal AND too dense). Hesitates on almost everything. Has no coherent aesthetic — the system must find the thread.`;

// ── Session state ────────────────────────────────────────────────────

function createSession() {
  return {
    evidence: [],
    synthesis: null,
    queue: [],      // current facade labels in queue
    antiPatterns: [],
    draft: { title: '', summary: '', html: '', acceptedPatterns: [], rejectedPatterns: [] },
    facades: [],    // all facades for logging
  };
}

// ── Serialization (matches context.toEvidencePrompt()) ───────────────

function toEvidencePrompt(evidence) {
  if (!evidence.length) return '(no evidence yet)';
  return evidence.map((e, i) =>
    `${i + 1}. [${e.decision.toUpperCase()}${e.latencySignal === 'slow' ? ' (hesitant)' : ''}] "${e.content}"\n   Hypothesis: ${e.hypothesis}`
  ).join('\n\n');
}

// ── Concreteness floor (matches oracle.ts checkFloor) ────────────────

function concretenessFloor(n) {
  if (n < 4) return 'word';
  if (n < 8) return 'image';
  return 'mockup';
}

function formatInstruction(n) {
  const f = concretenessFloor(n);
  if (f === 'word') return `You have ${n} swipes of evidence. This is early exploration — use a single evocative WORD or short phrase (2-3 words max). Set format to "word" and put the word in both label and content.`;
  if (f === 'image') return `You have ${n} swipes of evidence. Describe an IMAGE — a moodboard, color palette, or visual concept. Set format to "image" and put the visual description in content. Label should be a short title.`;
  return `You have ${n} swipes of evidence. Describe a concrete MOCKUP with specific layout, typography, and color decisions. Set format to "mockup" and put the full description in content. Label should be a short title.`;
}

// ── Scout prompt (matches src/lib/server/agents/scout.ts SCOUT_PROMPT) ─

function scoutPrompt(name, session, recentHyps) {
  const syn = session.synthesis;
  const axesStr = syn?.axes?.length
    ? syn.axes.map(a => `  - ${a.label} [${a.confidence}${a.leaning_toward ? ' → ' + a.leaning_toward : ''}]: ${a.poleA} vs ${a.poleB}\n    Evidence: ${a.evidence_basis}`).join('\n')
    : 'Not yet available (need 4+ swipes).';

  const assignment = syn?.scout_assignments?.find(a => a.scout === name);
  const assignStr = assignment
    ? `Probe "${assignment.probe_axis}" — ${assignment.reason}`
    : 'No assignment yet — self-assign from most uncertain gap.';

  const queueStr = session.queue.length
    ? session.queue.map(q => `  - "${q}"`).join('\n')
    : '(queue empty)';

  const antiStr = session.antiPatterns.length
    ? session.antiPatterns.map(p => `  - ${p}`).join('\n')
    : '  (none yet)';

  const recentStr = recentHyps.length
    ? recentHyps.map(h => `"${h}"`).join(', ')
    : '(none yet — this is your first probe)';

  return `You are a taste scout — your job is to generate the next visual probe
that will be most informative about this user's preferences.

The user said they want to build: "${INTENT}"

EVIDENCE HISTORY (accept = they liked it, reject = they didn't,
hesitant = they took a long time to decide):

${toEvidencePrompt(session.evidence)}

EMERGENT AXES (oracle-discovered taste dimensions):
${axesStr}

YOUR AXIS ASSIGNMENT:
${assignStr}

QUEUE (probes already pending — do NOT duplicate):
${queueStr}

ANTI-PATTERNS (hard constraints — NEVER use these):
${antiStr}

DIVERSITY: Your last 3 probes tested: ${recentStr}.
Do NOT probe the same territory again. Find a DIFFERENT gap.

PROBE BRIEF (from Builder — if present, this takes priority):
${session.draft.nextHint ? session.draft.nextHint : 'None — self-assign from most uncertain gap'}

FORMAT INSTRUCTION:
${formatInstruction(session.evidence.length)}

RULES:
- Follow your axis assignment OR pick the most uncertain axis not already queued
- Do NOT duplicate what's already in the queue
- Do NOT repeat patterns the user already rejected
- Do NOT re-confirm things we already know (resolved axes)
- Target EXPLORING or UNPROBED axes
- A probe the user would HESITATE on is more informative
- Think like Akinator — maximally partition the remaining space
- Set axis_targeted to the emergent axis label you're probing
- Respect the format instruction above`;
}

// ── Oracle prompt (matches src/lib/server/agents/oracle.ts) ──────────

function oraclePrompt(session) {
  return `You are the Oracle — the strategic brain of a taste discovery system.

The user said they want to build: "${INTENT}"

FULL EVIDENCE (accept/reject + latency only — no user reasoning):

${toEvidencePrompt(session.evidence)}

Analyze the evidence and produce EMERGENT TASTE AXES — dimensions that
have revealed themselves through the user's choices. These are NOT
pre-seeded. They are DISCOVERED from patterns in the evidence.

For each axis:
- label: short name for the taste dimension
- poleA / poleB: the two ends discovered from evidence
- confidence: unprobed | exploring | leaning | resolved
- leaning_toward: which pole (null if exploring/unprobed)
- evidence_basis: which accepts/rejects support this

Also produce:
- edge_case_flags: patterns needing special handling ("user accepts everything", "axis X contradictory", "all hesitant")
- scout_assignments: for 3 scouts (Iris, Prism, Lumen), assign each a DIFFERENT axis to probe next
- persona_anima_divergence: where revealed taste diverges from stated intent (null if none detected)`;
}

// ── Builder prompt (matches src/lib/server/agents/builder.ts) ────────

function builderPrompt(session, lastFacade, lastDecision) {
  const syn = session.synthesis;
  const synthStr = syn?.axes?.length
    ? syn.axes.map(a => `  ${a.label}: ${a.poleA} ↔ ${a.poleB} [${a.confidence}${a.leaning_toward ? ` → ${a.leaning_toward}` : ''}]`).join('\n')
    : 'Not yet available.';

  return `You are the builder agent. You assemble a prototype from what users
have shown through their choices — not from what they said.

The user said they want to build: "${INTENT}"

EVIDENCE HISTORY:

${toEvidencePrompt(session.evidence)}

EMERGENT AXES (oracle-discovered taste dimensions):
${synthStr}
Use RESOLVED axes as constraints. EXPLORING axes = don't commit yet. LEANING = likely direction.

CURRENT DRAFT:
  title: ${session.draft.title || '(empty)'}
  summary: ${session.draft.summary || '(empty)'}

CURRENT DRAFT HTML:
${session.draft.html || '(empty)'}

ACCEPTED PATTERNS SO FAR: ${JSON.stringify(session.draft.acceptedPatterns)}
REJECTED PATTERNS SO FAR: ${JSON.stringify(session.draft.rejectedPatterns)}

ANTI-PATTERNS (hard constraints — NEVER violate):
${session.antiPatterns.length ? session.antiPatterns.map(p => `  - ${p}`).join('\n') : '  (none yet)'}

LAST SWIPE:
  decision: ${lastDecision}
  hypothesis: "${lastFacade.hypothesis}"
  content: "${lastFacade.content?.slice(0, 200)}"

RULES:
- Ground everything in the evidence
- Anti-patterns (rejected things) are HARD CONSTRAINTS
- Reference specific accepted/rejected items as justification
- Probe briefs must be about SPECIFIC UI COMPONENTS, not abstract dimensions
- acceptedPatterns and rejectedPatterns are DELTAS — only new patterns from THIS swipe
- html must be COMPLETE — include all sections, not just changes

OUTPUT: updated title, summary, html, pattern deltas, probe briefs, nextHint`;
}

// ── Simulated user ───────────────────────────────────────────────────

async function simulateSwipe(content, hypothesis, userProfile) {
  const result = await generateText({
    model: generator, temperature: 0,
    output: Output.object({ schema: swipeSchema }),
    prompt: `Simulate a user reacting. Output ONLY decision + latency.
USER TASTE (hidden): ${userProfile}
PROBE: "${content}"
HYPOTHESIS: "${hypothesis}"
accept+fast = clearly aligns. accept+slow = partial. reject+fast = clearly conflicts. reject+slow = gray zone.`,
  });
  return result.output;
}

// ── Save facade to disk ──────────────────────────────────────────────

function saveFacade(runLabel, swipeNum, scoutName, output, reaction, image) {
  const prefix = `${OUT}/${runLabel}`;
  mkdirSync(prefix, { recursive: true });

  const tag = reaction.decision === 'accept' ? 'ACCEPT' : 'REJECT';
  const hes = reaction.latency_signal === 'slow' ? '-hesitant' : '';
  const fname = `${String(swipeNum).padStart(2, '0')}-${scoutName}-${tag}${hes}`;

  if (output.format === 'word') {
    writeFileSync(`${prefix}/${fname}.txt`,
      `WORD: ${output.label}\n\nHypothesis: ${output.hypothesis}\nAxis: ${output.axis_targeted}\nAccept implies: ${output.accept_implies}\nReject implies: ${output.reject_implies}\nDecision: ${reaction.decision} (${reaction.latency_signal})`);
  } else if (output.format === 'mockup') {
    const html = output.content.includes('<') ? output.content :
      `<!DOCTYPE html><html><head><meta name="viewport" content="width=375"></head><body style="font-family:Georgia,serif;padding:20px;background:#FFF8F0;color:#4A3E38;max-width:375px;margin:0 auto"><h2>${output.label}</h2><p>${output.content}</p></body></html>`;
    writeFileSync(`${prefix}/${fname}.html`, html);
    writeFileSync(`${prefix}/${fname}.meta.txt`,
      `MOCKUP: ${output.label}\n\nAxis: ${output.axis_targeted}\nHypothesis: ${output.hypothesis}\nDecision: ${reaction.decision} (${reaction.latency_signal})\n\n${output.content}`);
  } else {
    writeFileSync(`${prefix}/${fname}.txt`,
      `IMAGE: ${output.label}\n\n${output.content}\n\nAxis: ${output.axis_targeted}\nHypothesis: ${output.hypothesis}\nDecision: ${reaction.decision} (${reaction.latency_signal})`);
    if (image) {
      const ext = image.mediaType?.includes('png') ? 'png' : 'jpg';
      writeFileSync(`${prefix}/${fname}.${ext}`, Buffer.from(image.base64, 'base64'));
    }
  }
}

// ── Generate image for image facades ─────────────────────────────────

async function maybeGenerateImage(output) {
  if (output.format !== 'image') return null;
  try {
    const result = await generateText({
      model: renderer,
      providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } },
      prompt: output.content,
    });
    return result.files?.[0] ? { base64: result.files[0].base64, mediaType: result.files[0].mediaType } : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════
//  Full session
// ═══════════════════════════════════════════════════════════════════════

async function runSession(label, userProfile) {
  console.log(`\n${'╔' + '═'.repeat(56) + '╗'}`);
  console.log(`║  ${label.padEnd(54)} ║`);
  console.log(`${'╚' + '═'.repeat(56) + '╝'}\n`);

  const session = createSession();
  const scoutHistory = { Iris: [], Prism: [], Lumen: [] };
  const gates = {};
  mkdirSync(`${OUT}/${label}`, { recursive: true });

  // ── Phase 1: Cold Start ──────────────────────────────────────────

  console.log('  ── Phase 1: Cold Start (3 scouts from intent only) ──\n');

  const coldProbes = await Promise.all(
    SCOUTS.map(name =>
      generateText({
        model: generator,
        output: Output.object({ schema: ScoutOutputSchema }),
        temperature: 1.0,
        system: scoutPrompt(name, session, []),
        prompt: 'Generate the next taste probe. Follow the format instruction.',
      }).then(r => ({ name, output: r.output }))
    )
  );

  const coldAxes = new Set(coldProbes.map(p => p.output.axis_targeted?.toLowerCase()));
  gates.coldDiversity = coldAxes.size >= 2;
  const allWords = coldProbes.every(p => p.output.format === 'word');
  console.log(`  Gate 1 (cold diversity): ${coldAxes.size}/3 ${gates.coldDiversity ? '✓' : '✗'}`);
  console.log(`  Gate 5 partial (all words): ${allWords ? '✓' : '✗'}`);

  for (const { name, output } of coldProbes) {
    const reaction = await simulateSwipe(output.content, output.hypothesis, userProfile);
    session.evidence.push({ content: output.content, hypothesis: output.hypothesis, decision: reaction.decision, latencySignal: reaction.latency_signal });
    if (reaction.decision === 'reject') session.antiPatterns.push(output.hypothesis);
    scoutHistory[name].unshift(output.hypothesis);
    saveFacade(label, session.evidence.length, name, output, reaction);
    session.facades.push({ swipe: session.evidence.length, name, output, reaction });
    console.log(`    ${name}: [${output.format}] "${output.label}" → ${reaction.decision}${reaction.latency_signal === 'slow' ? '*' : ''}`);
  }

  // ── Phase 2: First Oracle ────────────────────────────────────────

  console.log('\n  ── Phase 2: Oracle Synthesis #1 ──\n');
  const o1Start = Date.now();
  const o1Result = await generateText({
    model: oracleModel, temperature: 0,
    output: Output.object({ schema: synthesisSchema }),
    prompt: oraclePrompt(session),
  });
  session.synthesis = o1Result.output;
  const o1Ms = Date.now() - o1Start;

  gates.oracleAxes = session.synthesis.axes.length >= 3;
  const assignAxes = new Set(session.synthesis.scout_assignments.map(a => a.probe_axis.toLowerCase()));
  gates.assignDiverge = assignAxes.size >= Math.min(3, session.synthesis.scout_assignments.length);

  console.log(`  Gate 2 (axes): ${session.synthesis.axes.length} ${gates.oracleAxes ? '✓' : '✗'} (${o1Ms}ms)`);
  for (const a of session.synthesis.axes) console.log(`    ${a.label} [${a.confidence}]: ${a.poleA} ↔ ${a.poleB}`);
  console.log(`  Gate 3 (assign): ${assignAxes.size} unique ${gates.assignDiverge ? '✓' : '✗'}`);
  for (const a of session.synthesis.scout_assignments) console.log(`    ${a.scout} → ${a.probe_axis}`);
  if (session.synthesis.persona_anima_divergence) console.log(`  Divergence: ${session.synthesis.persona_anima_divergence.slice(0, 100)}`);

  writeFileSync(`${OUT}/${label}/oracle-1.json`, JSON.stringify(session.synthesis, null, 2));

  // ── Phase 3: Coordinated Probes (swipes 4-8) ────────────────────

  console.log('\n  ── Phase 3: Coordinated Probes (5 swipes) ──\n');

  for (let i = 0; i < 5; i++) {
    const scoutIdx = i % 3;
    const name = SCOUTS[scoutIdx];
    session.queue = [];

    const result = await generateText({
      model: generator, temperature: 1.0,
      output: Output.object({ schema: ScoutOutputSchema }),
      system: scoutPrompt(name, session, scoutHistory[name].slice(0, 3)),
      prompt: 'Generate the next taste probe. Follow the format instruction.',
    });
    const output = result.output;
    session.queue.push(output.label);

    const reaction = await simulateSwipe(output.content, output.hypothesis, userProfile);
    session.evidence.push({ content: output.content, hypothesis: output.hypothesis, decision: reaction.decision, latencySignal: reaction.latency_signal });
    if (reaction.decision === 'reject') session.antiPatterns.push(output.hypothesis);
    scoutHistory[name].unshift(output.hypothesis);

    let image = null;
    if (output.format === 'image') {
      console.log(`    ${name}: generating image...`);
      image = await maybeGenerateImage(output);
    }

    saveFacade(label, session.evidence.length, name, output, reaction, image);
    session.facades.push({ swipe: session.evidence.length, name, output, reaction, hasImage: !!image });
    console.log(`    ${name}: [${output.format}] "${output.label}" axis="${output.axis_targeted?.slice(0, 25)}" → ${reaction.decision}${reaction.latency_signal === 'slow' ? '*' : ''}`);
  }

  // ── Phase 3.5: Builder mid-session ───────────────────────────────

  console.log('\n  ── Builder Mid-Session ──\n');
  const lastFacade = session.facades[session.facades.length - 1];
  const bMidStart = Date.now();
  const bMidResult = await generateText({
    model: generator, temperature: 0,
    output: Output.object({ schema: DraftUpdateSchema }),
    system: builderPrompt(session, lastFacade.output, lastFacade.reaction.decision),
    prompt: `Swipe #${session.evidence.length}: user ${lastFacade.reaction.decision}ed "${lastFacade.output.label}". Update the draft.`,
  });
  const bMid = bMidResult.output;
  const bMidMs = Date.now() - bMidStart;

  session.draft = { title: bMid.title, summary: bMid.summary, html: bMid.html, acceptedPatterns: bMid.acceptedPatterns, rejectedPatterns: bMid.rejectedPatterns };
  if (bMid.nextHint) session.draft.nextHint = bMid.nextHint;

  gates.builderMid = bMid.html.length > 50 && bMid.rejectedPatterns.length >= 0;
  console.log(`  Gate 8 (builder mid): "${bMid.title}" ${bMid.html.length} chars ${gates.builderMid ? '✓' : '✗'} (${bMidMs}ms)`);
  writeFileSync(`${OUT}/${label}/builder-mid.html`, bMid.html);
  writeFileSync(`${OUT}/${label}/builder-mid.meta.txt`, `Title: ${bMid.title}\nSummary: ${bMid.summary}\nHint: ${bMid.nextHint}\nAccepted: ${bMid.acceptedPatterns.join(', ')}\nRejected: ${bMid.rejectedPatterns.join(', ')}`);

  // ── Phase 4: Second Oracle ───────────────────────────────────────

  console.log('\n  ── Phase 4: Oracle Synthesis #2 ──\n');
  const prevAxesStr = session.synthesis.axes.map(a => `${a.label}:${a.confidence}`).join(',');
  const o2Start = Date.now();
  const o2Result = await generateText({
    model: oracleModel, temperature: 0,
    output: Output.object({ schema: synthesisSchema }),
    prompt: oraclePrompt(session),
  });
  session.synthesis = o2Result.output;
  const o2Ms = Date.now() - o2Start;
  const newAxesStr = session.synthesis.axes.map(a => `${a.label}:${a.confidence}`).join(',');

  gates.axesEvolved = prevAxesStr !== newAxesStr;
  console.log(`  Gate 7 (evolved): ${gates.axesEvolved ? '✓' : '✗'} (${o2Ms}ms)`);
  console.log(`    Before: ${prevAxesStr}`);
  console.log(`    After:  ${newAxesStr}`);
  writeFileSync(`${OUT}/${label}/oracle-2.json`, JSON.stringify(session.synthesis, null, 2));

  // ── Phase 5: Final Round (swipes 9-12) ───────────────────────────

  console.log('\n  ── Phase 5: Final Round (4 swipes) ──\n');

  for (let i = 0; i < 4; i++) {
    const scoutIdx = i % 3;
    const name = SCOUTS[scoutIdx];
    session.queue = [];

    const result = await generateText({
      model: generator, temperature: 1.0,
      output: Output.object({ schema: ScoutOutputSchema }),
      system: scoutPrompt(name, session, scoutHistory[name].slice(0, 3)),
      prompt: 'Generate the next taste probe. Follow the format instruction.',
    });
    const output = result.output;

    const reaction = await simulateSwipe(output.content, output.hypothesis, userProfile);
    session.evidence.push({ content: output.content, hypothesis: output.hypothesis, decision: reaction.decision, latencySignal: reaction.latency_signal });
    if (reaction.decision === 'reject') session.antiPatterns.push(output.hypothesis);
    scoutHistory[name].unshift(output.hypothesis);

    let image = null;
    if (output.format === 'image') {
      console.log(`    ${name}: generating image...`);
      image = await maybeGenerateImage(output);
    }

    saveFacade(label, session.evidence.length, name, output, reaction, image);
    session.facades.push({ swipe: session.evidence.length, name, output, reaction, hasImage: !!image });
    console.log(`    ${name}: [${output.format}] "${output.label}" axis="${output.axis_targeted?.slice(0, 25)}" → ${reaction.decision}${reaction.latency_signal === 'slow' ? '*' : ''}`);
  }

  // ── Builder Final ────────────────────────────────────────────────

  console.log('\n  ── Builder Final ──\n');
  const lastF = session.facades[session.facades.length - 1];
  const bFinStart = Date.now();
  const bFinResult = await generateText({
    model: generator, temperature: 0,
    output: Output.object({ schema: DraftUpdateSchema }),
    system: builderPrompt(session, lastF.output, lastF.reaction.decision),
    prompt: `Swipe #${session.evidence.length}: user ${lastF.reaction.decision}ed "${lastF.output.label}". Generate the final draft.`,
    maxTokens: 3000,
  });
  const bFin = bFinResult.output;
  const bFinMs = Date.now() - bFinStart;

  const hasHtml = /<div|<html/i.test(bFin.html);
  const warmColors = /#[fF][fF]|cream|amber|peach|warm/i.test(bFin.html);
  const hasRadius = /border-radius/i.test(bFin.html);
  gates.builderFinal = hasHtml && bFin.html.length > 100;

  console.log(`  Gate 9 (builder final): "${bFin.title}" ${bFin.html.length} chars html=${hasHtml} warm=${warmColors} radius=${hasRadius} ${gates.builderFinal ? '✓' : '✗'} (${bFinMs}ms)`);
  writeFileSync(`${OUT}/${label}/builder-final.html`, bFin.html);
  writeFileSync(`${OUT}/${label}/builder-final.meta.txt`, `Title: ${bFin.title}\nSummary: ${bFin.summary}\nHint: ${bFin.nextHint}\nAccepted: ${bFin.acceptedPatterns.join(', ')}\nRejected: ${bFin.rejectedPatterns.join(', ')}`);

  // ── Format progression ───────────────────────────────────────────

  const formats = session.facades.map(f => f.output.format);
  const wc = formats.filter(f => f === 'word').length;
  const ic = formats.filter(f => f === 'image').length;
  const mc = formats.filter(f => f === 'mockup').length;
  const hasWords = wc >= 2;
  const hasMockups = mc >= 1;
  gates.formatProgression = hasWords && hasMockups;
  console.log(`\n  Gate 5 (format): ${wc}w ${ic}i ${mc}m ${gates.formatProgression ? '✓' : '✗'}`);

  // ── Evidence shape ───────────────────────────────────────────────

  const accepts = session.evidence.filter(e => e.decision === 'accept').length;
  const rejects = session.evidence.filter(e => e.decision === 'reject').length;
  const hesitant = session.evidence.filter(e => e.latencySignal === 'slow').length;
  gates.evidenceCoherence = rejects >= 2;
  console.log(`  Gate 6 (evidence): ${accepts}a ${rejects}r ${hesitant}h ${gates.evidenceCoherence ? '✓' : '✗'}`);

  // ── Score ────────────────────────────────────────────────────────

  const gateList = [
    ['1. Cold diversity', gates.coldDiversity],
    ['2. Oracle axes', gates.oracleAxes],
    ['3. Assignment diverge', gates.assignDiverge],
    ['5. Format progression', gates.formatProgression],
    ['6. Evidence coherence', gates.evidenceCoherence],
    ['7. Axes evolved', gates.axesEvolved],
    ['8. Builder mid', gates.builderMid],
    ['9. Builder final', gates.builderFinal],
  ];

  const passed = gateList.filter(([, v]) => v).length;
  const total = gateList.length;

  console.log(`\n  ${'═'.repeat(50)}`);
  console.log(`  ${label}: ${passed}/${total} gates`);
  console.log(`  ${'═'.repeat(50)}`);
  for (const [name, v] of gateList) console.log(`    ${v ? '✓' : '✗'} ${name}`);

  writeFileSync(`${OUT}/${label}/session.json`, JSON.stringify({
    intent: INTENT, label, gates, passed, total,
    evidence: session.evidence,
    facades: session.facades.map(f => ({ swipe: f.swipe, scout: f.name, format: f.output.format, label: f.output.label, axis: f.output.axis_targeted, decision: f.reaction.decision, latency: f.reaction.latency_signal })),
  }, null, 2));

  return { label, gates, gateList, passed, total };
}

// ═══════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  FINAL BOSS TEST — Codebase Prompts, Full Loop         ║');
console.log('╚══════════════════════════════════════════════════════════╝');

const coop = await runSession('cooperative', COOPERATIVE_USER);
const adv = await runSession('adversarial', ADVERSARIAL_USER);

console.log(`\n${'═'.repeat(58)}`);
console.log('  FINAL SCORE');
console.log(`${'═'.repeat(58)}\n`);
console.log(`  Cooperative: ${coop.passed}/${coop.total}`);
console.log(`  Adversarial: ${adv.passed}/${adv.total}`);
console.log(`  Combined:    ${coop.passed + adv.passed}/${coop.total + adv.total}`);
console.log(`\n  Facades: ${OUT}/cooperative/ and ${OUT}/adversarial/`);
console.log(`  Builder: ${OUT}/*/builder-{mid,final}.html`);
console.log(`  Oracle:  ${OUT}/*/oracle-{1,2}.json`);
console.log(`  Session: ${OUT}/*/session.json\n`);

writeFileSync(`${OUT}/RESULTS.md`, `# Final Boss Test\n\nDate: ${new Date().toISOString().slice(0, 10)}\n\n## Scores\n\n| Run | Score |\n|-----|-------|\n| Cooperative | ${coop.passed}/${coop.total} |\n| Adversarial | ${adv.passed}/${adv.total} |\n| Combined | ${coop.passed + adv.passed}/${coop.total + adv.total} |\n\n## Gates\n\n### Cooperative\n${coop.gateList.map(([n, v]) => `- ${v ? '✓' : '✗'} ${n}`).join('\n')}\n\n### Adversarial\n${adv.gateList.map(([n, v]) => `- ${v ? '✓' : '✗'} ${n}`).join('\n')}\n`);
