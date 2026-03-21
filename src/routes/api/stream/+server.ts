import { onAny } from '$lib/server/bus';
import { context } from '$lib/server/context';
import type { SSEEventType, SSEEventMap } from '$lib/context/types';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export function GET() {
	let teardown: (() => void) | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			function send(event: string, payload: Record<string, unknown>) {
				try {
					const sseData = JSON.stringify({ type: event, ...payload });
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${sseData}\n\n`));
				} catch {
					// Client gone
				}
			}

			// Replay current state so late-connecting clients catch up
			if (context.synthesis) {
				send('synthesis-updated', { synthesis: context.synthesis });
			}
			if (context.draft.html) {
				send('draft-updated', { draft: context.draft });
			}
			if (context.evidence.length) {
				send('evidence-updated', { evidence: [...context.evidence], antiPatterns: context.antiPatterns });
			}
			for (const agent of context.agents.values()) {
				send('agent-status', { agent });
			}

			const cleanupBus = onAny(<K extends SSEEventType>(event: K, payload: SSEEventMap[K]) => {
				send(event, payload as Record<string, unknown>);
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
