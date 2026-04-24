import { json } from '@sveltejs/kit';
import { findSession } from '$lib/server/session/runtime';
import type { SSEEventType, SSEEventMap } from '$lib/context/types';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export function GET({ url }: { url: URL }) {
	const session = findSession(url.searchParams.get('sessionId'));
	if (!session) {
		return json({ error: 'session not found' }, { status: 404 });
	}

	let teardown: (() => void) | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			function send<K extends SSEEventType>(event: K, payload: SSEEventMap[K]) {
				try {
					const sseData = JSON.stringify({ type: event, ...payload });
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${sseData}\n\n`));
				} catch {
					// Client gone
				}
			}

			// Replay current state so late-connecting clients catch up
			if (session.synthesis) {
				send('synthesis-updated', { synthesis: session.synthesis });
			}
			if (session.draft.html) {
				send('draft-updated', { draft: session.draft });
			}
			if (session.evidence.length) {
				send('evidence-updated', {
					evidence: [...session.evidence],
					antiPatterns: session.antiPatterns
				});
			}
			for (const agent of session.agents.values()) {
				send('agent-status', { agent });
			}
			for (const facade of session.facades) {
				send('facade-ready', { facade });
			}
			if (session.lastError) send('error', session.lastError);

			send('queue-updated', { queueStats: session.queueStats });
			send('reveal-prepared', { ready: session.reveal.prepared });
			send('stage-changed', { stage: session.stage, swipeCount: session.swipeCount });

			const cleanupBus = session.onAny(<K extends SSEEventType>(event: K, payload: SSEEventMap[K]) => {
				send(event, payload);
			});

			const keepalive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
				} catch {
					teardown?.();
				}
			}, 15_000);

			teardown = () => {
				clearInterval(keepalive);
				cleanupBus();
			};
		},
		cancel() {
			teardown?.();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
}
