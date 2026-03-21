import { json } from '@sveltejs/kit';
import { context } from '$lib/server/context';
import type { SwipeRecord } from '$lib/context/types';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export async function POST({ request }: { request: Request }) {
	const body = await request.json();
	const { facadeId, decision, latencyMs } = body;

	if (!facadeId || !decision || typeof latencyMs !== 'number') {
		return json({ error: 'Missing facadeId, decision, or latencyMs' }, { status: 400 });
	}

	if (decision !== 'accept' && decision !== 'reject') {
		return json({ error: 'decision must be "accept" or "reject"' }, { status: 400 });
	}

	const facade = context.facades.find((f) => f.id === facadeId);
	if (!facade) {
		return json({ error: 'Facade not found' }, { status: 404 });
	}

	const record: SwipeRecord = {
		facadeId,
		agentId: facade.agentId,
		axisId: facade.axisId,
		decision,
		latencyMs
	};

	// Anti-patterns BEFORE addEvidence so anima-updated includes them
	if (decision === 'reject') {
		context.antiPatterns.push(facade.hypothesis);
	}

	// Update context (emits swipe-result and anima-updated on bus)
	context.addEvidence(record);
	context.markFacadeConsumed(facadeId);

	return json({ ok: true, swipeCount: context.swipeCount, stage: context.stage });
}
