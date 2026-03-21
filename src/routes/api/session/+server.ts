import { json } from '@sveltejs/kit';
import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { context } from '$lib/server/context';
import { emitSessionReady } from '$lib/server/bus';
import type { TasteAxis } from '$lib/context/types';
import { GEMINI_API_KEY } from '$env/static/private';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

const axisSchema = z.object({
	axes: z.array(
		z.object({
			label: z.string(),
			optionA: z.string(),
			optionB: z.string(),
			why: z.string()
		})
	)
});

const SEED_PROMPT = `You are the Oracle for The Eye Loop — a taste discovery system.

The user has stated an intent. Your job is to identify the 5-7 broadest
taste dimensions that will produce the most information in the fewest swipes.

USER INTENT: "{intent}"

RULES:
1. Each axis must be OPERATIONALLY DISTINCT — varying one axis should
   produce visibly different artifacts WITHOUT changing any other axis.
   Test: could a designer adjust this axis independently on a mockup?

2. Each axis has exactly TWO POLES — not a scale, not a spectrum.
   The poles must be concrete enough that a single word or image could
   embody one pole. "More minimal" is not a pole. "Sparse whitespace"
   vs "dense information-packed" is.

3. Prefer MEASURABLE dimensions over subjective ones:
   GOOD: density (sparse vs packed), color temperature (warm vs cool),
         contrast (high-contrast vs muted), motion (static vs animated)
   BAD:  quality (good vs bad), feel (modern vs classic), vibe (calm vs exciting)

4. Axes must be APPROXIMATELY INDEPENDENT at the top level. If axis A
   only matters when axis B takes a specific value, then A is a child
   of B, not a sibling. Top-level axes should matter regardless of how
   siblings resolve.

5. Cover DIFFERENT SENSORY CHANNELS — don't cluster all axes in color
   or all in layout. Spread across: mood/atmosphere, spatial structure,
   color/light, typography, density/complexity, interaction energy.

6. Ground axes in the SPECIFIC INTENT. Generic axes waste the user's
   first swipes. Probe dimensions that matter for THIS product.

7. The first swipes are the MOST VALUABLE — user is freshest, most
   engaged, least fatigued. These axes must cut the broadest uncertainty.
   Save narrow refinement for later stages.

OUTPUT (structured JSON):
{
  "axes": [
    {
      "label": "density",
      "optionA": "sparse, breathing room, key metrics only",
      "optionB": "packed, dashboard-dense, all data visible",
      "why": "runners need quick glance vs deep analysis"
    }
  ]
}`;

export async function POST({ request }: { request: Request }) {
	const body = await request.json();
	const intent = body?.intent;

	if (!intent || typeof intent !== 'string' || intent.trim().length === 0) {
		return json({ error: 'intent is required' }, { status: 400 });
	}

	context.reset();
	context.intent = intent.trim();

	const result = await generateText({
		model: google('gemini-2.5-flash'),
		output: Output.object({ schema: axisSchema }),
		prompt: SEED_PROMPT.replace('{intent}', context.intent),
		temperature: 0
	});

	const generated = result.output;
	if (!generated?.axes?.length) {
		return json({ error: 'Failed to generate axes' }, { status: 500 });
	}

	// Enforce 5-7 axis contract — trim excess, reject too few
	if (generated.axes.length < 5) {
		return json({ error: `Expected 5-7 axes, got ${generated.axes.length}` }, { status: 500 });
	}
	const trimmedAxes = generated.axes.slice(0, 7);

	const axes: TasteAxis[] = trimmedAxes.map((a, i) => ({
		id: `axis-${i}`,
		label: a.label,
		options: [a.optionA, a.optionB] as [string, string],
		confidence: 0,
		evidenceCount: 0
	}));

	context.seedAxes(axes);

	const sessionId = crypto.randomUUID();

	emitSessionReady({ intent: context.intent, axes });

	return json({ intent: context.intent, axes, sessionId });
}
