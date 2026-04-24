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
// iter-63 placeholder signature — verbatim from builder.ts:434, used to
// discriminate placeholder-only drafts from LLM-refined drafts (iter-64).
// Hoisted to module scope so both the stream_2 replay-block derivation
// (iter-65) and the primary-stream derivation (iter-64) share one source.
const DRAFT_PLACEHOLDER_SIGNATURE = 'Building your first draft…';

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
		draft_updated_count: 0,
		draft_placeholder_count: 0,
		draft_refined_count: 0,
		// iter-66: the three remaining unprobed cells iter-65 explicitly named
		// — facade-ready, synthesis-updated, evidence-updated — on the /api/stream
		// replay block (+server.ts:24-38). Under iter-61's healthy-auth regime
		// these fire proportional to context state at stream_2 open time:
		// facade-ready once per facade in context.facades, synthesis-updated
		// once if context.synthesis is set, evidence-updated once if
		// context.evidence.length > 0. Under broken-auth (pre-iter-61) all three
		// stay at 0 because no facades/synthesis/evidence accumulate.
		facade_ready_count: 0,
		synthesis_updated_count: 0,
		evidence_updated_count: 0,
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
		agent_status_role_valid_count: 0,
		stage_changed_swipe_count_valid_count: 0,
		// iter-67: facade.format union-membership probe — first content probe
		// on facade-ready (iter-66 added the count; no content probe existed
		// prior). ∈ {'word', 'mockup'} per types.ts:24.
		facade_format_valid_count: 0,
		// iter-88: stream_2 counterparts for iter-72's primary-bus synthesis
		// content probes (synth_axes_count / synth_scout_assignments_count),
		// closing the last unprobed synthesis cells on the /api/stream replay
		// matrix. +server.ts:24-26 replays synthesis-updated once per new
		// client when context.synthesis is set; under iter-61 healthy-auth the
		// cold-start synthesis (oracle.ts:350, fires at ~3-5s) has landed by
		// the time stream_2 opens (~12s), so the replay carries 6 axes and
		// 6 scout_assignments — matching the primary-bus identity. A regression
		// in the replay block that drops the synthesis emit, mutates
		// context.synthesis before replay, or diverges the payload shape from
		// the primary bus would cause these to drop below primary iter-72
		// values while primary stays at identity — two-sided coverage the
		// single-stream primary probes cannot provide.
		synthesis_axes_count: 0,
		synthesis_axes_min: 0,
		synthesis_scout_assignments_count: 0,
		synthesis_scout_assignments_min: 0,
		// iter-89: stream_2 counterparts for iter-81's primary-bus evidence-updated
		// array-shape probes (evidence_array_valid_count, anti_patterns_array_valid_
		// count, evidence_length_min/max), closing one of iter-88's 5 explicitly-
		// named unclosed stream_2 counterpart backlog items. +server.ts:30-32
		// replays evidence-updated once per new client when context.evidence.length
		// > 0; under iter-61 healthy-auth with one accept-swipe the context.ts:93
		// addEvidence emit at ~4-5s lands well before stream_2 opens at ~12s, so
		// the replay carries evidence=[1 item] and antiPatterns=[] — matching
		// primary-bus identity. Regression classes: context.evidence serialized as
		// object (array_valid drops to 0 while iter-66 stream_2_evidence_updated_
		// count holds at 1); replay cloning evidence then truncating the array
		// (length_max drops to 0 while primary holds at 1); antiPatterns stripped
		// from the replay payload (anti_patterns_array_valid drops while evidence_
		// array_valid holds, discriminating the two sides of the payload shape).
		evidence_array_valid_count: 0,
		anti_patterns_array_valid_count: 0,
		evidence_length_min: 0,
		evidence_length_max: 0,
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
						if (parsed.type === 'draft-updated') stream2.draft_updated_count++;
						if (parsed.type === 'facade-ready') stream2.facade_ready_count++;
						if (parsed.type === 'synthesis-updated') stream2.synthesis_updated_count++;
						if (parsed.type === 'evidence-updated') stream2.evidence_updated_count++;
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
		// iter-86: agent.role union-membership probe (stream_2) — companion to
		// iter-58's agent.status probe, closing the 2nd typed-union field on the
		// AgentState payload (agent.role ∈ {'scout','builder','oracle'} per
		// types.ts:40). The existing iter-40 per-role counts (scout/oracle/builder)
		// classify by role equality but fall through silently on any unknown
		// role value, so their sum can drop below stream_2_agent_status_count
		// without any probe firing. This explicit membership probe closes that
		// gap: a future role-union extension leaking 'critic' / 'synth' / ''
		// would keep stream_2_agent_status_count at baseline while dropping
		// agent_status_role_valid_count below it. Under broken-auth baseline
		// stream_2 replays 8 agents (scouts 6 + oracle 1 + builder 1) all with
		// valid roles, so the invariant is stream_2_agent_status_role_valid_count
		// = stream_2_agent_status_count = 8 per intent.
		const VALID_AGENT_ROLES = ['scout', 'builder', 'oracle'];
		stream2.agent_status_role_valid_count = stream2.events.filter(
			(e) => e.type === 'agent-status' && VALID_AGENT_ROLES.includes(e.data?.agent?.role)
		).length;
		// iter-61: stage-changed.swipeCount integer-validity probe (stream_2)
		// — sibling to the primary-stream stageChangedSwipeCountValidCount
		// derivation below. Closes the {primary, stream_2} × {stage, swipeCount}
		// field matrix on the stage-changed event after iter-41/55 covered the
		// stage field on both streams. The /api/stream replay block emits exactly
		// one stage-changed event at connect with { stage: context.stage,
		// swipeCount: context.swipeCount } per +server.ts:57 — under broken-auth
		// baseline context.swipeCount is 0 (never incremented without facades →
		// swipes), so the invariant is stream_2_stage_changed_swipe_count_valid_
		// count = stream_2_stage_changed_count = 1 per intent. Regression class:
		// payload-shape bugs that strip swipeCount from the SSE wire, type-coerce
		// to string, or leak NaN/negative values across sessions — all invisible
		// to iter-41's stage-union probe (which tests the stage field, not this
		// counter). Orthogonal to every existing stream_2 content probe.
		stream2.stage_changed_swipe_count_valid_count = stream2.events.filter(
			(e) =>
				e.type === 'stage-changed' &&
				typeof e.data?.swipeCount === 'number' &&
				Number.isInteger(e.data.swipeCount) &&
				e.data.swipeCount >= 0
		).length;
		// iter-67: facade.format union-membership probe (stream_2) — first content
		// probe on any facade-ready event, breaking the long-standing 66-iteration
		// gap where facade-ready had only count-based probes (iter-66 stream_2_
		// facade_ready_count, primary facadeReadyCount since iter-1). Extends the
		// iter-41/55/56/58/61 typed-union membership family to a NEW event type:
		// facade.format ∈ {'word', 'mockup'} per types.ts:24. Sibling probes:
		//   stage-changed.stage (iter-41/55), error.source (iter-41/55),
		//   error.code (iter-41/56), agent.status (iter-58) — all on other events.
		// Under iter-61's healthy-auth regime with V0 stage='words', every facade
		// scouts produce carries format='word' (no stage transitions to 'mockups'
		// in the 10-14s validator window), so the invariant is
		//   stream_2_facade_format_valid_count = stream_2_facade_ready_count = 6
		// per intent. Regression class orthogonal to iter-66 count probes: a
		// regression that emits facade-ready with format=undefined (stripped from
		// payload), format='image' (typo / stale literal from iter-12 cleanup),
		// or format=null (serialization bug) would leave stream_2_facade_ready_
		// count at 6 while dropping this probe below 6 — the exact regression
		// class typed-union probes are designed to catch. Forward-deploy signal:
		// when a future product iteration introduces mockup-format facades in
		// Stage='mockups', this probe continues to hold identity with the count
		// because 'mockup' is a valid union value.
		const VALID_FACADE_FORMATS = ['word', 'mockup'];
		stream2.facade_format_valid_count = stream2.events.filter(
			(e) => e.type === 'facade-ready' && VALID_FACADE_FORMATS.includes(e.data?.facade?.format)
		).length;
		// iter-88: synthesis content-validation probes on stream_2 replay —
		// stream_2 counterparts for iter-72's primary-bus synthesis axes +
		// scout_assignments count probes, closing the last synthesis replay
		// cells on the /api/stream snapshot matrix. Mirror pattern of iter-66
		// (which closed the stream_2 facade_ready + synthesis_updated +
		// evidence_updated counts) and iter-67 (which added stream_2 facade
		// format_valid alongside the primary). Under iter-61 healthy-auth
		// 5-intent baseline, +server.ts:24-26 replays the cold-start synthesis
		// payload once per connection (at stream_2 open ~12s, synthesis fired
		// at ~3-5s so it's already in context), so per-intent identity is:
		//   stream_2_synthesis_axes_count = 6 (matches iter-72 primary)
		//   stream_2_synthesis_axes_min = 6
		//   stream_2_synthesis_scout_assignments_count = 6 (matches primary)
		//   stream_2_synthesis_scout_assignments_min = 6
		// Aggregate (5 intents): both _sum=30, both _min=6 — matching
		// iter-72's primary synthesis_axes_count_sum=30 / _min=6.
		// Regression classes these probes catch that primary iter-72 alone
		// cannot: a bug in the replay block that emits synthesis-updated
		// without the axes array (iter-66's stream_2_synthesis_updated_count
		// still fires at 1, but axes_count drops to 0); replay serializing
		// synthesis as {synthesis: null} or omitting the field (axes_count
		// at 0 but synthesis_updated_count still at 1); replay cloning
		// synthesis into a stale snapshot that mutates before serialization
		// (axes_min drops to 5 while primary stays at 6). Orthogonal to the
		// primary-bus iter-72 probes: primary counts ALL synthesis-updated
		// payloads as they fire; stream_2 counts only the snapshot at
		// connect time — cross-stream divergence pinpoints replay-block
		// bugs invisible to single-stream probes.
		{
			const stream2SynthesisEvents = stream2.events.filter(
				(e) => e.type === 'synthesis-updated'
			);
			let s2SynthesisAxesMin = stream2SynthesisEvents.length > 0 ? Infinity : 0;
			let s2SynthesisScoutAssignmentsMin =
				stream2SynthesisEvents.length > 0 ? Infinity : 0;
			for (const ev of stream2SynthesisEvents) {
				const axes = ev.data?.synthesis?.axes;
				const assignments = ev.data?.synthesis?.scout_assignments;
				const axesLen = Array.isArray(axes) ? axes.length : 0;
				const assignmentsLen = Array.isArray(assignments) ? assignments.length : 0;
				stream2.synthesis_axes_count += axesLen;
				stream2.synthesis_scout_assignments_count += assignmentsLen;
				if (axesLen < s2SynthesisAxesMin) s2SynthesisAxesMin = axesLen;
				if (assignmentsLen < s2SynthesisScoutAssignmentsMin)
					s2SynthesisScoutAssignmentsMin = assignmentsLen;
			}
			stream2.synthesis_axes_min =
				s2SynthesisAxesMin === Infinity ? 0 : s2SynthesisAxesMin;
			stream2.synthesis_scout_assignments_min =
				s2SynthesisScoutAssignmentsMin === Infinity
					? 0
					: s2SynthesisScoutAssignmentsMin;
		}
		// iter-89: evidence-updated array-shape probes on stream_2 replay —
		// stream_2 counterparts for iter-81's primary-bus evidence_array_valid,
		// anti_patterns_array_valid, and evidence_length min/max probes. Mirror
		// pattern of iter-88 (synthesis axes/scout_assignments count+min). Under
		// iter-61 healthy-auth 5-intent baseline, +server.ts:30-32 replays
		// evidence-updated once when context.evidence.length > 0; context.ts:93
		// addEvidence emits at ~4-5s (well before stream_2 opens at ~12s) and
		// persists context.evidence with 1 item, so per-intent identity under
		// 1-swipe baseline is:
		//   stream_2_evidence_array_valid_count = 1 (matches iter-81 primary)
		//   stream_2_anti_patterns_array_valid_count = 1 (matches primary)
		//   stream_2_evidence_length_min = stream_2_evidence_length_max = 1
		// Aggregate (5 intents): both _valid sums=5/_min=1; length min=max=1.
		// Regression classes this catches that iter-81 primary alone cannot:
		// replay-block bug that serializes context.evidence as object (stream_2
		// array_valid drops to 0 while primary array_valid stays at 5 — iter-66
		// stream_2_evidence_updated_count still fires at 5 but payload shape
		// corrupted); replay cloning evidence and truncating (length_max drops
		// to 0 while primary holds at 1); replay stripping antiPatterns field
		// (anti_patterns_array_valid drops to 0 while evidence_array_valid holds,
		// discriminating the two sides of the payload).
		{
			const stream2EvidenceEvents = stream2.events.filter(
				(e) => e.type === 'evidence-updated'
			);
			let s2EvidenceLengthMin = stream2EvidenceEvents.length > 0 ? Infinity : 0;
			let s2EvidenceLengthMax = 0;
			for (const ev of stream2EvidenceEvents) {
				const evidenceArr = ev.data?.evidence;
				const antiArr = ev.data?.antiPatterns;
				if (Array.isArray(evidenceArr)) {
					stream2.evidence_array_valid_count++;
					if (evidenceArr.length < s2EvidenceLengthMin) s2EvidenceLengthMin = evidenceArr.length;
					if (evidenceArr.length > s2EvidenceLengthMax) s2EvidenceLengthMax = evidenceArr.length;
				}
				if (Array.isArray(antiArr)) stream2.anti_patterns_array_valid_count++;
			}
			stream2.evidence_length_min =
				s2EvidenceLengthMin === Infinity ? 0 : s2EvidenceLengthMin;
			stream2.evidence_length_max = s2EvidenceLengthMax;
		}
		// iter-65: draft-replay placeholder/refined discriminator (stream_2
		// mirror of iter-64's primary-stream split). Under iter-61's healthy-auth
		// regime the /api/stream replay block emits draft-updated when
		// context.draft.html is non-empty (+server.ts:27-29). iter-63's pre-try
		// synchronous placeholder guarantees context.draft.html is set at
		// session-ready, so stream_2 reliably replays a draft. This pair splits
		// that replay into placeholder (html contains builder.ts:434's signature)
		// vs refined (does not), yielding identity invariant on the replay path:
		//   stream_2_draft_placeholder_count + stream_2_draft_refined_count
		//     === stream_2_draft_updated_count
		// Under current healthy-auth baseline with 14s window, scaffold completes
		// after stream_2 opens (opens at ~13s, scaffold at ~10-18s), so the
		// replayed draft is the placeholder — expected values are
		// {_updated: 1, _placeholder: 1, _refined: 0}. Regression classes:
		//   - iter-63 placeholder revert: _placeholder drops to 0, _updated drops
		//     to 0 (context.draft.html never set at session-ready).
		//   - /api/stream replay of draft-updated regression (+server.ts:27-29
		//     gate broken): _updated drops to 0, both sub-counts drop to 0.
		//   - stream_2 connects AFTER scaffold completes (future latency win):
		//     _refined flips to 1, _placeholder stays 1 if placeholder draft is
		//     archived as a separate context.drafts array, or drops to 0 if
		//     context.draft is mutated in place (current implementation).
		// Orthogonal to primary-stream iter-64 split: primary counts ALL
		// draft-updated emissions (every event as it fires); stream_2 counts
		// only the SNAPSHOT replay at connect time. A regression in the replay
		// block that drops draft-updated while primary emission continues would
		// leave iter-64's primary split at {placeholder: 1, refined: 0} while
		// this stream_2 split collapses to {_updated: 0, _placeholder: 0,
		// _refined: 0} — two-sided coverage for iter-63's product fix.
		stream2.draft_placeholder_count = stream2.events.filter(
			(e) =>
				e.type === 'draft-updated' &&
				typeof e.data?.draft?.html === 'string' &&
				e.data.draft.html.includes(DRAFT_PLACEHOLDER_SIGNATURE)
		).length;
		stream2.draft_refined_count = stream2.events.filter(
			(e) =>
				e.type === 'draft-updated' &&
				typeof e.data?.draft?.html === 'string' &&
				!e.data.draft.html.includes(DRAFT_PLACEHOLDER_SIGNATURE)
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

	// iter-64 draft refinement discriminator — iter-63's placeholder emission
	// makes draft_updated_count >= 1 achievable on any session-ready (pre-try
	// placeholder in builder.ts:428-436), so the existing pass predicate
	// `sessionOk && facadeReadyCount > 0 && draftUpdatedCount > 0` accepts
	// placeholder-only runs as PASS. That correctly reflects the V0 "pane never
	// empty" row but does NOT verify that the LLM scaffold or rebuild ever
	// replaced the placeholder with generated content. These two probes split
	// draft-updated emissions into placeholder (html contains the literal
	// 'Building your first draft…' signature from builder.ts:434) vs refined
	// (html does not), yielding identity invariant:
	//   draft_placeholder_count + draft_refined_count === draft_updated_count
	// Under the current healthy-auth baseline (iter-63 landed, 10s window)
	// expected values are placeholder=1, refined=0, draft_updated=1 — scaffold
	// fires at ~session-ready, Haiku scaffold+rebuild rarely complete within
	// the window. Post-latency-optimization regimes would flip refined >= 1
	// (scaffold Haiku ~10s completes OR swipe triggers rebuild that completes);
	// post-regression regimes where the placeholder is removed (iter-63 revert)
	// flip placeholder to 0 while refined stays 0 — silently regressing the V0
	// pane-never-empty contract. This is the ramp stage 4 discriminative
	// signal named in iter-63's learning: PASS is no longer binary; the two
	// sub-counts discriminate placeholder-only, refined, and empty states.
	// DRAFT_PLACEHOLDER_SIGNATURE hoisted to module scope (iter-65) so stream_2
	// replay-block derivation shares the same signature constant.
	const draftUpdatedEvents = events.filter((e) => e.type === 'draft-updated');
	const draftPlaceholderCount = draftUpdatedEvents.filter((e) => {
		const html = e.data?.draft?.html;
		return typeof html === 'string' && html.includes(DRAFT_PLACEHOLDER_SIGNATURE);
	}).length;
	const draftRefinedCount = draftUpdatedEvents.filter((e) => {
		const html = e.data?.draft?.html;
		return typeof html === 'string' && !html.includes(DRAFT_PLACEHOLDER_SIGNATURE);
	}).length;

	// iter-75: draft refined html length distribution probe. iter-74 reduced
	// Haiku's scaffold output from ~5800-7300 chars (iter-71 observation) to
	// ~4200-5500 chars via a prompt-level length hint in SCAFFOLD_PROMPT, but
	// there was no typed metric to confirm the length intervention holds
	// across future iterations. Converts that ad-hoc observation into a
	// forward-deploy measurement: a regression where Haiku drifts back to
	// verbose outputs (or a future further-reduction intervention) is
	// directly visible at aggregate without requiring manual sample inspection.
	// Distinct from iter-64's count probe (tracks emission cardinality, not
	// size), iter-51/70's latency probes (tracks time, not size), and
	// iter-67/72's content-validation probes (tracks shape, not magnitude).
	// Null when draft_refined_count === 0 (broken-auth or empty-session runs);
	// non-null tier aligns with iter-64's refined >= 1 gating. Inline sort/
	// indexing avoids forward-reference to pctInline (defined later in scope)
	// and matches the stable-on-tie p50 semantics used for iter-51/70 latency.
	const refinedHtmlLengths = draftUpdatedEvents
		.map((e) => e.data?.draft?.html)
		.filter((h) => typeof h === 'string' && !h.includes(DRAFT_PLACEHOLDER_SIGNATURE))
		.map((h) => h.length);
	const refinedHtmlLengthSorted = [...refinedHtmlLengths].sort((a, b) => a - b);
	const draftRefinedHtmlLengthP50 = refinedHtmlLengthSorted.length
		? refinedHtmlLengthSorted[Math.floor(refinedHtmlLengthSorted.length / 2)]
		: null;
	const draftRefinedHtmlLengthMax = refinedHtmlLengthSorted.length
		? refinedHtmlLengthSorted[refinedHtmlLengthSorted.length - 1]
		: null;
	const draftRefinedHtmlLengthMin = refinedHtmlLengthSorted.length
		? refinedHtmlLengthSorted[0]
		: null;

	// iter-76: scaffold-vs-rebuild source split on refined-draft html lengths.
	// iter-75 explicitly named this as a deferred opportunity in its learnings
	// ("a future iteration could split draft_refined_html_length by source") and
	// the current validate-latest.json carries the anchoring live trace: a
	// multi-session run observed draft_refined_html_length_min=1498c vs
	// draft_refined_html_length_max=4222c — a 2.8× gap the collapsed metric
	// blurs. Classification rule: find the most-recent builder-01 agent-status
	// 'thinking' event whose ts_ms is <= draft.ts_ms. If focus='generating
	// initial scaffold' → scaffold-refined; if focus startsWith 'analyzing '
	// (per iter-70's rebuild-latency focus-prefix matcher) → rebuild-refined;
	// otherwise 'unknown' (shouldn't fire under the current agent flow but
	// preserved as a sentinel so a regression that adds a new thinking focus
	// string doesn't silently mis-classify into scaffold or rebuild).
	//
	// Identity invariant under any auth regime:
	//   draft_refined_scaffold_count + draft_refined_rebuild_count
	//     + draft_refined_unknown_count === draft_refined_count
	// The unknown bucket is exposed as a first-class count so future probe
	// extensions (e.g. reveal-build path adding a 'final prototype synthesis'
	// focus that routes through buildRevealDraft) will show as unknown until
	// explicitly classified, surfacing the addition as a probe-coverage gap
	// rather than silently inflating scaffold or rebuild counts.
	//
	// Expected baselines:
	//   default 12s window, healthy-auth: scaffold_count≈5/_min=1 (iter-74's
	//     scaffold-refined draft fires per intent), rebuild_count=0/_min=0
	//     (rebuild typically completes at ~T+20s, past the 12s window).
	//   multi-session 20s window: scaffold_count includes both sessions'
	//     scaffolds; rebuild_count includes swipes that triggered rebuild.
	//     The 1498c/4222c gap from validate-latest.json localizes as:
	//     scaffold_html_length_min=1498 (session 2 scaffold, 17s after start,
	//     anomalously short), rebuild_html_length_p50=4222c (rebuild on
	//     session 2's swipe — healthy output).
	//
	// Regression classes this source-split catches that iter-75's collapsed
	// metric cannot:
	//   - scaffold-specific length regression (e.g. SCAFFOLD_PROMPT's iter-74
	//     hint reverted): scaffold_html_length_p50 drops while rebuild holds.
	//   - rebuild-specific length regression (e.g. SWIPE_PROMPT shortening
	//     under a future intervention): rebuild_html_length_p50 drops while
	//     scaffold holds.
	//   - multi-session stale-scaffold-overwrites-rebuild bug (iter-76's
	//     anchor trace): scaffold_html_length_min collapses below rebuild's
	//     p50 (1498 < 4222), while iter-75's collapsed min drops to 1498
	//     without revealing which source was responsible.
	//
	// Forward-deploy: when the reveal path becomes reachable, adding a third
	// 'reveal' source (via the buildRevealDraft's 'final prototype synthesis'
	// focus) is a one-line extension — the classifier's unknown bucket will
	// transition to reveal-specific, preserving existing scaffold/rebuild
	// invariants byte-equivalent.
	// Single forward pass over the events array, tracking the most-recent
	// builder-01 'thinking' focus. Classification is keyed off the focus that
	// was active AT THE MOMENT the draft-updated event was received — which
	// matches the actual emit ordering in builder.ts: scaffold/rebuild emit
	// draft-updated INSIDE the thinking phase, then the finally block flips
	// to idle, then drainPending may immediately set the next call's thinking
	// focus. Using array index (forward pass) instead of ts_ms comparison is
	// load-bearing because scaffold's draft-updated and the next rebuild's
	// thinking transition routinely land in the same wall-clock millisecond
	// under SSE flush — a ts_ms<= predicate would tie-break onto rebuild and
	// mis-classify scaffold's output as rebuild's. The forward-pass invariant:
	// at the moment of any draft-updated, lastBuilderThinkingFocus reflects
	// the call that produced it.
	const scaffoldRefinedLengths = [];
	const rebuildRefinedLengths = [];
	let draftRefinedUnknownCount = 0;
	{
		let lastBuilderThinkingFocus = null;
		for (const e of events) {
			if (
				e.type === 'agent-status' &&
				e.data?.agent?.id === 'builder-01' &&
				e.data?.agent?.status === 'thinking'
			) {
				lastBuilderThinkingFocus = e.data?.agent?.focus ?? null;
				continue;
			}
			if (e.type !== 'draft-updated') continue;
			const html = e.data?.draft?.html;
			if (typeof html !== 'string') continue;
			if (html.includes(DRAFT_PLACEHOLDER_SIGNATURE)) continue;
			const len = html.length;
			if (lastBuilderThinkingFocus === 'generating initial scaffold') {
				scaffoldRefinedLengths.push(len);
			} else if (
				typeof lastBuilderThinkingFocus === 'string' &&
				lastBuilderThinkingFocus.startsWith('analyzing ')
			) {
				rebuildRefinedLengths.push(len);
			} else {
				draftRefinedUnknownCount++;
			}
		}
	}
	function sortedOrNullInline(arr) {
		return arr.length ? [...arr].sort((a, b) => a - b) : null;
	}
	const scaffoldSorted = sortedOrNullInline(scaffoldRefinedLengths);
	const rebuildSorted = sortedOrNullInline(rebuildRefinedLengths);
	const draftRefinedScaffoldCount = scaffoldRefinedLengths.length;
	const draftRefinedRebuildCount = rebuildRefinedLengths.length;
	const draftRefinedScaffoldHtmlLengthP50 = scaffoldSorted
		? scaffoldSorted[Math.floor(scaffoldSorted.length / 2)]
		: null;
	const draftRefinedScaffoldHtmlLengthMin = scaffoldSorted ? scaffoldSorted[0] : null;
	const draftRefinedScaffoldHtmlLengthMax = scaffoldSorted
		? scaffoldSorted[scaffoldSorted.length - 1]
		: null;
	const draftRefinedRebuildHtmlLengthP50 = rebuildSorted
		? rebuildSorted[Math.floor(rebuildSorted.length / 2)]
		: null;
	const draftRefinedRebuildHtmlLengthMin = rebuildSorted ? rebuildSorted[0] : null;
	const draftRefinedRebuildHtmlLengthMax = rebuildSorted
		? rebuildSorted[rebuildSorted.length - 1]
		: null;

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
	// iter-70: builder rebuild latency, sibling to computeBuilderScaffoldLatencies.
	// Closes the per-class latency gap that iter-69 unblocked: before iter-69 the
	// scaffold's `swipeCount === 0` gate suppressed scaffold output AND no rebuild
	// emission could fire because rebuild completed but its draft-updated emit
	// was masked by the still-busy scaffold; post-iter-69 rebuild produces a
	// distinct measurable Haiku call (~3-12s typical, observed 3154ms in the
	// latest multi-session artifact). Rebuild's focus prefix is set in
	// builder.ts:196 — `analyzing ${decision} on "${facade.label}"` — with
	// decision and label as variable substitutions, so a startsWith filter on
	// 'analyzing ' is the reliable matcher (no other emit site uses this prefix
	// per a roster grep). The next idle/'watching for swipes' on builder-01
	// closes the pair, mirroring iter-51's scaffold pairing topology. Under
	// iter-69 healthy-auth baseline (1 swipe per intent, validate.mjs's
	// swipeWatcher posts exactly one accept), the expected invariant is
	// builder_rebuild_count = 1 per intent; aggregate _sum=5 _min=1 across the
	// 5-intent search-set. Forward-deploy: when multi-swipe support lands the
	// counter scales with swipe count per intent. Orthogonal to iter-51's
	// scaffold latency (different LLM call, different prompt, different gate
	// state) and orthogonal to iter-68's time_to_first_draft_after_swipe_ms
	// (which measures swipe-POST → first draft-updated wall-clock; this measures
	// the agent-status thinking→idle interval which excludes the SSE / event-
	// loop overhead and isolates the Haiku call latency).
	function computeBuilderRebuildLatencies() {
		const pairs = [];
		let lastEntry = null;
		for (const e of events) {
			if (e.type !== 'agent-status') continue;
			const agent = e.data?.agent;
			if (agent?.id !== 'builder-01') continue;
			if (
				agent.status === 'thinking' &&
				typeof agent.focus === 'string' &&
				agent.focus.startsWith('analyzing ')
			) {
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
	const builderRebuildLatencies = computeBuilderRebuildLatencies();
	const builderRebuildLatencyMs = builderRebuildLatencies[0] ?? null;
	const builderRebuildLatencyMsP50 = pctInline(builderRebuildLatencies, 50);
	const builderRebuildLatencyMsMax = builderRebuildLatencies.length
		? Math.max(...builderRebuildLatencies)
		: null;
	const builderRebuildCount = builderRebuildLatencies.length;

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
	// iter-86: agent.role union-membership probe (primary stream) — symmetric
	// to stream2.agent_status_role_valid_count above. Companion to iter-58's
	// agent.status probe, extending typed-union coverage to the 2nd union
	// field on AgentState (agent.role ∈ {'scout','builder','oracle'} per
	// types.ts:40). Iter-52's agentStatusScoutCount/OracleCount/BuilderCount
	// classify by role equality and silently fall through on any unknown role
	// value — their sum can drop below agent_status_event_count without any
	// probe firing. This explicit membership probe closes that gap:
	//   - under broken-auth baseline the invariant is agent_status_role_valid_
	//     count = agent_status_event_count = 18 per intent (2 replay idle + 8
	//     thinking + 8 idle/provider-auth-failed, all with valid roles from
	//     SCOUT_ROSTER / builder / oracle constants).
	//   - under healthy-auth baseline both climb to ~21 per intent but identity
	//     holds across regime shifts.
	// Orthogonal regression: a future role-union extension leaking 'critic' /
	// 'synth' / undefined from a typo or refactor would be invisible to iter-31
	// (total count), iter-52 (per-role count — would just go uncategorized),
	// iter-58 (status probe — role-independent), but drop this probe below
	// agent_status_event_count. Pairs with iter-58 to establish full typed-
	// union coverage on AgentState payload across both streams.
	const VALID_AGENT_ROLES = new Set(['scout', 'builder', 'oracle']);
	const agentStatusRoleValidCount = events.filter(
		(e) => e.type === 'agent-status' && VALID_AGENT_ROLES.has(e.data?.agent?.role)
	).length;
	// iter-61: stage-changed.swipeCount integer-validity probe (primary stream) —
	// closes the last unprobed field on the iter-3 'stage-changed' SSEEvent after
	// iter-41/55 (stage union-membership) filled the stage field on both streams.
	// stage-changed has exactly two payload fields per types.ts:87 — stage and
	// swipeCount — so this completes the {stage, swipeCount} × {primary, stream_2}
	// field matrix on the stage-changed event type. Typed as non-negative integer
	// per the emit sites in oracle.ts:161/301/454 which all pass context.swipeCount
	// (an integer counter incremented in context.onSwipe). Validation predicate
	// matches typeof === 'number' && Number.isInteger && >= 0 to catch:
	//   - field dropped from payload (undefined)
	//   - serialization coerces to string ("0" from JSON stringify of a Date, etc)
	//   - NaN leak from arithmetic bug in swipe counter
	//   - negative leak (off-by-one decrement)
	//   - non-integer float from future schema drift
	// Under broken-auth baseline the primary stream emits exactly 1 stage-changed
	// event (the /api/stream replay at connect with context.swipeCount=0 since
	// context is fresh), so the invariant is stage_changed_swipe_count_valid_count
	// = stage_changed_event_count = 1 per intent. Under healthy auth with swipes,
	// swipeCount advances monotonically and every emission keeps this invariant;
	// this is a strict identity probe that catches payload-shape regressions
	// under ANY auth regime while the iter-55 stage_valid_count catches regressions
	// on the OTHER field of the same event.
	const stageChangedSwipeCountValidCount = events.filter(
		(e) =>
			e.type === 'stage-changed' &&
			typeof e.data?.swipeCount === 'number' &&
			Number.isInteger(e.data.swipeCount) &&
			e.data.swipeCount >= 0
	).length;
	// iter-67: facade.format union-membership probe (primary stream) — symmetric
	// to stream2.facade_format_valid_count above. Extends the iter-41/55/56/58/61
	// typed-union membership family to a NEW event type: facade.format ∈
	// {'word', 'mockup'} per types.ts:24. Before iter-67, facade-ready had ZERO
	// content probes after 66 iterations despite being the most-emitted event
	// type per intent (7/intent under healthy auth, 6 replayed on stream_2).
	// The {'word', 'mockup'} 2-value union parallels iter-41/55's stage 3-value
	// union and iter-58's agent.status 4-value union. Under iter-61's healthy-
	// auth baseline with V0 stage='words', all 7 facades per intent carry
	// format='word', so the identity invariant is facade_format_valid_count =
	// facade_ready_count = 7 per intent (sum=35/5 intents, _min=7). Regression
	// class: a regression that emits facade-ready with format=undefined, format=
	// 'image' (stale literal from pre-iter-12 cleanup), or format=null would
	// leave iter-1's count probe intact at 7 while dropping this probe below 7.
	// Forward-deploy discriminator: when future stages advance context.stage to
	// 'mockups' and scouts emit format='mockup' facades, this probe continues
	// to hold identity because 'mockup' is a valid union value — a desirable
	// property for a baseline-regime-invariant probe.
	const VALID_FACADE_FORMATS = new Set(['word', 'mockup']);
	const facadeFormatValidCount = events.filter(
		(e) => e.type === 'facade-ready' && VALID_FACADE_FORMATS.has(e.data?.facade?.format)
	).length;

	// iter-80: swipe-result content probes — first content probes on the
	// swipe-result event type after 79 iterations of count-only coverage
	// (swipe_result_count landed in iter-18-ish; no payload-shape validation
	// until now). Parallel to iter-67's facade.format probe (first content
	// probe on facade-ready after 66 iterations) — closes the recurring
	// 'event type has count probes but no content probes' harness-completeness
	// gap on another high-signal event.
	//
	// SwipeRecord (types.ts:29-35) exposes TWO typed-union fields ideal for
	// membership probes: decision ∈ {'accept','reject'} (required, set by the
	// client at POST /api/swipe) and latencyBucket ∈ {'fast','slow'} (optional
	// in the type declaration but set unconditionally by context.addEvidence
	// before emitSwipeResult fires — median>0 && latencyMs<median is the 'fast'
	// path, else 'slow', so on the first-swipe-per-session baseline latencyBucket
	// is always 'slow' because sessionMedianLatency starts at 0).
	//
	// Regression classes these probes catch that swipe_result_count alone cannot:
	//   - /api/swipe endpoint drift emits swipe-result without decision (schema
	//     mismatch): swipe_result_count stays intact, swipe_decision_valid_count
	//     drops to 0.
	//   - context.addEvidence bucketing logic breaks (returns undefined or
	//     a non-union value like 'medium'): swipe_result_count stays intact,
	//     swipe_latency_bucket_valid_count drops to 0.
	//   - SSEEventMap derivation misaligns (types.ts:110-112 loses the 'record'
	//     Omit<E,'type'> shape): record payload shows up as undefined on the
	//     wire, both probes collapse to 0 while the count probe holds.
	//
	// Identity invariants under both regimes:
	//   broken-auth: swipe_result_count = 0 (no facade → no swipe to post), so
	//     swipe_decision_valid_count = 0 and swipe_latency_bucket_valid_count = 0.
	//     Identity holds at 0 = 0 = 0.
	//   healthy-auth single-intent: swipe_result_count = 1 (validator posts one
	//     hardcoded accept swipe at line ~358 once facade-ready observed); both
	//     probes = 1. Identity: swipe_decision_valid_count = swipe_latency_bucket
	//     _valid_count = swipe_result_count = 1.
	//   healthy-auth 5-intent aggregate: identity holds at sum=5/_min=1.
	//
	// Forward-deploy discriminator: when future multi-swipe validators land,
	// the identity invariants will hold as long as the same-value probes still
	// map all emissions to valid union members — the probe is regime-invariant
	// just like iter-67's facade_format_valid_count across word/mockup stages.
	const VALID_SWIPE_DECISIONS = new Set(['accept', 'reject']);
	const VALID_LATENCY_BUCKETS = new Set(['fast', 'slow']);
	const swipeDecisionValidCount = events.filter(
		(e) => e.type === 'swipe-result' && VALID_SWIPE_DECISIONS.has(e.data?.record?.decision)
	).length;
	const swipeLatencyBucketValidCount = events.filter(
		(e) => e.type === 'swipe-result' && VALID_LATENCY_BUCKETS.has(e.data?.record?.latencyBucket)
	).length;

	// iter-72: synthesis content-validation probes — first content probes on
	// the synthesis-updated event after 71 iterations of count-only coverage
	// (iter-66 promoted stream_2_synthesis_updated_count, iter-68 promoted
	// primary synthesis_updated_count to aggregate, neither validated payload
	// shape). Parallel to iter-67's facade.format probe (first content probe
	// on facade-ready) and iter-60's session-ready content probe — closes a
	// recurring 'event type has count probes but no payload-shape validation'
	// harness-completeness gap.
	//
	// Under iter-61 healthy-auth baseline, synthesis-updated fires once per
	// intent from oracle.runColdStart (oracle.ts:350) carrying 6 axes + 6
	// scout_assignments derived from intent analysis (poleB="(unknown)",
	// confidence="unprobed", no palette since no evidence yet). Real evidence-
	// synthesis from runSynthesis (oracle.ts:216) only fires after 4+ swipes
	// — unreachable in current 12s validator window — and would carry the
	// palette field plus filled-out poleB.
	//
	// New regression classes these probes catch that synthesis_updated_count
	// alone cannot:
	//   - oracle.runColdStart returns axes=[] from a degraded Haiku call:
	//     synthesis_updated_count stays 1, synthesis_axes_min drops to 0.
	//   - scout_assignments truncated below the 6-scout roster (e.g. Haiku
	//     drops Echo): synthesis_updated_count stays 1, synthesis_scout_
	//     assignments_min drops to 5.
	//   - axes serialized as object instead of array: Array.isArray check
	//     coerces to 0, count probe holds at 1 but min drops to 0.
	//
	// Identity invariants under healthy-auth baseline (cold-start synthesis):
	//   synthesis_axes_count = 6 * synthesis_updated_count = 6 (per intent)
	//   synthesis_axes_min = 6
	//   synthesis_scout_assignments_count = 6 * synthesis_updated_count = 6
	//   synthesis_scout_assignments_min = 6
	const synthesisEvents = events.filter((e) => e.type === 'synthesis-updated');
	let synthesisAxesCount = 0;
	let synthesisScoutAssignmentsCount = 0;
	let synthesisAxesMin = synthesisEvents.length > 0 ? Infinity : 0;
	let synthesisScoutAssignmentsMin = synthesisEvents.length > 0 ? Infinity : 0;
	// iter-83: array-element typed-union probe on synthesis-updated.axes[].
	// confidence — extends iter-82's evidence-updated array-element pattern
	// to a NEW event type, closing iter-82's explicitly-named follow-on:
	// 'Future array-typed payloads (e.g. synthesis.axes[].confidence,
	// synthesis.scout_assignments[].scout) follow the same structural
	// pattern.' EmergentAxis (types.ts:63-70) has confidence as the ONLY
	// typed-union field ∈ {'unprobed', 'exploring', 'leaning', 'resolved'}.
	// Under iter-61 healthy-auth baseline, cold-start synthesis (oracle.ts:
	// 332-349) hard-codes confidence='unprobed' on every axis, so all 6
	// axes per emit carry the valid value. Identity invariant (per intent):
	//   synthesis_axes_valid_confidence_count = synthesis_axes_count = 6
	// Aggregate (5 intents): _sum=30 (= synthesis_axes_count_sum), _min=6.
	// Regression class: a typo'd or null confidence on a single axis from
	// a degraded LLM call (under runSynthesis path, 4+ swipes) would drop
	// this count below synthesis_axes_count while leaving axes_count
	// itself at identity — pinpointing field-level corruption invisible to
	// iter-72's whole-array length probe.
	const VALID_AXIS_CONFIDENCES = new Set(['unprobed', 'exploring', 'leaning', 'resolved']);
	// iter-85: scout-roster-membership probe on synthesis-updated.scout_
	// assignments[].scout — closes iter-83's explicitly-named follow-on
	// ('A future iteration could add scout-roster-membership probe on
	// scout_assignments[].scout, treating the 6 known scout names as a union
	// — orthogonal pattern from iter-83's typed-union on confidence') and
	// pairs with iter-84's schema tightening (oracle.ts:58 z.enum on scout)
	// as the wire-level observe-side complement to iter-84's prevent-side
	// Output.object validation. Parallel pattern-alternation to iter-73→74
	// (spec-coherence→product), iter-79→80 (spec-coherence→probe), and now
	// iter-84→85 (spec-coherence→probe).
	//
	// The roster {Iris, Prism, Lumen, Aura, Facet, Echo} is the cross-file
	// canonical set established by: oracle.ts:58 synthesisSchema.scout_
	// assignments[].scout z.enum (iter-84), oracle.ts:103 coldStartSchema.scout
	// z.enum, oracle.ts:96 SYNTHESIS_PROMPT name list, and scout.ts:33-38
	// SCOUTS[].name consumer constant. types.ts:85 declares scout as open
	// string — so the TypeScript signal is widened at the interface boundary,
	// making the wire-level probe the only layer that enforces roster identity
	// across the chain (schema → emit → consumer). Under iter-61 healthy-auth
	// baseline with cold-start synthesis, all 6 assignments per intent carry
	// valid roster names (cold-start output is iter-79's z.enum-constrained
	// coldStartSchema that maps 1:1 into scout_assignments — h.scout is
	// already roster-constrained at source).
	//
	// Identity invariant (per intent):
	//   synthesis_scout_assignments_valid_scout_count = synthesis_scout_
	//     assignments_count = 6
	// Aggregate (5 intents): _sum=30 (= synthesis_scout_assignments_count_sum
	//   = 6 * synthesis_updated_count_sum), _min=6.
	//
	// Regression class this probe catches that iter-72's whole-array length
	// probe cannot: a future refactor that relaxes iter-84's z.enum back to
	// z.string(), plus an LLM hallucinating an off-roster name ('Nova',
	// 'Flux', ...), would leave synthesis_scout_assignments_count at 30 but
	// drop synthesis_scout_assignments_valid_scout_count below 30 — a direct
	// signal that scout.ts:191's `a.scout === scoutName` silent-fallback path
	// is being exercised. This is the iter-84-named silent-fallback class
	// (validator-level observation pairing with schema-level enforcement).
	const VALID_SCOUT_ROSTER = new Set(['Iris', 'Prism', 'Lumen', 'Aura', 'Facet', 'Echo']);
	let synthesisAxesValidConfidenceCount = 0;
	let synthesisScoutAssignmentsValidScoutCount = 0;
	for (const ev of synthesisEvents) {
		const axes = ev.data?.synthesis?.axes;
		const assignments = ev.data?.synthesis?.scout_assignments;
		const axesLen = Array.isArray(axes) ? axes.length : 0;
		const assignmentsLen = Array.isArray(assignments) ? assignments.length : 0;
		synthesisAxesCount += axesLen;
		synthesisScoutAssignmentsCount += assignmentsLen;
		if (axesLen < synthesisAxesMin) synthesisAxesMin = axesLen;
		if (assignmentsLen < synthesisScoutAssignmentsMin) synthesisScoutAssignmentsMin = assignmentsLen;
		if (Array.isArray(axes)) {
			for (const axis of axes) {
				if (axis && VALID_AXIS_CONFIDENCES.has(axis.confidence)) synthesisAxesValidConfidenceCount++;
			}
		}
		if (Array.isArray(assignments)) {
			for (const assignment of assignments) {
				if (assignment && VALID_SCOUT_ROSTER.has(assignment.scout)) {
					synthesisScoutAssignmentsValidScoutCount++;
				}
			}
		}
	}
	if (synthesisAxesMin === Infinity) synthesisAxesMin = 0;
	if (synthesisScoutAssignmentsMin === Infinity) synthesisScoutAssignmentsMin = 0;

	// iter-81: evidence-updated content probes — first content probes on the
	// evidence-updated event after 80 iterations of count-only coverage
	// (evidence_updated_count promoted by iter-68, stream_2_evidence_updated_
	// count promoted by iter-66; neither validated payload shape). Closes iter-
	// 80's explicitly-named gap: 'evidence-updated (payload = evidence[] +
	// antiPatterns[], both arrays — would need array-shape probes not union-
	// membership)'. Parallel to iter-67's facade.format probe (first content
	// probe on facade-ready), iter-72's synthesis content probes (first content
	// probes on synthesis-updated), and iter-80's swipe-result content probes.
	//
	// SSEEvent shape per types.ts:93: { type:'evidence-updated', evidence:
	// SwipeEvidence[], antiPatterns: string[] } — both fields are array-typed,
	// so iter-67/72/80's union-membership pattern doesn't apply. Instead use
	// Array.isArray presence-validity (catches: payload truncation, JSON.stringify
	// of non-array, undefined leak from a context.evidence reset bug) plus
	// length-distribution min/max (catches: cumulative-state regressions where
	// emit body is the deltas instead of the running total).
	//
	// Emit topology — evidence-updated fires from TWO sites:
	//   context.ts:93   — addEvidence() on every swipe, with evidence as a
	//                     [...this.evidence] snapshot (cumulative running total)
	//                     and antiPatterns as the live reference (may be empty)
	//   builder.ts:374  — rebuild() ONLY IF rebuild's LLM output added new
	//                     anti-patterns; uses the same shape ([...evidence],
	//                     antiPatterns)
	// Under iter-69 healthy-auth + iter-71/74 scaffold improvements, the validator's
	// 12s window with one accept-swipe captures the addEvidence emission (1 swipe
	// → 1 emit, evidence.length=1) but rebuild's evidence-updated rarely fires
	// because: (a) rebuild itself takes ~10s+ so completion lands near window
	// close and (b) addedAntiPatterns is conditional on the LLM output containing
	// rejectedPatterns the user hasn't seen, which the synthetic accept-swipe
	// path may or may not produce.
	//
	// Identity invariants under healthy-auth baseline (12s window, 1 swipe):
	//   evidence_array_valid_count = evidence_updated_count = 1 per intent
	//     (addEvidence's emit always passes a real array; presence-validity
	//     identity holds as long as the wire format preserves array-ness)
	//   anti_patterns_array_valid_count = evidence_updated_count = 1 per intent
	//     (antiPatterns is always an array, even if empty — the [] zero-value
	//     of string[] satisfies Array.isArray identity)
	//   evidence_length_min = evidence_length_max = 1 (single addEvidence emit
	//     after the 1st swipe carries cumulative evidence with length=1)
	// Aggregate (5 intents): _sum=5/_min=1 for both presence-validity probes;
	// evidence_length_min=1, evidence_length_max=1 across cross-intent.
	//
	// Forward-deploy regimes:
	//   - multi-swipe validators land: evidence_length_max grows with swipe
	//     count (cumulative evidence is the running total); presence-validity
	//     probes stay at identity with event count.
	//   - rebuild's evidence-updated emit fires within window (latency win or
	//     wider window): evidence_updated_count climbs to 2 per intent on
	//     intents where rebuild added anti-patterns; both presence-validity
	//     probes track event_count, evidence_length_max stays at 1 (still 1
	//     swipe), but a future antiPatterns_length probe would flip non-zero.
	//
	// Regression classes these probes catch that count probes alone cannot:
	//   - context.evidence accidentally serialized as object (Array.isArray
	//     coerces to false): event_count stays at 1, evidence_array_valid drops
	//     to 0 — exact mirror of the iter-72 'axes serialized as object' case.
	//   - emit-side regression where evidence is replaced with a single
	//     SwipeEvidence object instead of [...evidence]: same as above.
	//   - evidence-as-deltas refactor where each emit carries only the new
	//     entry rather than cumulative state: evidence_array_valid stays at
	//     count, but evidence_length_max stays at 1 even after multi-swipe
	//     extension lands — flagging the semantic regression invisibly to all
	//     count probes.
	//   - antiPatterns stripped from payload (refactor that omits the field
	//     under JSON serialization): event_count stays at 1, anti_patterns_
	//     array_valid drops to 0 while evidence_array_valid holds — orthogonal
	//     to evidence-side regressions.
	const evidenceUpdatedEvents = events.filter((e) => e.type === 'evidence-updated');
	let evidenceArrayValidCount = 0;
	let antiPatternsArrayValidCount = 0;
	let evidenceLengthMin = evidenceUpdatedEvents.length > 0 ? Infinity : 0;
	let evidenceLengthMax = 0;
	// iter-82: array-element typed-union probes on evidence-updated — extend
	// iter-81's array-shape probes (presence-validity + length distribution) to
	// within-array-element field validation. Each SwipeEvidence entry in the
	// evidence[] array has THREE typed-union fields (decision, format,
	// latencySignal) per types.ts:7-15 — same union-membership pattern as iter-
	// 67's Facade.format, iter-80's SwipeRecord.{decision,latencyBucket}, and
	// iter-61's stage-changed.stage. iter-81's learning called this out as
	// 'array-element union-membership' follow-on. Under the 12s window baseline
	// with 1 addEvidence emission per intent carrying a 1-item array, each
	// probe counts 1 valid item per intent (sum=5 at aggregate, _min=1).
	// Identity invariant at item-level: all three counts should equal each
	// other AND equal sum-of-evidence-array-lengths-across-all-events (since
	// every item in a well-formed emission has all three fields valid). Under
	// the current 1-swipe/1-event/1-item baseline, all three equal evidence_
	// updated_count (=evidence_array_valid_count =1 per intent). Regression
	// classes: a single corrupted evidence item (typo'd decision, null format,
	// missing latencySignal) would drop exactly ONE of the three counts below
	// evidence_updated_count while leaving the others at identity, discriminating
	// field-level corruption from whole-event loss.
	const VALID_EVIDENCE_DECISIONS = new Set(['accept', 'reject']);
	const VALID_EVIDENCE_FORMATS = new Set(['word', 'mockup']);
	const VALID_EVIDENCE_LATENCY_SIGNALS = new Set(['fast', 'slow']);
	let evidenceItemsValidDecisionCount = 0;
	let evidenceItemsValidFormatCount = 0;
	let evidenceItemsValidLatencySignalCount = 0;
	for (const ev of evidenceUpdatedEvents) {
		const evidenceArr = ev.data?.evidence;
		const antiArr = ev.data?.antiPatterns;
		if (Array.isArray(evidenceArr)) {
			evidenceArrayValidCount++;
			if (evidenceArr.length < evidenceLengthMin) evidenceLengthMin = evidenceArr.length;
			if (evidenceArr.length > evidenceLengthMax) evidenceLengthMax = evidenceArr.length;
			for (const item of evidenceArr) {
				if (item && VALID_EVIDENCE_DECISIONS.has(item.decision)) evidenceItemsValidDecisionCount++;
				if (item && VALID_EVIDENCE_FORMATS.has(item.format)) evidenceItemsValidFormatCount++;
				if (item && VALID_EVIDENCE_LATENCY_SIGNALS.has(item.latencySignal)) evidenceItemsValidLatencySignalCount++;
			}
		}
		if (Array.isArray(antiArr)) antiPatternsArrayValidCount++;
	}
	if (evidenceLengthMin === Infinity) evidenceLengthMin = 0;

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
			draft_placeholder_count: draftPlaceholderCount,
			draft_refined_count: draftRefinedCount,
			draft_refined_html_length_p50: draftRefinedHtmlLengthP50,
			draft_refined_html_length_max: draftRefinedHtmlLengthMax,
			draft_refined_html_length_min: draftRefinedHtmlLengthMin,
			draft_refined_scaffold_count: draftRefinedScaffoldCount,
			draft_refined_rebuild_count: draftRefinedRebuildCount,
			draft_refined_unknown_count: draftRefinedUnknownCount,
			draft_refined_scaffold_html_length_p50: draftRefinedScaffoldHtmlLengthP50,
			draft_refined_scaffold_html_length_min: draftRefinedScaffoldHtmlLengthMin,
			draft_refined_scaffold_html_length_max: draftRefinedScaffoldHtmlLengthMax,
			draft_refined_rebuild_html_length_p50: draftRefinedRebuildHtmlLengthP50,
			draft_refined_rebuild_html_length_min: draftRefinedRebuildHtmlLengthMin,
			draft_refined_rebuild_html_length_max: draftRefinedRebuildHtmlLengthMax,
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
			stream_2_agent_status_role_valid_count: stream2.agent_status_role_valid_count,
			stream_2_stage_changed_swipe_count_valid_count: stream2.stage_changed_swipe_count_valid_count,
			stream_2_draft_updated_count: stream2.draft_updated_count,
			stream_2_draft_placeholder_count: stream2.draft_placeholder_count,
			stream_2_draft_refined_count: stream2.draft_refined_count,
			// iter-66: final three unprobed cells on stream_2 replay (iter-65
			// explicitly named these as remaining harness-completeness gaps).
			stream_2_facade_ready_count: stream2.facade_ready_count,
			stream_2_synthesis_updated_count: stream2.synthesis_updated_count,
			stream_2_evidence_updated_count: stream2.evidence_updated_count,
			stream_2_facade_format_valid_count: stream2.facade_format_valid_count,
			// iter-88: stream_2 counterparts for iter-72 primary synthesis content
			// probes — mirrors the axes/scout_assignments count pattern from the
			// primary bus onto /api/stream replay snapshot, closing a named
			// harness-completeness gap on the replay matrix.
			stream_2_synthesis_axes_count: stream2.synthesis_axes_count,
			stream_2_synthesis_axes_min: stream2.synthesis_axes_min,
			stream_2_synthesis_scout_assignments_count: stream2.synthesis_scout_assignments_count,
			stream_2_synthesis_scout_assignments_min: stream2.synthesis_scout_assignments_min,
			// iter-89: stream_2 counterparts for iter-81's primary-bus evidence-
			// updated array-shape probes — mirrors evidence_array_valid / anti_
			// patterns_array_valid / evidence_length min/max onto /api/stream
			// replay snapshot, closing one of iter-88's 5 explicitly-named backlog
			// items. Establishes cross-stream identity under healthy-auth 5-intent
			// baseline: stream_2_evidence_array_valid_count = primary = 5/_min=1.
			stream_2_evidence_array_valid_count: stream2.evidence_array_valid_count,
			stream_2_anti_patterns_array_valid_count: stream2.anti_patterns_array_valid_count,
			stream_2_evidence_length_min: stream2.evidence_length_min,
			stream_2_evidence_length_max: stream2.evidence_length_max,
			stream_2_first_event_ms_after_open: stream2.first_event_ms_after_open,
			stream_2_replay_span_ms: stream2.replay_span_ms,
			stage_changed_event_count: stageChangedEventCount,
			time_to_first_stage_changed_ms: timeToFirstStageChangedMs,
			stage_changed_before_session_ready: stageChangedBeforeSessionReady,
			stage_valid_count: stageValidCount,
			error_source_valid_count: errorSourceValidCount,
			error_code_valid_count: errorCodeValidCount,
			agent_status_valid_count: agentStatusValidCount,
			agent_status_role_valid_count: agentStatusRoleValidCount,
			stage_changed_swipe_count_valid_count: stageChangedSwipeCountValidCount,
			facade_format_valid_count: facadeFormatValidCount,
			swipe_decision_valid_count: swipeDecisionValidCount,
			swipe_latency_bucket_valid_count: swipeLatencyBucketValidCount,
			synthesis_axes_count: synthesisAxesCount,
			synthesis_axes_min: synthesisAxesMin,
			synthesis_axes_valid_confidence_count: synthesisAxesValidConfidenceCount,
			synthesis_scout_assignments_count: synthesisScoutAssignmentsCount,
			synthesis_scout_assignments_min: synthesisScoutAssignmentsMin,
			synthesis_scout_assignments_valid_scout_count: synthesisScoutAssignmentsValidScoutCount,
			evidence_array_valid_count: evidenceArrayValidCount,
			anti_patterns_array_valid_count: antiPatternsArrayValidCount,
			evidence_length_min: evidenceLengthMin,
			evidence_length_max: evidenceLengthMax,
			evidence_items_valid_decision_count: evidenceItemsValidDecisionCount,
			evidence_items_valid_format_count: evidenceItemsValidFormatCount,
			evidence_items_valid_latency_signal_count: evidenceItemsValidLatencySignalCount,
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
			builder_scaffold_count: builderScaffoldCount,
			builder_rebuild_latency_ms: builderRebuildLatencyMs,
			builder_rebuild_latency_ms_p50: builderRebuildLatencyMsP50,
			builder_rebuild_latency_ms_max: builderRebuildLatencyMsMax,
			builder_rebuild_count: builderRebuildCount
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
		`drafts_p/r=${draftPlaceholderCount}/${draftRefinedCount} ` +
		`drafts_r_len=${draftRefinedHtmlLengthP50 === null ? '-' : draftRefinedHtmlLengthP50 + 'c'}/min=${draftRefinedHtmlLengthMin === null ? '-' : draftRefinedHtmlLengthMin + 'c'}/max=${draftRefinedHtmlLengthMax === null ? '-' : draftRefinedHtmlLengthMax + 'c'} ` +
		`drafts_r_src=s${draftRefinedScaffoldCount}/r${draftRefinedRebuildCount}/u${draftRefinedUnknownCount} ` +
		`drafts_r_s_len=${draftRefinedScaffoldHtmlLengthP50 === null ? '-' : draftRefinedScaffoldHtmlLengthP50 + 'c'}/min=${draftRefinedScaffoldHtmlLengthMin === null ? '-' : draftRefinedScaffoldHtmlLengthMin + 'c'} ` +
		`drafts_r_r_len=${draftRefinedRebuildHtmlLengthP50 === null ? '-' : draftRefinedRebuildHtmlLengthP50 + 'c'}/min=${draftRefinedRebuildHtmlLengthMin === null ? '-' : draftRefinedRebuildHtmlLengthMin + 'c'} ` +
		`synth=${synthesisUpdatedCount} swipe=${swipe.attempted ? swipe.status : 'skipped'} ` +
		`sse_err=${errorEventCount} auth_err=${agentErrorLines.length} ` +
		`err_msg=${errorMessagePresentCount} ` +
		`s1_roles=s${errorSourceScoutCount}/o${errorSourceOracleCount}/b${errorSourceBuilderCount} ` +
		`agent_status=${agentStatusEventCount} ` +
		`agent_status_roles=s${agentStatusScoutCount}/o${agentStatusOracleCount}/b${agentStatusBuilderCount} ` +
		`stage_changed=${stageChangedEventCount} stage_before_ready=${stageChangedBeforeSessionReady} ` +
		`stage_valid=${stageValidCount} err_src_valid=${errorSourceValidCount} err_code_valid=${errorCodeValidCount} ` +
		`agent_status_valid=${agentStatusValidCount} agent_status_role_valid=${agentStatusRoleValidCount} stage_swipe_valid=${stageChangedSwipeCountValidCount} ` +
		`facade_fmt_valid=${facadeFormatValidCount} ` +
		`swipe_dec_valid=${swipeDecisionValidCount} swipe_bkt_valid=${swipeLatencyBucketValidCount} ` +
		`synth_axes=${synthesisAxesCount}/min=${synthesisAxesMin} synth_axes_conf_valid=${synthesisAxesValidConfidenceCount} synth_assigns=${synthesisScoutAssignmentsCount}/min=${synthesisScoutAssignmentsMin} synth_assigns_scout_valid=${synthesisScoutAssignmentsValidScoutCount} ` +
		`evid_arr_valid=${evidenceArrayValidCount} anti_arr_valid=${antiPatternsArrayValidCount} evid_len_min/max=${evidenceLengthMin}/${evidenceLengthMax} ` +
		`evid_items_dec_valid=${evidenceItemsValidDecisionCount} evid_items_fmt_valid=${evidenceItemsValidFormatCount} evid_items_lat_valid=${evidenceItemsValidLatencySignalCount} ` +
		`s2_err=${stream2.error_event_count} s2_agents=${stream2.agent_status_count} s2_stage=${stream2.stage_changed_count} s2_diag=${stream2.diagnostic_preserved_count} s2_err_auth=${stream2.error_provider_auth_count} ` +
		`s2_roles=s${stream2.agent_status_scout_count}/o${stream2.agent_status_oracle_count}/b${stream2.agent_status_builder_count} ` +
		`s2_stage_valid=${stream2.stage_valid_count} s2_err_src_valid=${stream2.error_source_valid_count} s2_err_code_valid=${stream2.error_code_valid_count} s2_err_msg=${stream2.error_message_present_count} ` +
		`s2_agent_status_valid=${stream2.agent_status_valid_count} s2_agent_status_role_valid=${stream2.agent_status_role_valid_count} s2_stage_swipe_valid=${stream2.stage_changed_swipe_count_valid_count} ` +
		`s2_drafts=${stream2.draft_updated_count} s2_drafts_p/r=${stream2.draft_placeholder_count}/${stream2.draft_refined_count} ` +
		`s2_facades=${stream2.facade_ready_count} s2_synth=${stream2.synthesis_updated_count} s2_evidence=${stream2.evidence_updated_count} ` +
		`s2_facade_fmt_valid=${stream2.facade_format_valid_count} ` +
		`s2_synth_axes=${stream2.synthesis_axes_count}/min=${stream2.synthesis_axes_min} s2_synth_assigns=${stream2.synthesis_scout_assignments_count}/min=${stream2.synthesis_scout_assignments_min} ` +
		`s2_evid_arr_valid=${stream2.evidence_array_valid_count} s2_anti_arr_valid=${stream2.anti_patterns_array_valid_count} s2_evid_len_min/max=${stream2.evidence_length_min}/${stream2.evidence_length_max} ` +
		`s2_first=${stream2.first_event_ms_after_open}ms s2_span=${stream2.replay_span_ms}ms ` +
		`oracle_cs=${oracleColdStartLatencyMs === null ? '-' : oracleColdStartLatencyMs + 'ms'} ` +
		`oracle_syn=${oracleSynthesisLatencyMs === null ? '-' : oracleSynthesisLatencyMs + 'ms'} ` +
		`oracle_rev=${oracleRevealBuildLatencyMs === null ? '-' : oracleRevealBuildLatencyMs + 'ms'} ` +
		`scout_probe_p50=${scoutProbeLatencyMsP50 === null ? '-' : scoutProbeLatencyMsP50 + 'ms'}/n=${scoutProbeCount} ` +
		`builder_scaffold=${builderScaffoldLatencyMs === null ? '-' : builderScaffoldLatencyMs + 'ms'}/n=${builderScaffoldCount} ` +
		`builder_rebuild=${builderRebuildLatencyMs === null ? '-' : builderRebuildLatencyMs + 'ms'}/n=${builderRebuildCount}`
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
