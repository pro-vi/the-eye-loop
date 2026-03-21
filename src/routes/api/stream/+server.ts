import { onAny } from '$lib/server/bus';
import type { SSEEventType, SSEEventMap } from '$lib/context/types';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export function GET() {
	let teardown: (() => void) | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const cleanupBus = onAny(<K extends SSEEventType>(event: K, payload: SSEEventMap[K]) => {
				try {
					const sseData = JSON.stringify({ type: event, ...payload });
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${sseData}\n\n`));
				} catch {
					// Client gone — teardown will clean up
				}
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
