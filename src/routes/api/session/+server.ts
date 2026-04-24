import { json } from '@sveltejs/kit';
import { readJsonRecord } from '$lib/server/request-json';
import { bootstrapSession } from '$lib/server/session/runtime';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export async function POST({ request }: { request: Request }) {
	const body = await readJsonRecord(request);
	const intent = body?.intent;

	if (typeof intent !== 'string' || intent.trim().length === 0) {
		return json({ error: 'intent is required' }, { status: 400 });
	}

	const trimmedIntent = intent.trim();

	const bootstrap = await bootstrapSession(trimmedIntent);
	return json(bootstrap);
}
