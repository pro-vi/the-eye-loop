import { json } from '@sveltejs/kit';
import { emitFacadeVisible } from '$lib/server/bus';

export async function POST({ request }: { request: Request }) {
	const body: unknown = await request.json();
	const facadeId = typeof body === 'object' && body !== null && 'facadeId' in body
		? (body as { facadeId: string }).facadeId
		: null;

	if (typeof facadeId !== 'string') {
		return json({ error: 'Missing facadeId' }, { status: 400 });
	}

	emitFacadeVisible(facadeId);
	return json({ ok: true });
}
