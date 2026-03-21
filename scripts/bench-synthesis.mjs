import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText, Output } from 'ai';
import { z } from 'zod';

process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;

const MODEL = google('gemini-3.1-pro-preview');

const emergentAxisSchema = z.object({
	label: z.string(),
	poleA: z.string(),
	poleB: z.string(),
	confidence: z.enum(['unprobed', 'exploring', 'leaning', 'resolved']),
	leaning_toward: z.string().nullable(),
	evidence_basis: z.string()
});

const synthesisSchema = z.object({
	axes: z.array(emergentAxisSchema),
	edge_case_flags: z.array(z.string()),
	scout_assignments: z.array(
		z.object({
			scout: z.string(),
			probe_axis: z.string(),
			reason: z.string()
		})
	),
	persona_anima_divergence: z.string().nullable()
});

const INTENT = 'personal finance app for millennials';

const EVIDENCE = `1. [ACCEPT] "Companion"
   Hypothesis: Does the user want a tool that feels like a helper or a dashboard?

2. [REJECT] "Precision"
   Hypothesis: Does the user want clinical exactness or something looser?

3. [REJECT (hesitant)] "Ledger"
   Hypothesis: Does the user want traditional accounting aesthetics?

4. [ACCEPT] "Organic Growth"
   Hypothesis: Does the user prefer natural/organic metaphors or mechanical/structured ones?

5. [ACCEPT] "Warmth"
   Hypothesis: Does the user prefer warm or cool color temperature?

6. [REJECT] "Dashboard"
   Hypothesis: Does the user want dense data visualization or focused simplicity?

7. [ACCEPT (hesitant)] "Storytelling"
   Hypothesis: Does the user prefer narrative-driven or data-driven presentation?

8. [REJECT] "Grid"
   Hypothesis: Does the user prefer rigid grid layouts or organic flowing layouts?`;

const PROMPT = `You are the Oracle — the strategic brain of a taste discovery system.

The user said they want to build: "${INTENT}"

FULL EVIDENCE (accept/reject + latency only — no user reasoning):

${EVIDENCE}

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

console.log('Running oracle synthesis with 8 evidence entries...\n');
const start = performance.now();

const result = await generateText({
	model: MODEL,
	output: Output.object({ schema: synthesisSchema }),
	temperature: 0,
	prompt: PROMPT
});

const elapsed = ((performance.now() - start) / 1000).toFixed(1);
console.log(`Done in ${elapsed}s\n`);

const output = result.output;
if (!output) {
	console.error('No output!');
	process.exit(1);
}

console.log('=== EMERGENT AXES ===\n');
for (const axis of output.axes) {
	const lean = axis.leaning_toward ? ` → ${axis.leaning_toward}` : '';
	console.log(`  ${axis.label} [${axis.confidence}${lean}]`);
	console.log(`    ${axis.poleA}  vs  ${axis.poleB}`);
	console.log(`    Evidence: ${axis.evidence_basis}\n`);
}

console.log('=== EDGE CASE FLAGS ===');
console.log(`  ${output.edge_case_flags.length ? output.edge_case_flags.join(', ') : '(none)'}\n`);

console.log('=== SCOUT ASSIGNMENTS ===');
for (const a of output.scout_assignments) {
	console.log(`  ${a.scout} → ${a.probe_axis}: ${a.reason}`);
}

console.log('\n=== PERSONA-ANIMA DIVERGENCE ===');
console.log(`  ${output.persona_anima_divergence ?? '(none detected)'}\n`);

console.log('=== RAW JSON ===');
console.log(JSON.stringify(output, null, 2));
