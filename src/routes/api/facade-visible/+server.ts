import { json } from '@sveltejs/kit';
import { findSession } from '$lib/server/session/runtime';

export async function POST({ request }: { request: Request }) {
	const body: unknown = await request.json();
	const isBody = typeof body === 'object' && body !== null;
	const facadeId = isBody && 'facadeId' in body ? body.facadeId : null;
	const sessionId = isBody && 'sessionId' in body ? body.sessionId : null;

	if (typeof sessionId !== 'string' || typeof facadeId !== 'string') {
		return json({ error: 'Missing sessionId or facadeId' }, { status: 400 });
	}

	const session = findSession(sessionId);
	if (!session || !session.findFacade(facadeId)) {
		return json({ error: 'Facade not found' }, { status: 404 });
	}
	return json({ ok: true });
}
