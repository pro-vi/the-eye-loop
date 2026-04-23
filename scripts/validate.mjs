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
			provider_auth_failure_count: providerAuthFailureCount,
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
			error_event_count_before_session_2: errorEventCountBeforeSession2,
			error_event_count_after_session_2: errorEventCountAfterSession2,
			time_from_session_2_to_first_error_ms: timeFromSession2ToFirstErrorMs
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
		`sse_err=${errorEventCount} auth_err=${agentErrorLines.length}`
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
