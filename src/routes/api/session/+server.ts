import { json } from '@sveltejs/kit';
import { seedSession } from '$lib/server/agents/oracle';
import { startAllScouts, stopAllScouts } from '$lib/server/agents/scout';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export async function POST({ request }: { request: Request }) {
	const body = await request.json();
	const intent = body?.intent;

	if (!intent || typeof intent !== 'string' || intent.trim().length === 0) {
		return json({ error: 'intent is required' }, { status: 400 });
	}

	stopAllScouts();
	const { sessionId } = seedSession(intent.trim());
	startAllScouts();

	return json({ intent: intent.trim(), sessionId });
}
