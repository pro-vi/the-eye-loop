import { json } from '@sveltejs/kit';
import { context } from '$lib/server/context';
import type { SwipeRecord } from '$lib/context/types';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export async function POST({ request }: { request: Request }) {
	const body: unknown = await request.json();
	if (!isRecord(body)) {
		return json({ error: 'Missing facadeId, decision, or latencyMs' }, { status: 400 });
	}

	const { facadeId, decision, latencyMs } = body;

	if (typeof facadeId !== 'string' || !decision || typeof latencyMs !== 'number') {
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
		decision,
		latencyMs
	};

	// Anti-patterns BEFORE addEvidence so evidence-updated includes them
	if (decision === 'reject') {
		context.antiPatterns.push(facade.hypothesis);
	}

	// Append evidence, emit swipe-result + evidence-updated
	context.addEvidence(record);
	context.markFacadeConsumed(facadeId);

	return json({ ok: true, swipeCount: context.swipeCount, stage: context.stage });
}
