import { onAny, getLastError } from '$lib/server/bus';
import { context } from '$lib/server/context';
import type { SSEEventType, SSEEventMap } from '$lib/context/types';

export const config = { runtime: 'nodejs22.x', maxDuration: 300 };

export function GET() {
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
			for (const facade of context.facades) {
				send('facade-ready', { facade });
			}
			// Replay the last structured error so a reconnecting client (e.g.
			// EventSource auto-reconnect after Vercel maxDuration=300s cutoff,
			// tab suspend/resume, or transient network blip) re-surfaces the
			// iter-8 banner. Agent-status focus "provider auth failed" already
			// replays via the agents loop above; this closes the parallel gap
			// for the structured error code/source/message the client uses to
			// pick the right CLAUDE_CODE_OAUTH_TOKEN copy.
			const replayErr = getLastError();
			if (replayErr) send('error', replayErr);

			// Replay current stage so a reconnecting client can transition mode
			// correctly. The client's stage-changed handler sets stage + flips
			// mode to 'reveal' when stage==='reveal' — without replay, a late
			// connect during 'mockups' or 'reveal' would leave the UI stuck in
			// the default 'words' mode despite the server advancing the stage.
			// Emit unconditionally: context.stage is always defined, stage ===
			// 'words' on replay is a client-side no-op set, non-default stages
			// are load-bearing for the reveal UX.
			send('stage-changed', { stage: context.stage, swipeCount: context.swipeCount });

			const cleanupBus = onAny(<K extends SSEEventType>(event: K, payload: SSEEventMap[K]) => {
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
