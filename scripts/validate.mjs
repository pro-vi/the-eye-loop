#!/usr/bin/env node
// Ramp stage 2-5 live smoke validator for the Eye Loop V0 demo path.
//
// Boots `vite dev`, opens `/api/stream`, POSTs `/api/session` with a demo
// intent, and collects SSE events for a short window. Writes a structured
// JSON artifact to scripts/findings/validate-<ts>.json (plus a stable
// validate-latest.json). Exit code is discriminative:
//   0  facade-ready AND draft-updated observed (live demo path reachable)
//   1  no facade-ready or no draft-updated (broken provider, broken path)
//   2  harness failure (dev boot timeout, fetch crash, etc.)
//
// Env knobs:
//   VALIDATE_RUN_MS          how long to hold the SSE stream open (default 20000)
//   VALIDATE_BOOT_MS         dev server boot deadline (default 30000)
//   VALIDATE_INTENT          demo intent used in POST /api/session
//   VALIDATE_SECOND_INTENT   if set, POST a SECOND /api/session with this intent
//                            1.5s after session 1 (deliberately inside the 5s
//                            bus dedup window) — turns the validator into a
//                            multi-session probe that exercises cross-session
//                            state isolation (iter-19 palette reset + iter-21
//                            error-dedup reset). Artifact adds session_2 block
//                            + error_event_count_after_session_2 metric; under
//                            broken auth the discriminative invariant is
//                            error_event_count ≈ 2 * distinct agents if session
//                            2 fires fresh agent runs past the dedup clear.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FINDINGS_DIR = resolve(REPO_ROOT, 'scripts/findings');

const RUN_TIMEOUT_MS = Number(process.env.VALIDATE_RUN_MS ?? 20000);
const BOOT_TIMEOUT_MS = Number(process.env.VALIDATE_BOOT_MS ?? 30000);
const DEMO_INTENT =
	process.env.VALIDATE_INTENT ??
	'a personal dashboard for tracking long-term health experiments';
// Multi-session mode: if set, validator POSTs a second /api/session with this
// intent after session 1's errors have fired. This verifies that a subsequent
// session triggers FRESH agent runs (all 6 scouts + oracle + builder re-fire
// against new sessionId), closing the iter-19 single-session-blind-spot for
// cross-session state leaks.
const DEMO_SECOND_INTENT = process.env.VALIDATE_SECOND_INTENT ?? null;
// Deliberately SHORTER than bus.ts ERROR_EMIT_DEDUP_MS (5000) — the iter-21 bus
// fix clears lastErrorEmit on session-ready, so session 2's identical 401s
// must emit even when session 1's tuples are still young. If a future
// iteration reverts the clear, session 2 errors would be suppressed at this
// 1500ms delay and error_event_count_after_session_2 would drop from 8 to 0,
// making this probe a discriminative regression guard for the fix.
const SECOND_SESSION_POST_DELAY_MS = 1500;

const MAX_STORED_EVENTS = 200;
const ERROR_SIGNAL_RE = /401|Invalid bearer|authentication_error|AI_APICall|x-api-key/i;

function nowIso() { return new Date().toISOString(); }
function fileStamp() { return nowIso().replace(/[:.]/g, '-'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseSSEFrame(frame) {
	let event = null;
	const dataLines = [];
	for (const line of frame.split('\n')) {
		if (line.startsWith('event:')) event = line.slice(6).trim();
		else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
	}
	if (!event && dataLines.length === 0) return null;
	const raw = dataLines.join('\n');
	let data = null;
	try { data = raw ? JSON.parse(raw) : null; } catch { data = { _raw: raw }; }
	return { type: event, data };
}

function persistArtifact(artifact) {
	mkdirSync(FINDINGS_DIR, { recursive: true });
	const stamped = resolve(FINDINGS_DIR, `validate-${fileStamp()}.json`);
	const latest = resolve(FINDINGS_DIR, 'validate-latest.json');
	// Embed the stamped path inside the artifact so downstream consumers
	// (search-set.mjs aggregator) can resolve the preserved per-run file
	// instead of the overwritten validate-latest.json pointer.
	const augmented = { ...artifact, artifact_path: stamped };
	const payload = JSON.stringify(augmented, null, 2);
	writeFileSync(stamped, payload);
	writeFileSync(latest, payload);
	console.log(`[validate] artifact: ${stamped}`);
}

async function main() {
	const startedAt = nowIso();
	const t0 = Date.now();

	// Pick a high random port to avoid colliding with the human-facing dev
	// server. Vite will still fall back if the port is taken, but the picked
	// range makes that rare.
	const requestedPort =
		Number(process.env.VALIDATE_PORT) ||
		30000 + Math.floor(Math.random() * 10000);

	const viteBin = resolve(REPO_ROOT, 'node_modules/.bin/vite');
	const devProc = spawn(viteBin, ['dev', '--port', String(requestedPort), '--strictPort'], {
		cwd: REPO_ROOT,
		env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});

	let stdoutBuf = '';
	let stderrBuf = '';
	const stderrLines = [];
	let detectedUrl = null;

	// Strip ANSI escape codes before regex — vite emits them even with
	// FORCE_COLOR=0 on some shells.
	const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

	devProc.stdout.on('data', (chunk) => {
		const text = chunk.toString();
		stdoutBuf += text;
		if (!detectedUrl) {
			const clean = stripAnsi(stdoutBuf);
			const m = clean.match(/http:\/\/localhost:(\d+)/);
			if (m) detectedUrl = `http://localhost:${m[1]}`;
		}
	});
	devProc.stderr.on('data', (chunk) => {
		const text = chunk.toString();
		stderrBuf += text;
		for (const line of text.split('\n')) {
			if (line.trim()) stderrLines.push({ ts_ms: Date.now() - t0, text: line });
		}
	});

	const teardown = () => {
		try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
		setTimeout(() => {
			try { process.kill(-devProc.pid, 'SIGKILL'); } catch {}
		}, 1500).unref();
	};

	process.on('SIGINT', () => { teardown(); process.exit(130); });
	process.on('SIGTERM', () => { teardown(); process.exit(143); });

	// 1. Wait for vite boot output
	const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
	while (!detectedUrl && Date.now() < bootDeadline) await sleep(200);
	if (!detectedUrl) {
		persistArtifact({
			started_at: startedAt,
			finished_at: nowIso(),
			elapsed_ms: Date.now() - t0,
			result: 'FAIL',
			reason: 'dev_server_boot_timeout',
			stdout_tail: stdoutBuf.slice(-4000),
			stderr_tail: stderrBuf.slice(-4000)
		});
		teardown();
		process.exit(2);
	}

	// 2. Wait for HTTP readiness on /
	const httpDeadline = Date.now() + BOOT_TIMEOUT_MS;
	let httpReady = false;
	while (Date.now() < httpDeadline) {
		try {
			const r = await fetch(detectedUrl + '/', { method: 'GET' });
			if (r.status > 0) { httpReady = true; break; }
		} catch {}
		await sleep(250);
	}
	if (!httpReady) {
		persistArtifact({
			started_at: startedAt,
			finished_at: nowIso(),
			elapsed_ms: Date.now() - t0,
			result: 'FAIL',
			reason: 'http_not_ready',
			dev_url: detectedUrl,
			stdout_tail: stdoutBuf.slice(-4000),
			stderr_tail: stderrBuf.slice(-4000)
		});
		teardown();
		process.exit(2);
	}

	// 3. Open SSE first so we catch everything.
	const events = [];
	const firsts = {};
	let streamError = null;
	const streamController = new AbortController();
	const tStreamOpen = Date.now();

	const streamTask = (async () => {
		try {
			const res = await fetch(detectedUrl + '/api/stream', {
				headers: { accept: 'text/event-stream' },
				signal: streamController.signal
			});
			if (!res.ok || !res.body) {
				streamError = `stream status ${res.status}`;
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let sep;
				while ((sep = buf.indexOf('\n\n')) !== -1) {
					const frame = buf.slice(0, sep);
					buf = buf.slice(sep + 2);
					const parsed = parseSSEFrame(frame);
					if (!parsed) continue;
					const relMs = Date.now() - t0;
					if (!firsts[parsed.type]) firsts[parsed.type] = relMs;
					if (events.length < MAX_STORED_EVENTS) {
						events.push({ ts_ms: relMs, type: parsed.type, data: parsed.data });
					}
				}
			}
		} catch (err) {
			if (err?.name !== 'AbortError') streamError = String(err?.message ?? err);
		}
	})();

	// Small gap so SSE is live before we kick the session.
	await sleep(500);

	// 4. POST /api/session
	const tPost = Date.now();
	let sessionStatus = 0;
	let sessionBody = null;
	let sessionError = null;
	try {
		const res = await fetch(detectedUrl + '/api/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ intent: DEMO_INTENT })
		});
		sessionStatus = res.status;
		sessionBody = await res.json().catch(() => null);
	} catch (err) {
		sessionError = String(err?.message ?? err);
	}
	const sessionRttMs = Date.now() - tPost;

	// 5. Swipe watcher — on first facade-ready, mark visible + POST one swipe.
	// This extends the validator to cover the expensive outer channel target
	// (`POST /api/session -> GET /api/stream -> first facade-ready -> one swipe
	// -> draft/synthesis update`). Under current provider_auth_failure no
	// facade arrives so this is a no-op; under healthy auth it exercises the
	// swipe + post-swipe reaction path.
	const swipe = {
		attempted: false,
		facadeId: null,
		facade_ready_at_ms: null,
		posted_at_ms: null,
		rtt_ms: null,
		status: null,
		body: null,
		error: null
	};
	const facadeVisible = {
		attempted: false,
		status: null,
		error: null,
		rtt_ms: null
	};

	// Second-session probe state — only exercised when VALIDATE_SECOND_INTENT
	// is set. Under single-session mode all fields stay null; artifact consumers
	// can treat attempted=false as "not exercised" rather than "failed".
	const session2 = {
		attempted: false,
		intent: DEMO_SECOND_INTENT,
		rtt_ms: null,
		status: null,
		body: null,
		error: null,
		posted_at_ms: null,
		waited_ms: null
	};

	const secondSessionWatcher = (async () => {
		if (!DEMO_SECOND_INTENT) return;
		const deadline = Date.now() + RUN_TIMEOUT_MS;
		// Wait for session 1's session-ready to be observed, so we anchor the
		// dedup-slop sleep to live stream progress rather than wall-clock.
		while (Date.now() < deadline && !streamController.signal.aborted) {
			if (events.some((e) => e.type === 'session-ready')) break;
			await sleep(150);
		}
		if (Date.now() >= deadline || streamController.signal.aborted) return;
		const waitStart = Date.now();
		await sleep(SECOND_SESSION_POST_DELAY_MS);
		session2.waited_ms = Date.now() - waitStart;
		if (Date.now() >= deadline || streamController.signal.aborted) return;
		const tPost2 = Date.now();
		session2.attempted = true;
		session2.posted_at_ms = tPost2 - t0;
		try {
			const res = await fetch(detectedUrl + '/api/session', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ intent: DEMO_SECOND_INTENT })
			});
			session2.status = res.status;
			session2.body = await res.json().catch(() => null);
		} catch (e) {
			session2.error = String(e?.message ?? e);
		}
		session2.rtt_ms = Date.now() - tPost2;
	})();

	const swipeWatcher = (async () => {
		const deadline = Date.now() + RUN_TIMEOUT_MS;
		let facadeEvent = null;
		while (Date.now() < deadline && !streamController.signal.aborted) {
			facadeEvent = events.find((e) => e.type === 'facade-ready');
			if (facadeEvent) break;
			await sleep(150);
		}
		if (!facadeEvent) return;
		const facadeId = facadeEvent?.data?.facade?.id;
		if (typeof facadeId !== 'string') return;
		swipe.facadeId = facadeId;
		swipe.facade_ready_at_ms = facadeEvent.ts_ms;

		const tVis = Date.now();
		facadeVisible.attempted = true;
		try {
			const vr = await fetch(detectedUrl + '/api/facade-visible', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ facadeId })
			});
			facadeVisible.status = vr.status;
		} catch (e) {
			facadeVisible.error = String(e?.message ?? e);
		}
		facadeVisible.rtt_ms = Date.now() - tVis;

		const tSwipe = Date.now();
		swipe.attempted = true;
		swipe.posted_at_ms = tSwipe - t0;
		try {
			const r = await fetch(detectedUrl + '/api/swipe', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ facadeId, decision: 'accept', latencyMs: 600 })
			});
			swipe.status = r.status;
			swipe.body = await r.json().catch(() => null);
		} catch (e) {
			swipe.error = String(e?.message ?? e);
		}
		swipe.rtt_ms = Date.now() - tSwipe;
	})();

	// 6. Hold stream for the observation window.
	await sleep(RUN_TIMEOUT_MS);

	// 6b. Stream-replay probe: open a SECOND /api/stream connection briefly
	// while stream 1 is still live. /api/stream's start() replays the current
	// context state to every new client (agent-status, facades, etc.). Under
	// the broken-auth baseline, the error events that fired during session 1
	// are the banner-surfacing signal for the iter-8 client; without bus.ts
	// preserving lastError across emissions and /api/stream replaying it to
	// reconnecting clients, a late-connecting stream sees agent-status with
	// focus="provider auth failed" but no structured error frame. The probe
	// turns this into a discriminative metric: stream_2_error_event_count=1
	// when replay is wired, 0 when it is not.
	const stream2 = {
		attempted: true,
		opened_at_ms: Date.now() - t0,
		elapsed_ms: null,
		event_counts: {},
		error_event_count: 0,
		agent_status_count: 0,
		stage_changed_count: 0,
		diagnostic_preserved_count: 0,
		error_provider_auth_count: 0,
		agent_status_scout_count: 0,
		agent_status_oracle_count: 0,
		agent_status_builder_count: 0,
		stage_valid_count: 0,
		error_source_valid_count: 0,
		error_code_valid_count: 0,
		error_message_present_count: 0,
		agent_status_valid_count: 0,
		first_event_ms_after_open: null,
		last_event_ms_after_open: null,
		replay_span_ms: null,
		events: [],
		error: null
	};
	{
		const ctrl2 = new AbortController();
		const tS2 = Date.now();
		try {
			const r2 = await fetch(detectedUrl + '/api/stream', {
				headers: { accept: 'text/event-stream' },
				signal: ctrl2.signal
			});
			if (!r2.ok || !r2.body) {
				stream2.error = `status ${r2.status}`;
			} else {
				const reader = r2.body.getReader();
				const decoder = new TextDecoder();
				let buf = '';
				const deadline = Date.now() + 800;
				while (Date.now() < deadline) {
					const remaining = deadline - Date.now();
					if (remaining <= 0) break;
					const timed = new Promise((resolve) =>
						setTimeout(() => resolve({ done: true, value: undefined }), remaining)
					);
					const chunk = await Promise.race([reader.read(), timed]);
					if (!chunk || chunk.done) break;
					buf += decoder.decode(chunk.value, { stream: true });
					let sep;
					while ((sep = buf.indexOf('\n\n')) !== -1) {
						const frame = buf.slice(0, sep);
						buf = buf.slice(sep + 2);
						const parsed = parseSSEFrame(frame);
						if (!parsed) continue;
						stream2.event_counts[parsed.type] =
							(stream2.event_counts[parsed.type] ?? 0) + 1;
						if (parsed.type === 'error') stream2.error_event_count++;
						if (parsed.type === 'agent-status') stream2.agent_status_count++;
						if (parsed.type === 'stage-changed') stream2.stage_changed_count++;
						stream2.events.push({
							ts_ms: Date.now() - t0,
							type: parsed.type,
							data: parsed.data
						});
					}
				}
				try { ctrl2.abort(); } catch {}
			}
		} catch (e) {
			if (e?.name !== 'AbortError') stream2.error = String(e?.message ?? e);
		}
		stream2.elapsed_ms = Date.now() - tS2;
		// Content-level replay probe — complements the count-based probes above
		// by verifying that the replay loop in /api/stream emits CURRENT agent
		// focus values, not stale snapshots. Under the broken-auth baseline,
		// all 8 replayed agents should carry focus='provider auth failed'
		// (from iter-23/24's scout IIFE-return + oracle/builder preservation).
		// This is a distinct code path from the live-emission auth_diagnostic
		// probe: stream 1 observes each setStatus call, stream_2 observes the
		// for-loop over context.agents.values() inside the replay block. A
		// regression that copies agents into a stale snapshot, mutates focus
		// on the way out, or filters the roster would drop this probe while
		// leaving auth_diagnostic_preserved_count intact.
		stream2.diagnostic_preserved_count = stream2.events.filter(
			(e) => e.type === 'agent-status' && e.data?.agent?.focus === 'provider auth failed'
		).length;
		// Content-level replay probe for the structured error event — parallel
		// to diagnostic_preserved_count but for the iter-3 'error' SSEEvent's
		// code field rather than agent-status focus. Under broken-auth, the
		// lone replayed error (from bus.ts:lastError, wired by iter-26) should
		// carry code='provider_auth_failure' matching the iter-3 classifyErrorCode
		// taxonomy. This closes a specific UX-regression class: the iter-8
		// client banner renders code-specific copy (provider_auth_failure shows
		// CLAUDE_CODE_OAUTH_TOKEN guidance), so a replay that flips the code
		// to 'provider_error' / 'generation_error' would silently degrade the
		// banner's actionability. Count-based stream_2_error_event_count (iter-26)
		// stays at 1, diagnostic_preserved_count (iter-29) stays at 8 for the
		// agent-status probe, but this counter drops to 0 — orthogonal signal.
		stream2.error_provider_auth_count = stream2.events.filter(
			(e) => e.type === 'error' && e.data?.code === 'provider_auth_failure'
		).length;
		// Per-role roster breakdown — iter-39 explicitly named this as one of
		// the remaining unprobed fields on stream_2. The total
		// stream_2_agent_status_count=8 probe cannot see roster drift where
		// scouts drop to 3 but oracle+builder inflate to 5 (net 8). Splitting
		// the count by agent.role turns the probe from "total matches" to
		// "each role matches", catching:
		//   - scout roster cardinality regressions (6 scouts → ≠6)
		//   - orchestrator roster regressions (oracle or builder missing)
		//   - role mis-attribution in the replay loop (payload's agent.role
		//     flipped or stripped between emission and wire format)
		// Under the broken-auth baseline the invariant is
		// {scout:6, oracle:1, builder:1} — parallel to iter-14's per-agent
		// attribution pattern on the primary stream, just for the /api/stream
		// replay block's synchronous for-loop over context.agents.values().
		for (const e of stream2.events) {
			if (e.type !== 'agent-status') continue;
			const role = e.data?.agent?.role;
			if (role === 'scout') stream2.agent_status_scout_count++;
			else if (role === 'oracle') stream2.agent_status_oracle_count++;
			else if (role === 'builder') stream2.agent_status_builder_count++;
		}
		// Payload-value membership probes — iter-40 explicitly named stage_changed.stage
		// value validity and error.source membership in the valid trio as the two
		// remaining unprobed content dimensions on stream_2. These close those gaps.
		//
		// stream_2_stage_valid_count: number of replayed stage-changed events whose
		// stage field is a member of the Stage union ('words' | 'mockups' | 'reveal'
		// per src/lib/context/types.ts:5). Under broken-auth baseline, context.stage
		// stays at 'words' and the replay emits { stage: 'words', swipeCount: 0 }
		// exactly once — so the baseline invariant is stream_2_stage_valid_count = 1
		// matching stream_2_stage_changed_count. Regression class: if context.stage
		// is mutated to undefined/null/'' by a reset bug, or if the replay payload
		// is truncated, or if a future Stage union extension leaks an unhandled
		// literal into the wire, the count drops below stream_2_stage_changed_count
		// while the latter stays at 1 — two orthogonal probes for the same event.
		//
		// stream_2_error_source_valid_count: number of replayed structured error
		// events whose source field is a member of the ErrorSource union
		// ('scout' | 'oracle' | 'builder' per types.ts:92). Complementary to
		// iter-39's error_provider_auth_count which probes the code field.
		// Under broken-auth, exactly one replayed error fires (from bus.ts
		// lastError, wired by iter-26), and its source is whichever agent's
		// emitError last won the lastError assignment — reliably one of the
		// valid trio. Baseline invariant: stream_2_error_source_valid_count = 1
		// matching stream_2_error_event_count. Regression class: source being
		// dropped from the payload, mutated to a stale string, or corrupted by
		// a payload-shape refactor would drop this probe while error_event_count
		// (iter-26) and error_provider_auth_count (iter-39) stay at 1.
		const VALID_STAGES = ['words', 'mockups', 'reveal'];
		const VALID_ERROR_SOURCES = ['scout', 'oracle', 'builder'];
		// iter-56: error.code union-membership probe — closes the last unfilled
		// cell in the {primary, stream_2} × {stage, source, code, message}
		// field-validity matrix. Iter-39's stream_2_error_provider_auth_count
		// is a SPECIFIC-VALUE probe (==='provider_auth_failure'); this is its
		// UNION-MEMBERSHIP sibling (∈ ErrorCode union per types.ts:93). The two
		// are orthogonal: under broken-auth they're identical (every code is
		// provider_auth_failure), but a future regression that emits a NEW
		// valid code (provider_error or generation_error from a non-401 failure)
		// would diverge — provider_auth_count drops below event_count while
		// code_valid_count stays at event_count. Conversely, a regression
		// emitting code='unknown' or undefined drops code_valid below
		// provider_auth (which already filters to a specific string).
		const VALID_ERROR_CODES = ['provider_auth_failure', 'provider_error', 'generation_error'];
		stream2.stage_valid_count = stream2.events.filter(
			(e) => e.type === 'stage-changed' && VALID_STAGES.includes(e.data?.stage)
		).length;
		stream2.error_source_valid_count = stream2.events.filter(
			(e) => e.type === 'error' && VALID_ERROR_SOURCES.includes(e.data?.source)
		).length;
		stream2.error_code_valid_count = stream2.events.filter(
			(e) => e.type === 'error' && VALID_ERROR_CODES.includes(e.data?.code)
		).length;
		// iter-54 message-field presence probe — closes the last unprobed field
		// on the iter-3 'error' SSEEvent (message), completing the {source, code,
		// agentId, message} field-validity matrix. Sibling probes:
		//   source:   stream_2_error_source_valid_count (iter-40 above)
		//   code:     stream_2_error_provider_auth_count (iter-39)
		//   agentId:  implicitly via distinct_error_agent_count (iter-14, primary
		//             only — if agentId is dropped, the errorAgentCounts map
		//             collapses from 8 to 3 distinct keys)
		//   message:  THIS — closes the last named cell
		// Under broken-auth baseline, the lone replayed error carries
		// message="Invalid bearer token" (from errorToDiagnostic of the Anthropic
		// 401), so the baseline invariant is stream_2_error_message_present_count=1
		// matching stream_2_error_event_count. Regression class: SSE serializer
		// drops the message field, emitError passes undefined/empty, wire-format
		// rename, payload truncation. Orthogonal to code/source probes — a
		// payload-shape bug that strips JUST the message would leave code and
		// source intact, catching only the iter-8 banner's actionable detail
		// (the human-readable reason text under the code-keyed title).
		stream2.error_message_present_count = stream2.events.filter(
			(e) => e.type === 'error' && typeof e.data?.message === 'string' && e.data.message.length > 0
		).length;
		// iter-58: agent.status union-membership probe — extends iter-41/55/56's
		// typed-union membership family to the 5th and last typed-union field on
		// the agent-status event (agent.status ∈ {'idle','thinking','queued','waiting'}
		// per types.ts:41). Sibling probes on stream_2: stage_valid (iter-41),
		// error_source_valid (iter-41), error_code_valid (iter-56), error_message_present
		// (iter-54), agent per-role count (iter-40). Orthogonal regression class:
		// a regression that emits agent-status with status='running' / 'done' /
		// undefined from a future union extension or a typo in setStatus would
		// leave every count/role/focus probe intact while dropping this probe
		// below stream_2_agent_status_count. Under broken-auth baseline the lone
		// replay emits 8 agent-status events all with status='idle' (post-failure
		// cleanup), so the invariant is stream_2_agent_status_valid_count = 8
		// per intent, matching stream_2_agent_status_count.
		const VALID_AGENT_STATUSES = ['idle', 'thinking', 'queued', 'waiting'];
		stream2.agent_status_valid_count = stream2.events.filter(
			(e) => e.type === 'agent-status' && VALID_AGENT_STATUSES.includes(e.data?.agent?.status)
		).length;
		// Replay-tightness probe — closes iter-34's explicitly-deferred "assert
		// p90-p50<20ms as an additional stability invariant" opportunity, but
		// generalized: the /api/stream start() block emits ALL replay events
		// synchronously in a single tick, so the SPAN between first and last
		// replay event is dominated by JS event-loop granularity (~0-1ms) and
		// the TIME-TO-FIRST-EVENT is dominated by HTTP connect + first-read
		// (~3-5ms). A regression that moves any replay emit into a setTimeout,
		// an await, or a deferred subscription would blow up replay_span_ms
		// from 0 to >10ms and first_event_ms_after_open from ~3ms to whatever
		// the async boundary costs. This is a distinct class of bug from the
		// stream_2 count/content probes (iter-26/27/29): count can stay right,
		// content can stay right, but ordering-within-replay and synchronous-
		// emission-discipline can regress silently. Captured per-run here;
		// promoted to aggregate in search-set.mjs for cross-intent p50/p90/max.
		if (stream2.events.length > 0) {
			const tsList = stream2.events.map((e) => e.ts_ms);
			const firstTs = Math.min(...tsList);
			const lastTs = Math.max(...tsList);
			stream2.first_event_ms_after_open = firstTs - stream2.opened_at_ms;
			stream2.last_event_ms_after_open = lastTs - stream2.opened_at_ms;
			stream2.replay_span_ms = lastTs - firstTs;
		}
	}

	streamController.abort();
	await Promise.all([streamTask, swipeWatcher, secondSessionWatcher]);

	// 7. Teardown dev server.
	teardown();
	await sleep(300);

	// 8. Summarize.
	const eventCounts = {};
	for (const e of events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;

	const facadeReadyCount = eventCounts['facade-ready'] ?? 0;
	const draftUpdatedCount = eventCounts['draft-updated'] ?? 0;
	const synthesisUpdatedCount = eventCounts['synthesis-updated'] ?? 0;
	const swipeResultCount = eventCounts['swipe-result'] ?? 0;
	const evidenceUpdatedCount = eventCounts['evidence-updated'] ?? 0;
	const errorEventCount = eventCounts['error'] ?? 0;
	// Primary-stream agent-status lifecycle volume — complementary to iter-16
	// scout_started_count (distinct scouts that reached 'thinking') and iter-25
	// auth_diagnostic_preserved_count (content of the FINAL focus). This counts
	// ALL agent-status emits on stream 1 (2 pre-session replay + live lifecycle
	// transitions). Under the broken-auth baseline with iter-23/24 no-retry +
	// diagnostic preservation, the expected value is exactly 18 per intent:
	//   2 replay (oracle+builder idle pre-session, emitted to stream 1 on
	//     connect before POST /api/session)
	//   8 thinking transitions (oracle cold-start + builder scaffold + 6 scouts
	//     generating probe, all at ~session-ready)
	//   8 idle/provider-auth-failed transitions (iter-23 scout IIFE-return +
	//     iter-24 oracle/builder preservation)
	// A regression that reintroduces a retry loop under auth failure would add
	// extra thinking/idle transitions per retry, widening the count past 18.
	// A regression of iter-23/24 fall-through would add an extra idle/'' tail
	// per agent, also widening (e.g. 18 → 24 for pre-iter-23 scout pattern).
	// A roster change (adding/removing agents) would shift the base value.
	const agentStatusEventCount = eventCounts['agent-status'] ?? 0;

	// Primary-stream agent-status per-role breakdown — closes the last unprobed
	// orthogonal cell in the {primary, stream_2} × {agent-status, error} × per-
	// role matrix. Landed siblings: iter-31 primary total (agent_status_event_
	// count), iter-40 stream_2 per-role (stream_2_agent_status_{role}_count),
	// iter-44 primary per-role error (error_source_{role}_count). Under the
	// broken-auth baseline with iter-23/24 no-retry + diagnostic preservation,
	// the expected per-intent values decompose as:
	//   scout=12 (6 thinking + 6 idle/provider-auth-failed across 6 scouts)
	//   oracle=3 (1 replay idle at stream connect + 1 thinking cold-start +
	//     1 idle/provider-auth-failed)
	//   builder=3 (1 replay idle at stream connect + 1 thinking scaffold +
	//     1 idle/provider-auth-failed)
	// Sum = 12+3+3 = 18, matching iter-31's total. The per-role decomposition
	// catches regressions the total-only probe cannot: a roster rebalance
	// where one role's cardinality inflates while another drops would keep
	// the total at 18 but shift the per-role values. Under healthy auth the
	// 'provider-auth-failed' idle transitions are replaced by normal lifecycle
	// transitions, so the per-role counts become product-behavior sensors
	// rather than just failure-path cardinality checks.
	let agentStatusScoutCount = 0;
	let agentStatusOracleCount = 0;
	let agentStatusBuilderCount = 0;
	for (const e of events) {
		if (e.type !== 'agent-status') continue;
		const role = e.data?.agent?.role;
		if (role === 'scout') agentStatusScoutCount++;
		else if (role === 'oracle') agentStatusOracleCount++;
		else if (role === 'builder') agentStatusBuilderCount++;
	}

	const agentErrorLines = stderrLines.filter((l) => ERROR_SIGNAL_RE.test(l.text));

	// Reveal reachability — any stage-changed event with stage==='reveal'.
	const revealReached = events.some(
		(e) => e.type === 'stage-changed' && e.data?.stage === 'reveal'
	);

	// Post-swipe latency derivations — only meaningful if we posted a swipe.
	const firstDraftAfterSwipe = swipe.posted_at_ms === null
		? null
		: events.find((e) => e.type === 'draft-updated' && e.ts_ms >= swipe.posted_at_ms)
			?.ts_ms ?? null;
	const firstEvidenceAfterSwipe = swipe.posted_at_ms === null
		? null
		: events.find((e) => e.type === 'evidence-updated' && e.ts_ms >= swipe.posted_at_ms)
			?.ts_ms ?? null;
	const timeToFirstDraftAfterSwipeMs =
		firstDraftAfterSwipe !== null && swipe.posted_at_ms !== null
			? firstDraftAfterSwipe - swipe.posted_at_ms
			: null;
	const timeToFirstEvidenceAfterSwipeMs =
		firstEvidenceAfterSwipe !== null && swipe.posted_at_ms !== null
			? firstEvidenceAfterSwipe - swipe.posted_at_ms
			: null;

	// Typed classification from bus-level error events (preferred over stderr regex).
	const errorEvents = events.filter((e) => e.type === 'error');
	const errorCodeCounts = {};
	const errorSourceCounts = {};
	const errorAgentCounts = {};
	for (const e of errorEvents) {
		const code = e.data?.code ?? 'unknown';
		const src = e.data?.source ?? 'unknown';
		const aid = e.data?.agentId ?? '';
		const key = `${src}:${aid}`;
		errorCodeCounts[code] = (errorCodeCounts[code] ?? 0) + 1;
		errorSourceCounts[src] = (errorSourceCounts[src] ?? 0) + 1;
		errorAgentCounts[key] = (errorAgentCounts[key] ?? 0) + 1;
	}
	// Distinct (source, agentId) tuples — roster completeness probe. Under
	// iter-13's zero-retry-on-auth regime this equals error_event_count
	// exactly (no retry ever fires, each source-agent emits once). Under
	// iter-11 backoff on transient errors, error_event_count exceeds this
	// as retries accumulate. Under provider_auth_failure baseline the
	// expected value is 8 (6 scouts + 1 oracle + 1 builder); a value below
	// 8 flags an agent that failed to start.
	const distinctErrorAgentCount = Object.keys(errorAgentCounts).length;
	const providerAuthFailureCount = errorCodeCounts['provider_auth_failure'] ?? 0;

	// Primary-stream error role-cardinality. iter-14 promoted distinct
	// (source, agentId) tuple count to aggregate; this surfaces the parallel
	// ROLE-level breakdown (collapsing scout-01..06 into a single bucket)
	// from the LIVE error-emission path. Parallel to iter-40's stream_2
	// per-role probe but orthogonal: iter-40 reads context.agents.values()
	// in the replay block (roster state at reconnect), this reads the bus
	// emissions from scout/oracle/builder catch sites (live emission per
	// session). A regression where scout-07 enters the emission path with
	// role='oracle' would keep distinct_error_agent_count=8 (or 9) while
	// flipping these role counters from {scout:6, oracle:1, builder:1} to
	// an imbalanced shape. Under broken-auth baseline the expected values
	// are scout=6, oracle=1, builder=1 per intent.
	const errorSourceScoutCount = errorSourceCounts['scout'] ?? 0;
	const errorSourceOracleCount = errorSourceCounts['oracle'] ?? 0;
	const errorSourceBuilderCount = errorSourceCounts['builder'] ?? 0;

	// iter-54 primary-stream message-field presence probe — symmetric to
	// stream_2.error_message_present_count above, closing the primary side of
	// the {primary, stream_2} × {source, code, agentId, message} error-event
	// field-validity matrix. Under broken-auth baseline all 8 provider_auth_
	// failure errors carry message="Invalid bearer token" (errorToDiagnostic
	// of the Anthropic 401), so the invariant is error_message_present_count
	// = error_event_count = 8. Regression class is orthogonal to iter-44 per-
	// role source probes and iter-14 distinct-agent probes: a serializer bug
	// that strips message ONLY (leaving source/code/agentId intact) would
	// drop this count to 0 while every other error-event probe stays at
	// baseline. Symmetric to iter-25's auth_diagnostic_preserved_count (which
	// probes the agent-status event's focus field for the SAME human-readable
	// reason text) — together the two probes verify that the iter-8 client
	// banner has BOTH the code-keyed title and the human-readable detail
	// preserved end-to-end, via the two disjoint event types that carry it.
	const errorMessagePresentCount = errorEvents.filter(
		(e) => typeof e.data?.message === 'string' && e.data.message.length > 0
	).length;

	// Diagnostic-focus preservation probe — promotes iter-23/24's roster-wide
	// focus-preservation pattern (scout.ts IIFE-return + oracle.runColdStart
	// early-return + builder.scaffold finally-block flag) into a machine-
	// verifiable aggregate invariant. For each agent that emitted a
	// provider_auth_failure error event, check whether its FINAL agent-status
	// focus still reads the diagnostic string 'provider auth failed'. A
	// revert of iter-23 (scouts break through cleanup) drops this from 8 to
	// 2; a revert of iter-24 (oracle/builder tail overwrites) drops to 6; a
	// full revert to pre-iter-23 drops to 0. Under the iter-24 baseline the
	// invariant is auth_diagnostic_preserved_count == distinct_error_agent_count.
	const AUTH_DIAGNOSTIC_FOCUS = 'provider auth failed';
	const finalFocusByAgentKey = {};
	for (const e of events) {
		if (e.type !== 'agent-status') continue;
		const agent = e.data?.agent;
		if (!agent?.id || !agent?.role) continue;
		finalFocusByAgentKey[`${agent.role}:${agent.id}`] = agent.focus ?? '';
	}
	const authFailureAgentKeys = new Set(
		errorEvents
			.filter((e) => e.data?.code === 'provider_auth_failure')
			.map((e) => `${e.data?.source ?? 'unknown'}:${e.data?.agentId ?? ''}`)
	);
	const authDiagnosticPreservedCount = [...authFailureAgentKeys].filter(
		(key) => finalFocusByAgentKey[key] === AUTH_DIAGNOSTIC_FOCUS
	).length;

	// Scout start fan-out — first agent-status `thinking/generating probe` per
	// scout agentId. iter-16 removed the 500ms inter-scout stagger, so the
	// spread between first and last scout start should now be ~10-50ms (JS
	// event-loop tick) instead of ~2500ms. A regression to >200ms would
	// indicate the stagger was re-introduced.
	const scoutStartMs = {};
	for (const e of events) {
		if (e.type !== 'agent-status') continue;
		const agent = e.data?.agent;
		if (agent?.role !== 'scout') continue;
		if (agent.status !== 'thinking') continue;
		if (scoutStartMs[agent.id] !== undefined) continue;
		scoutStartMs[agent.id] = e.ts_ms;
	}
	const scoutStartTimes = Object.values(scoutStartMs);
	const firstScoutStartedMs = scoutStartTimes.length ? Math.min(...scoutStartTimes) : null;
	const lastScoutStartedMs = scoutStartTimes.length ? Math.max(...scoutStartTimes) : null;
	const scoutStartSpreadMs =
		firstScoutStartedMs !== null && lastScoutStartedMs !== null
			? lastScoutStartedMs - firstScoutStartedMs
			: null;
	const scoutStartedCount = scoutStartTimes.length;

	// Error event spread — first-to-last structured error SSE frame. Under
	// iter-13's zero-retry-on-auth regime and the broken-auth baseline,
	// 8 parallel API calls fail together and emit within a ~10-30ms window
	// (JS event loop + per-call Anthropic RTT jitter). A regression that
	// reintroduces retries or serializes provider calls would widen this
	// spread visibly — complementary to scout_start_spread_ms which measures
	// parallel fan-out on the START side, while error_event_spread_ms
	// measures parallel fan-out on the FAIL side.
	const errorEventTimes = errorEvents.map((e) => e.ts_ms);
	const firstErrorEventMs = errorEventTimes.length ? Math.min(...errorEventTimes) : null;
	const lastErrorEventMs = errorEventTimes.length ? Math.max(...errorEventTimes) : null;
	const errorEventSpreadMs =
		firstErrorEventMs !== null && lastErrorEventMs !== null
			? lastErrorEventMs - firstErrorEventMs
			: null;

	const sessionOk = sessionStatus >= 200 && sessionStatus < 300;
	const pass = sessionOk && facadeReadyCount > 0 && draftUpdatedCount > 0;

	// Prefer SSE-derived classification: bus.ts:classifyErrorCode already
	// disambiguates auth / network / generation failures, so the most-frequent
	// emitted code is the true failure mode. Fall back to a stricter stderr
	// regex only if SSE emission was absent (server crashed pre-emit).
	const dominantErrorCode = Object.entries(errorCodeCounts)
		.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
	const AUTH_STDERR_RE = /401|Invalid bearer|authentication_error|x-api-key/i;
	const stderrHasAuth = agentErrorLines.some((l) => AUTH_STDERR_RE.test(l.text));

	let reason;
	if (pass) reason = 'facade_and_draft_observed';
	else if (!sessionOk) reason = 'session_post_not_2xx';
	else if (facadeReadyCount === 0 && dominantErrorCode === 'provider_auth_failure') reason = 'provider_auth_failure';
	else if (facadeReadyCount === 0 && dominantErrorCode === 'provider_error') reason = 'provider_error';
	else if (facadeReadyCount === 0 && dominantErrorCode === 'generation_error') reason = 'generation_error';
	else if (facadeReadyCount === 0 && stderrHasAuth) reason = 'provider_auth_failure';
	else if (facadeReadyCount === 0 && agentErrorLines.length > 0) reason = 'provider_error';
	else if (facadeReadyCount === 0) reason = 'no_facade_ready';
	else reason = 'no_draft_updated';

	const timeToFirstFacadeMs = firsts['facade-ready'] ?? null;
	const timeToFirstDraftMs = firsts['draft-updated'] ?? null;
	const timeToFirstSynthesisMs = firsts['synthesis-updated'] ?? null;

	// Session-relative latencies. Absolute run-start times include the
	// validator's 500ms pre-POST sleep + stream-open overhead, so they are
	// not directly comparable to a human-initiated session. Subtracting
	// time_to_session_ready_ms gives the product-relevant "how fast after
	// POST /api/session did X happen?" — under broken auth,
	// time_from_session_to_first_error_ms ≈ 200-300ms (Anthropic 401 RTT);
	// under healthy auth, time_from_session_to_first_facade_ms would be the
	// Haiku generation latency (~1-2s) and is the V0 demo row 1 target.
	const timeToSessionReadyMs = firsts['session-ready'] ?? null;
	const timeToFirstErrorMs = firstErrorEventMs;
	const timeFromSessionToFirstFacadeMs =
		timeToFirstFacadeMs !== null && timeToSessionReadyMs !== null
			? timeToFirstFacadeMs - timeToSessionReadyMs
			: null;
	const timeFromSessionToFirstDraftMs =
		timeToFirstDraftMs !== null && timeToSessionReadyMs !== null
			? timeToFirstDraftMs - timeToSessionReadyMs
			: null;
	const timeFromSessionToFirstErrorMs =
		timeToFirstErrorMs !== null && timeToSessionReadyMs !== null
			? timeToFirstErrorMs - timeToSessionReadyMs
			: null;

	// iter-50: Stage 8 named metric — oracle_synthesis_latency plus cold-start
	// and reveal-build companions. Derived from oracle agent-status entry/exit
	// pairs (thinking[focus=TARGET] followed by the next idle). Focus strings
	// are set in src/lib/server/agents/oracle.ts at setOracleStatus call sites:
	//   'cold-start analysis'      -> runColdStart (fires on session-ready)
	//   'synthesizing evidence'    -> runSynthesis (every SYNTHESIS_CADENCE swipes)
	//   'building final prototype' -> reveal flow (on REVEAL_THRESHOLD evidence)
	// Under broken-auth baseline only cold-start fires (synthesis needs
	// evidence>0, reveal needs evidence>=15). Under healthy auth the
	// synthesis/reveal latencies will light up as facades + swipes accumulate.
	// The prompt's Stage 8 list names oracle_synthesis_latency specifically;
	// surfacing the three as siblings keeps the naming literal while giving
	// immediate baseline signal from cold-start.
	function computeOracleLatencies(focusTarget) {
		const pairs = [];
		let lastEntry = null;
		for (const e of events) {
			if (e.type !== 'agent-status') continue;
			const agent = e.data?.agent;
			if (agent?.id !== 'oracle') continue;
			if (agent.status === 'thinking' && agent.focus === focusTarget) {
				lastEntry = e.ts_ms;
			} else if (lastEntry !== null && agent.status === 'idle') {
				pairs.push(e.ts_ms - lastEntry);
				lastEntry = null;
			}
		}
		return pairs;
	}
	const oracleColdStartLatencies = computeOracleLatencies('cold-start analysis');
	const oracleSynthesisLatencies = computeOracleLatencies('synthesizing evidence');
	const oracleRevealBuildLatencies = computeOracleLatencies('building final prototype');
	const oracleColdStartLatencyMs = oracleColdStartLatencies[0] ?? null;
	const oracleSynthesisLatencyMs = oracleSynthesisLatencies[0] ?? null;
	const oracleRevealBuildLatencyMs = oracleRevealBuildLatencies[0] ?? null;
	const oracleColdStartCount = oracleColdStartLatencies.length;
	const oracleSynthesisCount = oracleSynthesisLatencies.length;
	const oracleRevealBuildCount = oracleRevealBuildLatencies.length;

	// iter-51: Stage 8 per-agent-class latency siblings for scout + builder,
	// parallel to iter-50's oracle latency primitive but with one structural
	// variant: scouts have 6 distinct ids (scout-01..06) so latencies are
	// derived per-scout-agent and then aggregated within this run (p50/max);
	// builder is a singleton (builder-01) so the derivation matches oracle's
	// single-agent entry/exit pairing. Focus strings are emitted from:
	//   scout.ts:234  setStatus(agent, 'thinking', 'generating probe')
	//   builder.ts:405 setStatus('thinking', 'generating initial scaffold')
	// and their idle transitions happen under the iter-23 (scout IIFE-return)
	// and iter-24 (builder finally-flag) focus-preservation cleanups. Unlike
	// iter-50's synthesis/reveal siblings (which stay null under broken auth
	// because their paths require evidence > 0 or >= REVEAL_THRESHOLD), BOTH
	// scout_probe_latency_ms and builder_scaffold_latency_ms light up under
	// the current baseline — every scout fires exactly one probe on session-
	// ready, fails in ~180ms with 401, and transitions to idle with the
	// diagnostic focus. That makes scout_probe_count a discriminative roster-
	// cardinality probe (equals 6 on healthy fan-out, drops below on roster
	// regressions) and scout_probe_latency_ms_p50/max direct Anthropic RTT
	// observability from the scout-fanout path specifically, complementary
	// to iter-50's oracle cold-start RTT from the oracle path.
	function computeScoutProbeLatencies() {
		const pairs = [];
		const pendingByAgent = {};
		for (const e of events) {
			if (e.type !== 'agent-status') continue;
			const agent = e.data?.agent;
			if (agent?.role !== 'scout' || !agent.id) continue;
			if (agent.status === 'thinking' && agent.focus === 'generating probe') {
				if (pendingByAgent[agent.id] === undefined) pendingByAgent[agent.id] = e.ts_ms;
			} else if (pendingByAgent[agent.id] !== undefined && agent.status !== 'thinking') {
				pairs.push(e.ts_ms - pendingByAgent[agent.id]);
				delete pendingByAgent[agent.id];
			}
		}
		return pairs;
	}
	function computeBuilderScaffoldLatencies() {
		const pairs = [];
		let lastEntry = null;
		for (const e of events) {
			if (e.type !== 'agent-status') continue;
			const agent = e.data?.agent;
			if (agent?.id !== 'builder-01') continue;
			if (agent.status === 'thinking' && agent.focus === 'generating initial scaffold') {
				lastEntry = e.ts_ms;
			} else if (lastEntry !== null && agent.status === 'idle') {
				pairs.push(e.ts_ms - lastEntry);
				lastEntry = null;
			}
		}
		return pairs;
	}
	function pctInline(values, p) {
		const cleaned = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
		if (cleaned.length === 0) return null;
		const sorted = [...cleaned].sort((a, b) => a - b);
		const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
		return sorted[idx];
	}
	const scoutProbeLatencies = computeScoutProbeLatencies();
	const scoutProbeLatencyMsP50 = pctInline(scoutProbeLatencies, 50);
	const scoutProbeLatencyMsMax = scoutProbeLatencies.length ? Math.max(...scoutProbeLatencies) : null;
	const scoutProbeCount = scoutProbeLatencies.length;
	const builderScaffoldLatencies = computeBuilderScaffoldLatencies();
	const builderScaffoldLatencyMs = builderScaffoldLatencies[0] ?? null;
	const builderScaffoldCount = builderScaffoldLatencies.length;

	// Primary-stream stage-changed probe — closes iter-27's explicitly-
	// deferred ordering invariant ("assert stream 1 sees stage-changed
	// exactly once at t < time_to_session_ready_ms"). Under the broken-auth
	// baseline the expected values are:
	//   stage_changed_event_count = 1 (replay fires at connect; context
	//     never advances past 'words' under no facade-ready)
	//   time_to_first_stage_changed_ms ~ 800ms (connect time, before the
	//     validator's 500ms pre-POST sleep + POST /api/session RTT)
	//   stage_changed_before_session_ready = 1 (replay fires AT connect,
	//     session-ready fires AFTER POST /api/session)
	// Complementary to iter-27's stream_2_stage_changed_count probe:
	// stream_2 opens late in the observation window (after session is live)
	// and tests the replay on the SECOND connection; this probe tests the
	// FIRST connection's replay at its natural connect timing. A regression
	// where stage-changed is emitted AFTER session-ready (e.g. moved into
	// the onSessionReady subscriber) would flip stage_changed_before_session_ready
	// to 0 while leaving the count intact - catches a class of bug stream_2
	// cannot see because stream_2 opens after the session-ready boundary.
	const stageChangedEventCount = eventCounts['stage-changed'] ?? 0;
	const timeToFirstStageChangedMs = firsts['stage-changed'] ?? null;
	const stageChangedBeforeSessionReady =
		timeToFirstStageChangedMs !== null &&
		timeToSessionReadyMs !== null &&
		timeToFirstStageChangedMs < timeToSessionReadyMs
			? 1
			: 0;

	// Primary-stream payload-value membership probes — symmetric to iter-41's
	// stream_2_stage_valid_count / stream_2_error_source_valid_count probes on
	// the /api/stream replay block, closing the {primary, stream_2} × {stage-
	// changed.stage, error.source} membership matrix on the PRIMARY stream's
	// live emission path (iter-41 covered only the replay path). A regression
	// that emits a stage-changed with an out-of-union stage ('images', typo,
	// stale pre-rename value) or an error with a non-trio source drops the
	// matching _valid count below its iter-41 sibling on the primary stream,
	// while leaving the replay probe at its baseline (replay snapshot reads
	// context.stage at reconnect, which is type-gated; live emission walks
	// the full runtime history of setStage calls).
	//
	// Under broken-auth baseline the expected values are:
	//   stage_valid_count = 1 (replay at connect emits stage='words')
	//   error_source_valid_count = 8 (6 scouts + oracle + builder, all valid)
	// The error_source_valid_count extends the iter-25 6-way equality invariant
	// into a 7-way equality at 40 under the single-failure-mode regime:
	//   error_event = distinct_agent = provider_auth = auth_diagnostic
	//     = stream_2_agent_status = stream_2_diagnostic = error_source_valid.
	const VALID_STAGES = new Set(['words', 'mockups', 'reveal']);
	const VALID_ERROR_SOURCES = new Set(['scout', 'oracle', 'builder']);
	// iter-56: error.code union-membership probe (primary stream) — symmetric
	// to the stream_2.error_code_valid_count above, completing the {primary,
	// stream_2} × {stage, source, code, message} field-validity matrix that
	// iter-54/iter-55 left with code as the last open cell on both streams.
	// Distinct from provider_auth_failure_count (iter-39 specific-value probe):
	// under broken-auth they're equal (40==40 aggregate), but they diverge under
	// any regime emitting non-auth codes — provider_auth drops, code_valid stays
	// at event_count. Detects emit sites passing untyped strings or stale union
	// values that compile-time checks miss when 'as ErrorCode' suppression is used.
	const VALID_ERROR_CODES = new Set(['provider_auth_failure', 'provider_error', 'generation_error']);
	const stageValidCount = events.filter(
		(e) => e.type === 'stage-changed' && VALID_STAGES.has(e.data?.stage)
	).length;
	const errorSourceValidCount = errorEvents.filter((e) =>
		VALID_ERROR_SOURCES.has(e.data?.source)
	).length;
	const errorCodeValidCount = errorEvents.filter((e) =>
		VALID_ERROR_CODES.has(e.data?.code)
	).length;
	// iter-58: agent.status union-membership probe (primary stream) — symmetric
	// to stream2.agent_status_valid_count above. Extends the iter-41/55/56
	// typed-union membership family from {stage, source, code, message} to
	// {stage, source, code, message, agent.status}, filling the 5th and last
	// typed-union field on any SSE event. Under broken-auth baseline the
	// invariant is agent_status_valid_count = agent_status_event_count = 18
	// per intent (2 replay idle + 8 thinking + 8 idle/provider-auth-failed).
	// Orthogonal to iter-50/51 latency derivation because those match specific
	// focus strings; a 'running' or 'done' status from a typo or a future
	// union extension would still be counted in iter-31 total and iter-52
	// per-role (by agent.role, independent of agent.status) but would drop
	// this probe below agent_status_event_count — an orthogonal regression
	// class the existing probes cannot see.
	const VALID_AGENT_STATUSES = new Set(['idle', 'thinking', 'queued', 'waiting']);
	const agentStatusValidCount = events.filter(
		(e) => e.type === 'agent-status' && VALID_AGENT_STATUSES.has(e.data?.agent?.status)
	).length;

	// Multi-session probe — always computed, but only populated when
	// VALIDATE_SECOND_INTENT is set. session-ready events carry the intent in
	// their data, so we can count distinct sessions and distinct intents
	// directly. Under the broken-auth baseline with multi-session mode, the
	// new discriminative invariant is:
	//   error_event_count ≈ session_ready_count * distinct_error_agent_count
	// A regression where session 2 fails to trigger fresh agent runs (e.g.
	// stopAllScouts + startAllScouts misbehave, or context.reset() leaks
	// state that short-circuits a re-fire) would collapse the ratio toward 1,
	// making it a direct machine-visible signal for the class of bugs iter-19
	// fixed but the single-session-per-subprocess architecture could not see.
	const sessionReadyEvents = events.filter((e) => e.type === 'session-ready');
	const sessionReadyCount = sessionReadyEvents.length;
	const sessionReadyIntents = sessionReadyEvents
		.map((e) => (typeof e.data?.intent === 'string' ? e.data.intent : null))
		.filter((v) => typeof v === 'string');
	const distinctSessionReadyIntents = [...new Set(sessionReadyIntents)];
	const distinctSessionReadyIntentCount = distinctSessionReadyIntents.length;
	// iter-60: session-ready.intent content-presence probe. iter-20 landed
	// session_ready_count + distinct_session_ready_intent_count (identity
	// probe across multi-session boundaries), but never validated each
	// event's intent was a non-empty string — a regression where seedSession
	// emits session-ready with intent undefined/null/empty would keep
	// session_ready_count intact but silently drop this probe. Parallel to
	// iter-54's error_message_present_count pattern (typeof === 'string' &&
	// length > 0) on a distinct event type: session-ready had ZERO
	// content probes before this iteration, unlike agent-status (iter-29/
	// 31/52/58), error (iter-14/39/40/44/54/56) and stage-changed (iter-27/
	// 34/41/55). Under broken-auth baseline: equals session_ready_count
	// (identity invariant — POST /api/session rejects empty intents at the
	// endpoint level and seedSession forwards trimmedIntent to
	// emitSessionReady without mutation).
	const sessionReadyIntentPresentCount = sessionReadyEvents.filter(
		(e) => typeof e.data?.intent === 'string' && e.data.intent.length > 0
	).length;
	const errorEventCountBeforeSession2 =
		session2.posted_at_ms === null
			? null
			: errorEvents.filter((e) => e.ts_ms < session2.posted_at_ms).length;
	const errorEventCountAfterSession2 =
		session2.posted_at_ms === null
			? null
			: errorEvents.filter((e) => e.ts_ms >= session2.posted_at_ms).length;
	// time_from_session_2_to_first_error_ms — session 2's Anthropic 401 RTT,
	// directly comparable to session 1's time_from_session_to_first_error_ms.
	// Under broken auth both should cluster around ~180-270ms (Anthropic 401
	// response time); a large divergence would indicate session 2 hitting a
	// different code path or the bus suppressing fresh errors.
	const firstErrorAfterSession2Ms =
		session2.posted_at_ms === null
			? null
			: errorEvents.find((e) => e.ts_ms >= session2.posted_at_ms)?.ts_ms ?? null;
	const timeFromSession2ToFirstErrorMs =
		firstErrorAfterSession2Ms !== null && session2.posted_at_ms !== null
			? firstErrorAfterSession2Ms - session2.posted_at_ms
			: null;

	const artifact = {
		started_at: startedAt,
		finished_at: nowIso(),
		elapsed_ms: Date.now() - t0,
		result: pass ? 'PASS' : 'FAIL',
		reason,
		intent: DEMO_INTENT,
		dev_url: detectedUrl,
		session: {
			rtt_ms: sessionRttMs,
			status: sessionStatus,
			body: sessionBody,
			error: sessionError
		},
		session_2: session2,
		stream: {
			opened_at_ms: tStreamOpen - t0,
			error: streamError,
			event_counts: eventCounts,
			first_event_ms: firsts,
			events
		},
		stream_2: stream2,
		facade_visible: facadeVisible,
		swipe,
		metrics: {
			time_to_first_facade_ms: timeToFirstFacadeMs,
			time_to_first_draft_ms: timeToFirstDraftMs,
			time_to_first_synthesis_ms: timeToFirstSynthesisMs,
			time_to_first_draft_after_swipe_ms: timeToFirstDraftAfterSwipeMs,
			time_to_first_evidence_after_swipe_ms: timeToFirstEvidenceAfterSwipeMs,
			time_to_session_ready_ms: timeToSessionReadyMs,
			time_to_first_error_ms: timeToFirstErrorMs,
			time_from_session_to_first_facade_ms: timeFromSessionToFirstFacadeMs,
			time_from_session_to_first_draft_ms: timeFromSessionToFirstDraftMs,
			time_from_session_to_first_error_ms: timeFromSessionToFirstErrorMs,
			facade_ready_count: facadeReadyCount,
			draft_updated_count: draftUpdatedCount,
			synthesis_updated_count: synthesisUpdatedCount,
			swipe_result_count: swipeResultCount,
			evidence_updated_count: evidenceUpdatedCount,
			reveal_reached: revealReached,
			error_event_count: errorEventCount,
			error_code_counts: errorCodeCounts,
			error_source_counts: errorSourceCounts,
			error_agent_counts: errorAgentCounts,
			distinct_error_agent_count: distinctErrorAgentCount,
			error_source_scout_count: errorSourceScoutCount,
			error_source_oracle_count: errorSourceOracleCount,
			error_source_builder_count: errorSourceBuilderCount,
			provider_auth_failure_count: providerAuthFailureCount,
			error_message_present_count: errorMessagePresentCount,
			auth_diagnostic_preserved_count: authDiagnosticPreservedCount,
			agent_status_event_count: agentStatusEventCount,
			agent_status_scout_count: agentStatusScoutCount,
			agent_status_oracle_count: agentStatusOracleCount,
			agent_status_builder_count: agentStatusBuilderCount,
			agent_error_signal_count: agentErrorLines.length,
			scout_started_count: scoutStartedCount,
			first_scout_started_ms: firstScoutStartedMs,
			last_scout_started_ms: lastScoutStartedMs,
			scout_start_spread_ms: scoutStartSpreadMs,
			first_error_event_ms: firstErrorEventMs,
			last_error_event_ms: lastErrorEventMs,
			error_event_spread_ms: errorEventSpreadMs,
			session_ready_count: sessionReadyCount,
			distinct_session_ready_intent_count: distinctSessionReadyIntentCount,
			session_ready_intent_present_count: sessionReadyIntentPresentCount,
			error_event_count_before_session_2: errorEventCountBeforeSession2,
			error_event_count_after_session_2: errorEventCountAfterSession2,
			time_from_session_2_to_first_error_ms: timeFromSession2ToFirstErrorMs,
			stream_2_error_event_count: stream2.error_event_count,
			stream_2_agent_status_count: stream2.agent_status_count,
			stream_2_stage_changed_count: stream2.stage_changed_count,
			stream_2_diagnostic_preserved_count: stream2.diagnostic_preserved_count,
			stream_2_error_provider_auth_count: stream2.error_provider_auth_count,
			stream_2_agent_status_scout_count: stream2.agent_status_scout_count,
			stream_2_agent_status_oracle_count: stream2.agent_status_oracle_count,
			stream_2_agent_status_builder_count: stream2.agent_status_builder_count,
			stream_2_stage_valid_count: stream2.stage_valid_count,
			stream_2_error_source_valid_count: stream2.error_source_valid_count,
			stream_2_error_code_valid_count: stream2.error_code_valid_count,
			stream_2_error_message_present_count: stream2.error_message_present_count,
			stream_2_agent_status_valid_count: stream2.agent_status_valid_count,
			stream_2_first_event_ms_after_open: stream2.first_event_ms_after_open,
			stream_2_replay_span_ms: stream2.replay_span_ms,
			stage_changed_event_count: stageChangedEventCount,
			time_to_first_stage_changed_ms: timeToFirstStageChangedMs,
			stage_changed_before_session_ready: stageChangedBeforeSessionReady,
			stage_valid_count: stageValidCount,
			error_source_valid_count: errorSourceValidCount,
			error_code_valid_count: errorCodeValidCount,
			agent_status_valid_count: agentStatusValidCount,
			oracle_cold_start_latency_ms: oracleColdStartLatencyMs,
			oracle_synthesis_latency_ms: oracleSynthesisLatencyMs,
			oracle_reveal_build_latency_ms: oracleRevealBuildLatencyMs,
			oracle_cold_start_count: oracleColdStartCount,
			oracle_synthesis_count: oracleSynthesisCount,
			oracle_reveal_build_count: oracleRevealBuildCount,
			scout_probe_latency_ms_p50: scoutProbeLatencyMsP50,
			scout_probe_latency_ms_max: scoutProbeLatencyMsMax,
			scout_probe_count: scoutProbeCount,
			builder_scaffold_latency_ms: builderScaffoldLatencyMs,
			builder_scaffold_count: builderScaffoldCount
		},
		error_event_samples: errorEvents.slice(0, 8).map((e) => ({
			ts_ms: e.ts_ms,
			source: e.data?.source,
			code: e.data?.code,
			agentId: e.data?.agentId,
			message: e.data?.message
		})),
		provider_error_samples: agentErrorLines.slice(0, 8),
		stderr_tail: stderrBuf.slice(-2000)
	};

	persistArtifact(artifact);
	const sessionSummary = session2.attempted
		? `session1=${sessionStatus} session2=${session2.status} ready=${sessionReadyCount}`
		: `session=${sessionStatus}`;
	console.log(
		`[validate] result=${artifact.result} reason=${reason} ` +
		`${sessionSummary} facades=${facadeReadyCount} drafts=${draftUpdatedCount} ` +
		`synth=${synthesisUpdatedCount} swipe=${swipe.attempted ? swipe.status : 'skipped'} ` +
		`sse_err=${errorEventCount} auth_err=${agentErrorLines.length} ` +
		`err_msg=${errorMessagePresentCount} ` +
		`s1_roles=s${errorSourceScoutCount}/o${errorSourceOracleCount}/b${errorSourceBuilderCount} ` +
		`agent_status=${agentStatusEventCount} ` +
		`agent_status_roles=s${agentStatusScoutCount}/o${agentStatusOracleCount}/b${agentStatusBuilderCount} ` +
		`stage_changed=${stageChangedEventCount} stage_before_ready=${stageChangedBeforeSessionReady} ` +
		`stage_valid=${stageValidCount} err_src_valid=${errorSourceValidCount} err_code_valid=${errorCodeValidCount} ` +
		`agent_status_valid=${agentStatusValidCount} ` +
		`s2_err=${stream2.error_event_count} s2_agents=${stream2.agent_status_count} s2_stage=${stream2.stage_changed_count} s2_diag=${stream2.diagnostic_preserved_count} s2_err_auth=${stream2.error_provider_auth_count} ` +
		`s2_roles=s${stream2.agent_status_scout_count}/o${stream2.agent_status_oracle_count}/b${stream2.agent_status_builder_count} ` +
		`s2_stage_valid=${stream2.stage_valid_count} s2_err_src_valid=${stream2.error_source_valid_count} s2_err_code_valid=${stream2.error_code_valid_count} s2_err_msg=${stream2.error_message_present_count} ` +
		`s2_agent_status_valid=${stream2.agent_status_valid_count} ` +
		`s2_first=${stream2.first_event_ms_after_open}ms s2_span=${stream2.replay_span_ms}ms ` +
		`oracle_cs=${oracleColdStartLatencyMs === null ? '-' : oracleColdStartLatencyMs + 'ms'} ` +
		`oracle_syn=${oracleSynthesisLatencyMs === null ? '-' : oracleSynthesisLatencyMs + 'ms'} ` +
		`oracle_rev=${oracleRevealBuildLatencyMs === null ? '-' : oracleRevealBuildLatencyMs + 'ms'} ` +
		`scout_probe_p50=${scoutProbeLatencyMsP50 === null ? '-' : scoutProbeLatencyMsP50 + 'ms'}/n=${scoutProbeCount} ` +
		`builder_scaffold=${builderScaffoldLatencyMs === null ? '-' : builderScaffoldLatencyMs + 'ms'}/n=${builderScaffoldCount}`
	);
	process.exit(pass ? 0 : 1);
}

main().catch((err) => {
	console.error('[validate] fatal', err);
	try {
		persistArtifact({
			started_at: nowIso(),
			finished_at: nowIso(),
			result: 'FAIL',
			reason: 'harness_exception',
			error: String(err?.stack ?? err)
		});
	} catch {}
	process.exit(2);
});
