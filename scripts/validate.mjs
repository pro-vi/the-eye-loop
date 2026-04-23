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
//   VALIDATE_RUN_MS    how long to hold the SSE stream open (default 20000)
//   VALIDATE_BOOT_MS   dev server boot deadline (default 30000)
//   VALIDATE_INTENT    demo intent used in POST /api/session

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
	const payload = JSON.stringify(artifact, null, 2);
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

	// 5. Hold stream for the observation window.
	await sleep(RUN_TIMEOUT_MS);
	streamController.abort();
	await streamTask;

	// 6. Teardown dev server.
	teardown();
	await sleep(300);

	// 7. Summarize.
	const eventCounts = {};
	for (const e of events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;

	const facadeReadyCount = eventCounts['facade-ready'] ?? 0;
	const draftUpdatedCount = eventCounts['draft-updated'] ?? 0;
	const synthesisUpdatedCount = eventCounts['synthesis-updated'] ?? 0;
	const agentErrorLines = stderrLines.filter((l) => ERROR_SIGNAL_RE.test(l.text));

	const sessionOk = sessionStatus >= 200 && sessionStatus < 300;
	const pass = sessionOk && facadeReadyCount > 0 && draftUpdatedCount > 0;

	let reason;
	if (pass) reason = 'facade_and_draft_observed';
	else if (!sessionOk) reason = 'session_post_not_2xx';
	else if (facadeReadyCount === 0 && agentErrorLines.length > 0) reason = 'provider_auth_failure';
	else if (facadeReadyCount === 0) reason = 'no_facade_ready';
	else reason = 'no_draft_updated';

	const timeToFirstFacadeMs = firsts['facade-ready'] ?? null;
	const timeToFirstDraftMs = firsts['draft-updated'] ?? null;
	const timeToFirstSynthesisMs = firsts['synthesis-updated'] ?? null;

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
		stream: {
			opened_at_ms: tStreamOpen - t0,
			error: streamError,
			event_counts: eventCounts,
			first_event_ms: firsts,
			events
		},
		metrics: {
			time_to_first_facade_ms: timeToFirstFacadeMs,
			time_to_first_draft_ms: timeToFirstDraftMs,
			time_to_first_synthesis_ms: timeToFirstSynthesisMs,
			facade_ready_count: facadeReadyCount,
			draft_updated_count: draftUpdatedCount,
			synthesis_updated_count: synthesisUpdatedCount,
			agent_error_signal_count: agentErrorLines.length
		},
		provider_error_samples: agentErrorLines.slice(0, 8),
		stderr_tail: stderrBuf.slice(-2000)
	};

	persistArtifact(artifact);
	console.log(
		`[validate] result=${artifact.result} reason=${reason} ` +
		`session=${sessionStatus} facades=${facadeReadyCount} drafts=${draftUpdatedCount} ` +
		`synth=${synthesisUpdatedCount} auth_err=${agentErrorLines.length}`
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
