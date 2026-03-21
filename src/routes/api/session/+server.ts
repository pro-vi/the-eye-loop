import { json } from '@sveltejs/kit';
import { seedSession } from '$lib/server/agents/oracle';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export async function POST({ request }: { request: Request }) {
	const body = await request.json();
	const intent = body?.intent;

	if (!intent || typeof intent !== 'string' || intent.trim().length === 0) {
		return json({ error: 'intent is required' }, { status: 400 });
	}

	const { sessionId } = seedSession(intent.trim());

	// Scouts fill the initial queue — started here by scout ticket (05),
	// not by oracle. "The first probes ARE the seed." (specs/4-akinator.md:139)

	return json({ intent: intent.trim(), sessionId });
}
