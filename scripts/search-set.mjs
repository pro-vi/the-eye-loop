#!/usr/bin/env node
// Ramp stage 6 runner — iterates a JSONL search set of demo intents through
// scripts/validate.mjs and writes one aggregate artifact per invocation.
//
// Each entry in the JSONL file must have { id, intent, ... }. For each entry
// we spawn validate.mjs with VALIDATE_INTENT set, wait for it to exit, then
// read scripts/findings/validate-latest.json to collect the per-run metrics
// it just wrote. We persist the aggregate to:
//   benchmarks/runs/search-<ts>/aggregate.json   (stamped)
//   benchmarks/runs/search-latest.json           (stable)
//
// Exit code contract:
//   0  every intent in the set produced result=PASS
//   1  at least one intent produced result=FAIL (including provider_auth_failure)
//   2  harness failure (JSONL missing, subprocess crashed, aggregate unwriteable)
//
// Env knobs:
//   SEARCH_SET_PATH    defaults to benchmarks/search_set/v0-demo.jsonl
//   SEARCH_RUN_MS      per-intent observation window forwarded to validate.mjs
//                      as VALIDATE_RUN_MS (default 12000)
//   SEARCH_BOOT_MS     per-intent boot deadline forwarded as VALIDATE_BOOT_MS
//                      (default 30000)
//   SEARCH_LIMIT       if set, only run the first N entries (useful for smoke)

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FINDINGS_LATEST = resolve(REPO_ROOT, 'scripts/findings/validate-latest.json');
const RUNS_DIR = resolve(REPO_ROOT, 'benchmarks/runs');

const SEARCH_SET_PATH = resolve(
	REPO_ROOT,
	process.env.SEARCH_SET_PATH ?? 'benchmarks/search_set/v0-demo.jsonl'
);
const PER_RUN_MS = Number(process.env.SEARCH_RUN_MS ?? 12000);
const PER_BOOT_MS = Number(process.env.SEARCH_BOOT_MS ?? 30000);
const LIMIT = process.env.SEARCH_LIMIT ? Number(process.env.SEARCH_LIMIT) : null;

function nowIso() { return new Date().toISOString(); }
function fileStamp() { return nowIso().replace(/[:.]/g, '-'); }

function readSearchSet(path) {
	const raw = readFileSync(path, 'utf8');
	const rows = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		let parsed;
		try { parsed = JSON.parse(trimmed); }
		catch (err) { throw new Error(`invalid JSONL at line "${trimmed}": ${err?.message ?? err}`); }
		if (!parsed.id || typeof parsed.intent !== 'string') {
			throw new Error(`search set row missing id or intent: ${trimmed}`);
		}
		rows.push(parsed);
	}
	return rows;
}

function runOne(row) {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [resolve(REPO_ROOT, 'scripts/validate.mjs')], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				VALIDATE_INTENT: row.intent,
				VALIDATE_RUN_MS: String(PER_RUN_MS),
				VALIDATE_BOOT_MS: String(PER_BOOT_MS)
			},
			stdio: ['ignore', 'inherit', 'inherit']
		});
		child.on('exit', (code, signal) => {
			resolvePromise({ code: code ?? null, signal: signal ?? null });
		});
		child.on('error', (err) => {
			resolvePromise({ code: null, signal: null, error: String(err?.message ?? err) });
		});
	});
}

function readLatestArtifact() {
	try {
		const raw = readFileSync(FINDINGS_LATEST, 'utf8');
		return JSON.parse(raw);
	} catch (err) {
		return { _read_error: String(err?.message ?? err) };
	}
}

function extractMetrics(artifact) {
	const m = artifact?.metrics ?? {};
	return {
		time_to_first_facade_ms: m.time_to_first_facade_ms ?? null,
		time_to_first_draft_ms: m.time_to_first_draft_ms ?? null,
		time_to_first_synthesis_ms: m.time_to_first_synthesis_ms ?? null,
		time_to_first_draft_after_swipe_ms: m.time_to_first_draft_after_swipe_ms ?? null,
		time_to_session_ready_ms: m.time_to_session_ready_ms ?? null,
		time_to_first_error_ms: m.time_to_first_error_ms ?? null,
		time_from_session_to_first_facade_ms: m.time_from_session_to_first_facade_ms ?? null,
		time_from_session_to_first_draft_ms: m.time_from_session_to_first_draft_ms ?? null,
		time_from_session_to_first_error_ms: m.time_from_session_to_first_error_ms ?? null,
		facade_ready_count: m.facade_ready_count ?? 0,
		draft_updated_count: m.draft_updated_count ?? 0,
		synthesis_updated_count: m.synthesis_updated_count ?? 0,
		swipe_result_count: m.swipe_result_count ?? 0,
		evidence_updated_count: m.evidence_updated_count ?? 0,
		reveal_reached: m.reveal_reached ?? false,
		error_event_count: m.error_event_count ?? 0,
		distinct_error_agent_count: m.distinct_error_agent_count ?? 0,
		provider_auth_failure_count: m.provider_auth_failure_count ?? 0,
		auth_diagnostic_preserved_count: m.auth_diagnostic_preserved_count ?? 0,
		agent_error_signal_count: m.agent_error_signal_count ?? 0,
		scout_started_count: m.scout_started_count ?? 0,
		scout_start_spread_ms: m.scout_start_spread_ms ?? null,
		error_event_spread_ms: m.error_event_spread_ms ?? null,
		stream_2_error_event_count: m.stream_2_error_event_count ?? 0,
		stream_2_agent_status_count: m.stream_2_agent_status_count ?? 0,
		stream_2_stage_changed_count: m.stream_2_stage_changed_count ?? 0,
		stream_2_diagnostic_preserved_count: m.stream_2_diagnostic_preserved_count ?? 0
	};
}

function percentile(values, p) {
	const cleaned = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
	if (cleaned.length === 0) return null;
	const sorted = [...cleaned].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
	return sorted[idx];
}

async function main() {
	const startedAt = nowIso();
	const t0 = Date.now();

	let rows;
	try { rows = readSearchSet(SEARCH_SET_PATH); }
	catch (err) {
		console.error(`[search-set] failed to load ${SEARCH_SET_PATH}: ${err?.message ?? err}`);
		process.exit(2);
		return;
	}
	if (rows.length === 0) {
		console.error(`[search-set] no rows in ${SEARCH_SET_PATH}`);
		process.exit(2);
		return;
	}
	if (LIMIT !== null && LIMIT > 0) rows = rows.slice(0, LIMIT);

	console.log(
		`[search-set] running ${rows.length} intent(s) from ${SEARCH_SET_PATH} ` +
		`(per-run ${PER_RUN_MS}ms)`
	);

	const perIntent = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const runStartedAt = nowIso();
		const runT0 = Date.now();
		console.log(`\n[search-set] (${i + 1}/${rows.length}) id=${row.id} intent="${row.intent}"`);
		const outcome = await runOne(row);
		const runElapsed = Date.now() - runT0;
		const artifact = readLatestArtifact();
		const metrics = extractMetrics(artifact);
		// Prefer the stamped path embedded in the artifact by validate.mjs —
		// validate-latest.json is overwritten by the next intent, so recording
		// only FINDINGS_LATEST leaves N-1 per-intent rows pointing at the wrong
		// trace. Fall back to FINDINGS_LATEST if the field is absent (older
		// artifact schema or a read error).
		const stampedArtifactPath =
			typeof artifact?.artifact_path === 'string' ? artifact.artifact_path : FINDINGS_LATEST;
		const entry = {
			id: row.id,
			intent: row.intent,
			tags: row.tags ?? [],
			started_at: runStartedAt,
			finished_at: nowIso(),
			elapsed_ms: runElapsed,
			exit_code: outcome.code,
			exit_signal: outcome.signal,
			spawn_error: outcome.error ?? null,
			result: artifact?.result ?? 'UNKNOWN',
			reason: artifact?.reason ?? null,
			session_status: artifact?.session?.status ?? null,
			metrics,
			artifact_path: stampedArtifactPath
		};
		perIntent.push(entry);
		console.log(
			`[search-set] (${i + 1}/${rows.length}) id=${row.id} result=${entry.result} ` +
			`reason=${entry.reason} facades=${metrics.facade_ready_count} ` +
			`drafts=${metrics.draft_updated_count} sse_err=${metrics.error_event_count} ` +
			`elapsed=${runElapsed}ms`
		);
	}

	const passCount = perIntent.filter((p) => p.result === 'PASS').length;
	const failCount = perIntent.filter((p) => p.result === 'FAIL').length;
	const harnessFailureCount = perIntent.filter((p) => p.exit_code === 2 || p.exit_code === null).length;

	const reasonCounts = {};
	for (const p of perIntent) {
		const r = p.reason ?? 'unknown';
		reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
	}
	let dominantReason = null;
	let dominantCount = -1;
	for (const [r, c] of Object.entries(reasonCounts)) {
		if (c > dominantCount) { dominantReason = r; dominantCount = c; }
	}

	const firstFacadeValues = perIntent.map((p) => p.metrics.time_to_first_facade_ms);
	const firstDraftValues = perIntent.map((p) => p.metrics.time_to_first_draft_ms);
	const firstSynthesisValues = perIntent.map((p) => p.metrics.time_to_first_synthesis_ms);
	const sumMetric = (key) =>
		perIntent.reduce((acc, p) => acc + (p.metrics[key] ?? 0), 0);
	const authFailureSum = sumMetric('provider_auth_failure_count');
	const errorEventSum = sumMetric('error_event_count');
	const facadeReadyCountSum = sumMetric('facade_ready_count');
	const draftUpdatedCountSum = sumMetric('draft_updated_count');
	const synthesisUpdatedCountSum = sumMetric('synthesis_updated_count');
	const swipeResultCountSum = sumMetric('swipe_result_count');
	const distinctErrorAgentCountSum = sumMetric('distinct_error_agent_count');
	const distinctErrorAgentCountValues = perIntent.map(
		(p) => p.metrics.distinct_error_agent_count ?? 0
	);
	const distinctErrorAgentCountMin = distinctErrorAgentCountValues.length
		? Math.min(...distinctErrorAgentCountValues)
		: 0;
	// Diagnostic-focus preservation roll-up (iter-23/24 roster-wide invariant).
	// Under the broken-auth baseline, auth_diagnostic_preserved_count_min
	// should equal distinct_error_agent_count_min (both 8): every agent that
	// emitted a provider_auth_failure keeps 'provider auth failed' as its
	// final focus. A regression that drops _min below distinct_error_agent_count_min
	// directly flags the post-loop focus-overwrite bug iter-23/24 closed.
	const authDiagnosticPreservedCountSum = sumMetric('auth_diagnostic_preserved_count');
	const authDiagnosticPreservedCountValues = perIntent.map(
		(p) => p.metrics.auth_diagnostic_preserved_count ?? 0
	);
	const authDiagnosticPreservedCountMin = authDiagnosticPreservedCountValues.length
		? Math.min(...authDiagnosticPreservedCountValues)
		: 0;
	const revealReachedCount = perIntent.reduce(
		(acc, p) => acc + (p.metrics.reveal_reached ? 1 : 0),
		0
	);
	const revealReachRate = perIntent.length > 0 ? revealReachedCount / perIntent.length : 0;

	// Scout start fan-out — iter-16 removed the 500ms inter-scout stagger.
	// p90 across intents is the most robust regression probe: a regression
	// where any single intent runs with the stagger pushes p90 to ~2500ms.
	const scoutStartSpreadValues = perIntent
		.map((p) => p.metrics.scout_start_spread_ms)
		.filter((v) => typeof v === 'number' && Number.isFinite(v));
	const scoutStartSpreadP50 = percentile(scoutStartSpreadValues, 50);
	const scoutStartSpreadP90 = percentile(scoutStartSpreadValues, 90);
	const scoutStartSpreadMax = scoutStartSpreadValues.length
		? Math.max(...scoutStartSpreadValues)
		: null;
	const scoutStartedCountSum = sumMetric('scout_started_count');

	// Error event spread — parallel-fail fan-out. Under iter-13's
	// zero-retry-on-auth regime, all 8 agents hit Anthropic in parallel and
	// fail within a narrow window. p90 across intents is the regression probe:
	// a regression that reintroduces retries or serializes provider calls
	// would push p90 significantly higher.
	const errorSpreadValues = perIntent
		.map((p) => p.metrics.error_event_spread_ms)
		.filter((v) => typeof v === 'number' && Number.isFinite(v));
	const errorSpreadP50 = percentile(errorSpreadValues, 50);
	const errorSpreadP90 = percentile(errorSpreadValues, 90);
	const errorSpreadMax = errorSpreadValues.length
		? Math.max(...errorSpreadValues)
		: null;

	// Session-relative latencies — the product-facing view of "how fast
	// after POST /api/session did X happen?". Under broken auth, facade/draft
	// are null and the error value captures Anthropic 401 RTT (~200-300ms).
	// Under healthy auth, facade/draft would populate with Haiku latency
	// (~1-2s) and error would be null — directly aligned with the V0 demo
	// row 1 "get first facades quickly" product frontier anchor.
	const sessionToFacadeValues = perIntent.map(
		(p) => p.metrics.time_from_session_to_first_facade_ms
	);
	const sessionToDraftValues = perIntent.map(
		(p) => p.metrics.time_from_session_to_first_draft_ms
	);
	const sessionToErrorValues = perIntent.map(
		(p) => p.metrics.time_from_session_to_first_error_ms
	);
	const sessionReadyValues = perIntent.map((p) => p.metrics.time_to_session_ready_ms);
	const firstErrorAbsValues = perIntent.map((p) => p.metrics.time_to_first_error_ms);

	const aggregate = {
		started_at: startedAt,
		finished_at: nowIso(),
		elapsed_ms: Date.now() - t0,
		search_set_path: SEARCH_SET_PATH,
		per_run_ms: PER_RUN_MS,
		per_boot_ms: PER_BOOT_MS,
		total_intents: perIntent.length,
		pass_count: passCount,
		fail_count: failCount,
		harness_failure_count: harnessFailureCount,
		pass_rate: perIntent.length > 0 ? passCount / perIntent.length : 0,
		reason_counts: reasonCounts,
		dominant_reason: dominantReason,
		aggregate_metrics: {
			time_to_first_facade_ms_p50: percentile(firstFacadeValues, 50),
			time_to_first_facade_ms_p90: percentile(firstFacadeValues, 90),
			time_to_first_draft_ms_p50: percentile(firstDraftValues, 50),
			time_to_first_draft_ms_p90: percentile(firstDraftValues, 90),
			time_to_first_synthesis_ms_p50: percentile(firstSynthesisValues, 50),
			time_to_first_synthesis_ms_p90: percentile(firstSynthesisValues, 90),
			time_to_session_ready_ms_p50: percentile(sessionReadyValues, 50),
			time_to_session_ready_ms_p90: percentile(sessionReadyValues, 90),
			time_to_first_error_ms_p50: percentile(firstErrorAbsValues, 50),
			time_to_first_error_ms_p90: percentile(firstErrorAbsValues, 90),
			time_from_session_to_first_facade_ms_p50: percentile(sessionToFacadeValues, 50),
			time_from_session_to_first_facade_ms_p90: percentile(sessionToFacadeValues, 90),
			time_from_session_to_first_draft_ms_p50: percentile(sessionToDraftValues, 50),
			time_from_session_to_first_draft_ms_p90: percentile(sessionToDraftValues, 90),
			time_from_session_to_first_error_ms_p50: percentile(sessionToErrorValues, 50),
			time_from_session_to_first_error_ms_p90: percentile(sessionToErrorValues, 90),
			reveal_reached_count: revealReachedCount,
			reveal_reach_rate: revealReachRate,
			facade_ready_count_sum: facadeReadyCountSum,
			draft_updated_count_sum: draftUpdatedCountSum,
			synthesis_updated_count_sum: synthesisUpdatedCountSum,
			swipe_result_count_sum: swipeResultCountSum,
			error_event_count_sum: errorEventSum,
			provider_auth_failure_count_sum: authFailureSum,
			distinct_error_agent_count_sum: distinctErrorAgentCountSum,
			distinct_error_agent_count_min: distinctErrorAgentCountMin,
			auth_diagnostic_preserved_count_sum: authDiagnosticPreservedCountSum,
			auth_diagnostic_preserved_count_min: authDiagnosticPreservedCountMin,
			scout_started_count_sum: scoutStartedCountSum,
			scout_start_spread_ms_p50: scoutStartSpreadP50,
			scout_start_spread_ms_p90: scoutStartSpreadP90,
			scout_start_spread_ms_max: scoutStartSpreadMax,
			error_event_spread_ms_p50: errorSpreadP50,
			error_event_spread_ms_p90: errorSpreadP90,
			error_event_spread_ms_max: errorSpreadMax,
			// iter-26 stream-replay probe. Each intent opens a second /api/stream
			// mid-run; the bus/getLastError + stream replay fix means lastError
			// is resent to late-connecting clients, so a healthy baseline yields
			// _sum = intent_count and _min = 1. A regression that reverts the
			// replay drops _min to 0, which search-set will surface at aggregate
			// level without needing to walk per_intent.
			stream_2_error_event_count_sum: sumMetric('stream_2_error_event_count'),
			stream_2_error_event_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_error_event_count ?? 0))
				: 0,
			stream_2_agent_status_count_sum: sumMetric('stream_2_agent_status_count'),
			stream_2_agent_status_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_agent_status_count ?? 0))
				: 0,
			// iter-27 stream-replay completeness: stage-changed emitted on every
			// reconnect so the client can transition mode correctly after tab
			// suspend/resume or Vercel maxDuration=300s stream cutoff. Under the
			// broken-auth baseline context.stage stays at 'words' (default), but
			// the replay still fires — _min=1 when wired, 0 when reverted.
			stream_2_stage_changed_count_sum: sumMetric('stream_2_stage_changed_count'),
			stream_2_stage_changed_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_stage_changed_count ?? 0))
				: 0,
			// iter-29 stream-replay content verification: complements iter-25's
			// auth_diagnostic_preserved_count (which reads the PRIMARY stream's
			// live agent-status transitions) by reading the REPLAY block's
			// synchronous for-loop over context.agents.values(). Under the
			// broken-auth baseline _min=8 (all 8 agents' replayed focus carries
			// the iter-23/24 diagnostic). A replay-path regression that serves
			// stale snapshots or alters focus on the way out drops _min while
			// leaving iter-25's live-path probe intact.
			stream_2_diagnostic_preserved_count_sum: sumMetric('stream_2_diagnostic_preserved_count'),
			stream_2_diagnostic_preserved_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_diagnostic_preserved_count ?? 0))
				: 0
		},
		per_intent: perIntent
	};

	const stampedDir = resolve(RUNS_DIR, `search-${fileStamp()}`);
	try {
		mkdirSync(stampedDir, { recursive: true });
		mkdirSync(RUNS_DIR, { recursive: true });
	} catch (err) {
		console.error(`[search-set] cannot create ${RUNS_DIR}: ${err?.message ?? err}`);
		process.exit(2);
		return;
	}
	const stampedPath = resolve(stampedDir, 'aggregate.json');
	const latestPath = resolve(RUNS_DIR, 'search-latest.json');
	const payload = JSON.stringify(aggregate, null, 2);
	writeFileSync(stampedPath, payload);
	writeFileSync(latestPath, payload);

	console.log(
		`\n[search-set] done. pass=${passCount}/${perIntent.length} ` +
		`fail=${failCount} harness_fail=${harnessFailureCount} ` +
		`dominant_reason=${dominantReason}`
	);
	console.log(`[search-set] aggregate: ${stampedPath}`);

	if (failCount > 0 || harnessFailureCount > 0) process.exit(1);
	process.exit(0);
}

main().catch((err) => {
	console.error('[search-set] fatal', err);
	process.exit(2);
});
