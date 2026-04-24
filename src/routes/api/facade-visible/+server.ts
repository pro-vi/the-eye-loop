import { json } from '@sveltejs/kit';
import { readJsonRecord } from '$lib/server/request-json';
import { findSession } from '$lib/server/session/runtime';

export async function POST({ request }: { request: Request }) {
	const body = await readJsonRecord(request);
	const facadeId = body?.facadeId;
	const sessionId = body?.sessionId;

	if (typeof sessionId !== 'string' || typeof facadeId !== 'string') {
		return json({ error: 'Missing sessionId or facadeId' }, { status: 400 });
	}

	const session = findSession(sessionId);
	if (!session || !session.findFacade(facadeId)) {
		return json({ error: 'Facade not found' }, { status: 404 });
	}
	return json({ ok: true });
}
