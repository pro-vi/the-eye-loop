import { json } from '@sveltejs/kit';
import { seedSession } from '$lib/server/agents/oracle';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export async function POST({ request }: { request: Request }) {
	const body = await request.json();
	const intent = body?.intent;

	if (!intent || typeof intent !== 'string' || intent.trim().length === 0) {
		return json({ error: 'intent is required' }, { status: 400 });
	}

	try {
		const { axes, sessionId } = await seedSession(intent.trim());
		return json({ intent: intent.trim(), axes, sessionId });
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Failed to seed session';
		return json({ error: message }, { status: 500 });
	}
}
