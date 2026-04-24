import { json } from '@sveltejs/kit';
import { bootstrapSession } from '$lib/server/session/runtime';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export async function POST({ request }: { request: Request }) {
	const body: unknown = await request.json();
	const intent = isRecord(body) ? body.intent : undefined;

	if (typeof intent !== 'string' || intent.trim().length === 0) {
		return json({ error: 'intent is required' }, { status: 400 });
	}

	const trimmedIntent = intent.trim();

	const bootstrap = await bootstrapSession(trimmedIntent);
	return json(bootstrap);
}
