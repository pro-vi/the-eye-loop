import { json } from '@sveltejs/kit';
import { readJsonRecord } from '$lib/server/request-json';
import { findSession, handleSessionSwipe } from '$lib/server/session/runtime';
import type { SwipeRecord } from '$lib/context/types';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export async function POST({ request }: { request: Request }) {
	const body = await readJsonRecord(request);
	if (!body) {
		return json({ error: 'Missing facadeId, decision, or latencyMs' }, { status: 400 });
	}

	const { facadeId, decision, latencyMs, sessionId } = body;

	if (
		typeof sessionId !== 'string' ||
		typeof facadeId !== 'string' ||
		!decision ||
		typeof latencyMs !== 'number' ||
		!Number.isFinite(latencyMs) ||
		latencyMs < 0
	) {
		return json({ error: 'Missing sessionId, facadeId, decision, or latencyMs' }, { status: 400 });
	}

	if (decision !== 'accept' && decision !== 'reject') {
		return json({ error: 'decision must be "accept" or "reject"' }, { status: 400 });
	}

	const session = findSession(sessionId);
	if (!session) {
		return json({ error: 'Session not found' }, { status: 404 });
	}

	const facade = session.findFacade(facadeId);
	if (!facade) {
		return json({ error: 'Facade not found' }, { status: 404 });
	}

	const record: SwipeRecord = {
		facadeId,
		agentId: facade.agentId,
		decision,
		latencyMs
	};

	const result = await handleSessionSwipe(session, record);
	if (!result.ok) return json({ error: result.error }, { status: result.status });
	return json(result);
}
