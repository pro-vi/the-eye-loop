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
		error_source_scout_count: m.error_source_scout_count ?? 0,
		error_source_oracle_count: m.error_source_oracle_count ?? 0,
		error_source_builder_count: m.error_source_builder_count ?? 0,
		provider_auth_failure_count: m.provider_auth_failure_count ?? 0,
		error_message_present_count: m.error_message_present_count ?? 0,
		auth_diagnostic_preserved_count: m.auth_diagnostic_preserved_count ?? 0,
		agent_status_event_count: m.agent_status_event_count ?? 0,
		agent_status_scout_count: m.agent_status_scout_count ?? 0,
		agent_status_oracle_count: m.agent_status_oracle_count ?? 0,
		agent_status_builder_count: m.agent_status_builder_count ?? 0,
		agent_error_signal_count: m.agent_error_signal_count ?? 0,
		scout_started_count: m.scout_started_count ?? 0,
		scout_start_spread_ms: m.scout_start_spread_ms ?? null,
		error_event_spread_ms: m.error_event_spread_ms ?? null,
		stream_2_error_event_count: m.stream_2_error_event_count ?? 0,
		stream_2_agent_status_count: m.stream_2_agent_status_count ?? 0,
		stream_2_stage_changed_count: m.stream_2_stage_changed_count ?? 0,
		stream_2_diagnostic_preserved_count: m.stream_2_diagnostic_preserved_count ?? 0,
		stream_2_error_provider_auth_count: m.stream_2_error_provider_auth_count ?? 0,
		stream_2_agent_status_scout_count: m.stream_2_agent_status_scout_count ?? 0,
		stream_2_agent_status_oracle_count: m.stream_2_agent_status_oracle_count ?? 0,
		stream_2_agent_status_builder_count: m.stream_2_agent_status_builder_count ?? 0,
		stream_2_stage_valid_count: m.stream_2_stage_valid_count ?? 0,
		stream_2_error_source_valid_count: m.stream_2_error_source_valid_count ?? 0,
		stream_2_error_code_valid_count: m.stream_2_error_code_valid_count ?? 0,
		stream_2_error_message_present_count: m.stream_2_error_message_present_count ?? 0,
		stream_2_first_event_ms_after_open: m.stream_2_first_event_ms_after_open ?? null,
		stream_2_replay_span_ms: m.stream_2_replay_span_ms ?? null,
		stage_changed_event_count: m.stage_changed_event_count ?? 0,
		time_to_first_stage_changed_ms: m.time_to_first_stage_changed_ms ?? null,
		stage_changed_before_session_ready: m.stage_changed_before_session_ready ?? 0,
		stage_valid_count: m.stage_valid_count ?? 0,
		error_source_valid_count: m.error_source_valid_count ?? 0,
		error_code_valid_count: m.error_code_valid_count ?? 0,
		agent_status_valid_count: m.agent_status_valid_count ?? 0,
		stream_2_agent_status_valid_count: m.stream_2_agent_status_valid_count ?? 0,
		oracle_cold_start_latency_ms: m.oracle_cold_start_latency_ms ?? null,
		oracle_synthesis_latency_ms: m.oracle_synthesis_latency_ms ?? null,
		oracle_reveal_build_latency_ms: m.oracle_reveal_build_latency_ms ?? null,
		oracle_cold_start_count: m.oracle_cold_start_count ?? 0,
		oracle_synthesis_count: m.oracle_synthesis_count ?? 0,
		oracle_reveal_build_count: m.oracle_reveal_build_count ?? 0,
		scout_probe_latency_ms_p50: m.scout_probe_latency_ms_p50 ?? null,
		scout_probe_latency_ms_max: m.scout_probe_latency_ms_max ?? null,
		scout_probe_count: m.scout_probe_count ?? 0,
		builder_scaffold_latency_ms: m.builder_scaffold_latency_ms ?? null,
		builder_scaffold_count: m.builder_scaffold_count ?? 0
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
			// Primary-stream error role-cardinality rollup (iter-14 distinct-
			// agent probe promoted to role-level at aggregate). Parallel to
			// iter-40's stream_2 per-role breakdown but for the LIVE error-
			// emission path instead of the replay roster. Under broken-auth
			// baseline the expected invariants are scout_sum=30 _min=6 (6 scouts
			// × 5 intents), oracle_sum=5 _min=1, builder_sum=5 _min=1. A
			// regression where a scout mis-identifies its role at emission
			// time would drop scout_min below 6 while leaving
			// distinct_error_agent_count_min intact at 8 (agent identity
			// unchanged, role mis-attributed). Complementary to iter-40's
			// stream_2 per-role probe which reads the replay side.
			error_source_scout_count_sum: sumMetric('error_source_scout_count'),
			error_source_scout_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.error_source_scout_count ?? 0))
				: 0,
			error_source_oracle_count_sum: sumMetric('error_source_oracle_count'),
			error_source_oracle_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.error_source_oracle_count ?? 0))
				: 0,
			error_source_builder_count_sum: sumMetric('error_source_builder_count'),
			error_source_builder_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.error_source_builder_count ?? 0))
				: 0,
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
				: 0,
			// iter-39 structured error replay content probe. Parallel to the
			// diagnostic_preserved probe above but for the iter-3 'error'
			// SSEEvent's code field rather than agent-status focus. Under the
			// broken-auth baseline the lone replayed error (bus.lastError wired
			// by iter-26) should carry code='provider_auth_failure', so _sum=5
			// _min=1 across 5 intents. A regression that flips the code field
			// (broken classifyErrorCode return, stale lastError from a previous
			// generation_error failure, payload mutation in /api/stream's
			// replay block) drops _min to 0 while stream_2_error_event_count_min
			// stays at 1 — orthogonal signal that catches UX-degradation bugs
			// where the iter-8 client banner would render wrong code-specific
			// copy. Complementary to iter-29's agent-status content probe: the
			// two probes verify two different replayed payload shapes.
			stream_2_error_provider_auth_count_sum: sumMetric('stream_2_error_provider_auth_count'),
			stream_2_error_provider_auth_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_error_provider_auth_count ?? 0))
				: 0,
			// iter-40 stream-replay roster breakdown: splits iter-26's total
			// stream_2_agent_status_count (always 8 under broken-auth) into
			// per-role counts. Closes the roster-cardinality regression class
			// iter-39 explicitly named as unprobed — a bug that drops scouts
			// from 6 to 3 but inflates oracle or builder count to match would
			// leave stream_2_agent_status_count_min at 8 while these per-role
			// probes drop below their expected _min (scout=6, oracle=1, builder=1).
			// Parallel to iter-14's per-agent attribution on the primary stream,
			// just for the /api/stream replay block's synchronous for-loop
			// over context.agents.values(). Complementary to iter-29's focus
			// content probe (verifies payload, not role membership) and
			// iter-37's tightness probe (verifies timing, not payload shape).
			stream_2_agent_status_scout_count_sum: sumMetric('stream_2_agent_status_scout_count'),
			stream_2_agent_status_scout_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_agent_status_scout_count ?? 0))
				: 0,
			stream_2_agent_status_oracle_count_sum: sumMetric('stream_2_agent_status_oracle_count'),
			stream_2_agent_status_oracle_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_agent_status_oracle_count ?? 0))
				: 0,
			stream_2_agent_status_builder_count_sum: sumMetric('stream_2_agent_status_builder_count'),
			stream_2_agent_status_builder_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_agent_status_builder_count ?? 0))
				: 0,
			// iter-41 payload-value membership probes on stream_2 — closes iter-40's
			// two explicitly-named unprobed content dimensions:
			//   stream_2_stage_valid_count:        stage-changed.stage ∈ Stage union
			//   stream_2_error_source_valid_count: error.source ∈ ErrorSource union
			// Under broken-auth baseline, each fires once in the replay (matching
			// stream_2_stage_changed_count=1 and stream_2_error_event_count=1), so
			// the invariant at aggregate is _sum=5 _min=1. Each probe is orthogonal
			// to the existing count/content siblings: count probes (iter-26/27) fire
			// on "event is present at all"; content probes (iter-29 focus, iter-39
			// code) fire on "specific field equals specific string"; these two fire
			// on "specific field is a MEMBER of a valid enum". The regression class
			// is payload corruption where the field is present but outside the
			// declared union (undefined, null, stale pre-rename value, typo, or
			// future Stage/ErrorSource extension leaking an unhandled literal). A
			// drop in _min for either below 1 means the replay emitted a wire-shape-
			// invalid payload that count probes cannot see and iter-29/iter-39
			// content probes (which only catch ONE specific valid value) also miss.
			stream_2_stage_valid_count_sum: sumMetric('stream_2_stage_valid_count'),
			stream_2_stage_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_stage_valid_count ?? 0))
				: 0,
			stream_2_error_source_valid_count_sum: sumMetric('stream_2_error_source_valid_count'),
			stream_2_error_source_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_error_source_valid_count ?? 0))
				: 0,
			// iter-56 error.code union-membership rollups (stream_2 + primary
			// below). Closes the last unfilled cell in {primary, stream_2} ×
			// {stage, source, code, message} field-validity matrix that iter-54
			// (message) and iter-55 (primary stage + source) left open. Distinct
			// from iter-39's stream_2_error_provider_auth_count_sum (iter-3 era
			// SPECIFIC-VALUE probe ===' provider_auth_failure'): under broken-auth
			// they're identical (every code is provider_auth_failure, sum=5/_min=1
			// stream_2; sum=40/_min=8 primary), but under any post-auth-fix regime
			// emitting non-auth codes (provider_error from a 5xx, generation_error
			// from a parse failure) provider_auth_count drops below event_count
			// while error_code_valid_count stays at event_count. The two probes
			// together discriminate three regimes: (1) broken-auth: both equal
			// event_count, (2) healthy with non-auth errors: code_valid stays high,
			// provider_auth drops, (3) corrupt emit: code_valid drops below event
			// while provider_auth stays at zero. Adds 8th identity term to the
			// iter-25 7-way equality at 40: error_code_valid_count_sum=40.
			stream_2_error_code_valid_count_sum: sumMetric('stream_2_error_code_valid_count'),
			stream_2_error_code_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_error_code_valid_count ?? 0))
				: 0,
			// iter-54 message-field presence rollups — closes the last unprobed
			// field on the iter-3 'error' SSEEvent across BOTH primary and
			// stream_2, completing the {primary, stream_2} × {source, code,
			// agentId, message} error-event field-validity matrix. Sibling
			// rollups: source valid (iter-41 stream_2, implicit per-role iter-44
			// primary); code valid (iter-39 stream_2, iter-3 primary via
			// provider_auth_failure_count); agentId via iter-14 distinct-agent.
			// Under broken-auth baseline: primary fires 8 per intent (all 8
			// provider_auth_failure errors carry message="Invalid bearer token"
			// from errorToDiagnostic), stream_2 fires 1 per intent (the lone
			// replayed error from bus.lastError); so the invariants are
			//   error_message_present_count_sum=40 _min=8 (primary)
			//   stream_2_error_message_present_count_sum=5 _min=1 (stream_2)
			// A regression that strips the message field in SSE serialization
			// (leaving source/code/agentId intact) drops BOTH _min values to 0
			// while every iter-14/iter-39/iter-40/iter-41/iter-44 probe stays
			// at baseline — a genuinely orthogonal regression class covering
			// the iter-8 client banner's actionable detail (the human-readable
			// reason text rendered under the code-keyed title).
			error_message_present_count_sum: sumMetric('error_message_present_count'),
			error_message_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.error_message_present_count ?? 0))
				: 0,
			stream_2_error_message_present_count_sum: sumMetric('stream_2_error_message_present_count'),
			stream_2_error_message_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_error_message_present_count ?? 0))
				: 0,
			// iter-31 primary-stream lifecycle volume. Complementary to
			// scout_started_count_sum (counts distinct scouts that reached
			// 'thinking') and auth_diagnostic_preserved_count (content of final
			// focus): this metric counts TOTAL agent-status emits on the primary
			// stream (2 pre-session replay + live transitions). Under the
			// broken-auth baseline with iter-13 no-retry + iter-23/24 diagnostic
			// preservation the invariant is exactly 18 per intent (2 + 8
			// thinking + 8 idle/diagnostic) — _sum = 90 and _min = 18 across 5
			// intents. A regression that reintroduces retry loops under auth
			// failure widens the count per retry; a regression of iter-23 fall-
			// through adds a 6-event tail (18 → 24); a roster cardinality change
			// shifts the base value.
			agent_status_event_count_sum: sumMetric('agent_status_event_count'),
			agent_status_event_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_status_event_count ?? 0))
				: 0,
			// iter-52 primary-stream agent-status per-role breakdown. Closes
			// the last orthogonal cell in {primary, stream_2} × {agent-status,
			// error} × per-role (siblings: iter-31 primary total, iter-40
			// stream_2 per-role, iter-44 primary error per-role). Under broken-
			// auth baseline expected invariants: scout=60/12 (12 per intent × 5
			// intents, 6 scouts each emitting 2 agent-status events = thinking
			// + idle), oracle=15/3 (1 replay + 1 thinking + 1 idle per intent),
			// builder=15/3 (same as oracle). A regression that reintroduces
			// retries under auth failure would inflate scout counts past 12;
			// a regression that drops the replay from /api/stream's start()
			// block would drop oracle and builder to 2 per intent; a roster
			// rebalance where scouts become 3 but inflate oracle/builder
			// would keep the iter-31 total at 18 but shift per-role values.
			agent_status_scout_count_sum: sumMetric('agent_status_scout_count'),
			agent_status_scout_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_status_scout_count ?? 0))
				: 0,
			agent_status_oracle_count_sum: sumMetric('agent_status_oracle_count'),
			agent_status_oracle_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_status_oracle_count ?? 0))
				: 0,
			agent_status_builder_count_sum: sumMetric('agent_status_builder_count'),
			agent_status_builder_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_status_builder_count ?? 0))
				: 0,
			// iter-34 primary-stream stage-changed probe. Closes iter-27's
			// explicitly-deferred ordering invariant: under the broken-auth
			// baseline context.stage never advances (no facade -> no swipe ->
			// no stage change), so the only stage-changed on the primary stream
			// is the replay at connect time. Expected values: _sum=5 _min=1 for
			// count (exactly one replay per intent), and
			// stage_changed_before_session_ready_min=1 (replay always fires
			// before POST /api/session completes). A regression that moves the
			// replay into onSessionReady would drop _before_session_ready_min
			// to 0 while leaving the count intact; a regression that removes
			// the replay from +server.ts's start() block drops both to 0.
			stage_changed_event_count_sum: sumMetric('stage_changed_event_count'),
			stage_changed_event_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stage_changed_event_count ?? 0))
				: 0,
			stage_changed_before_session_ready_sum: sumMetric('stage_changed_before_session_ready'),
			stage_changed_before_session_ready_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stage_changed_before_session_ready ?? 0))
				: 0,
			// iter-55 primary-stream payload-value membership probes. Closes the
			// iter-41 asymmetry where stream_2 had stage_valid / error_source_valid
			// membership coverage but the PRIMARY stream's live emission path did
			// not. Expected under broken-auth baseline:
			//   stage_valid_count_sum=5 _min=1 (replay at connect emits stage='words')
			//   error_source_valid_count_sum=40 _min=8 (6 scouts + oracle + builder
			//     per intent × 5 intents, all tagged with valid sources at emitError
			//     catch sites in scout.ts / oracle.ts / builder.ts)
			// The error_source_valid_count_sum=40 joins the iter-25 6-way equality
			// invariant at 40 as a NEW 7th identity term: error_event_count_sum ==
			// distinct_error_agent_count_sum == provider_auth_failure_count_sum ==
			// auth_diagnostic_preserved_count_sum == stream_2_agent_status_count_sum
			// == stream_2_diagnostic_preserved_count_sum == error_source_valid_count_sum
			// == 40. The identity breaks if a future regression emits an error with
			// an out-of-trio source (e.g. typo, future SSE renderer agent leaking
			// through, stale pre-rename value) — error_event_count stays at 40 but
			// error_source_valid_count drops below 40, a regression class invisible
			// to the iter-44 per-role sum (iter-44 only sums the THREE valid
			// buckets; out-of-union sources would be absent from all three buckets
			// while still counted in the total). Parallel rationale for
			// stage_valid_count: a regression emitting stage-changed with
			// stage='images' (stale pre-iter-12 value) or undefined would drop
			// stage_valid_count below stage_changed_event_count while every iter-
			// 34/iter-27 timing/ordering probe stays at baseline.
			stage_valid_count_sum: sumMetric('stage_valid_count'),
			stage_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stage_valid_count ?? 0))
				: 0,
			error_source_valid_count_sum: sumMetric('error_source_valid_count'),
			error_source_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.error_source_valid_count ?? 0))
				: 0,
			// iter-56 primary-stream error.code union-membership rollup. Pairs
			// with stream_2_error_code_valid_count_sum above to close the
			// matrix on BOTH streams. Under broken-auth baseline the invariant
			// is _sum=40 _min=8 (joins the iter-25/55 equality at 40 as the
			// 8th identity term: error_event = distinct_agent = provider_auth =
			// auth_diagnostic = stream_2_agent_status = stream_2_diagnostic =
			// error_source_valid = error_code_valid = 40). Equality with
			// provider_auth_failure_count_sum (40) is regime-dependent: under
			// broken-auth they coincide, under healthy auth with mixed failure
			// modes provider_auth drops below event_count while error_code_valid
			// stays at event_count — making this probe a direct measurement
			// surface for "are non-auth failures classified into the typed
			// union, or are they slipping through as untyped strings?"
			error_code_valid_count_sum: sumMetric('error_code_valid_count'),
			error_code_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.error_code_valid_count ?? 0))
				: 0,
			// iter-58 agent.status union-membership rollups (primary + stream_2).
			// Extends the iter-41/55/56 typed-union membership family from
			// {stage, source, code, message} to the 5th and last typed-union
			// field on any SSE event (agent.status ∈ {'idle','thinking','queued',
			// 'waiting'} per types.ts:41). Under broken-auth baseline:
			//   agent_status_valid_count_sum=90 _min=18 (primary — matches the
			//     iter-31 agent_status_event_count_sum, identity invariant: every
			//     agent-status emit on the primary stream carries a valid status)
			//   stream_2_agent_status_valid_count_sum=40 _min=8 (stream_2 — joins
			//     the iter-25/54/55/56 equality at 40 as the 10th identity term:
			//     error_event = distinct_agent = provider_auth = auth_diagnostic
			//     = stream_2_agent_status = stream_2_diagnostic = error_source_valid
			//     = error_message_present = error_code_valid
			//     = stream_2_agent_status_valid = 40)
			// Orthogonal regression: a future setStatus call site passing 'running'
			// / 'done' / undefined from a typo or a stale pre-rename literal (or
			// a future status-union extension leaking an unhandled literal onto
			// the wire) would leave every iter-31/52/40 count/role/focus probe
			// intact while dropping this probe below agent_status_event_count.
			// Iter-50/51 latency derivation only fires on idle/thinking-focus
			// pairs, so an invalid status would be invisible to those probes too.
			agent_status_valid_count_sum: sumMetric('agent_status_valid_count'),
			agent_status_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_status_valid_count ?? 0))
				: 0,
			stream_2_agent_status_valid_count_sum: sumMetric('stream_2_agent_status_valid_count'),
			stream_2_agent_status_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_agent_status_valid_count ?? 0))
				: 0,
			time_to_first_stage_changed_ms_p50: percentile(
				perIntent.map((p) => p.metrics.time_to_first_stage_changed_ms),
				50
			),
			time_to_first_stage_changed_ms_p90: percentile(
				perIntent.map((p) => p.metrics.time_to_first_stage_changed_ms),
				90
			),
			// iter-37 stream-replay tightness probe — promotes the synchronous-
			// emission discipline of /api/stream's start() block into a cross-
			// intent invariant. Under the baseline:
			//   stream_2_first_event_ms_after_open — HTTP connect + first-read
			//     overhead, expected ~3-5ms across all intents (local CPU-bound,
			//     tighter than Anthropic 401 RTT's ~180ms). p90/max act as
			//     upper-bound detectors: a regression that pushes replay into
			//     a setTimeout or awaits something before emit would blow this
			//     from ~3ms to the async boundary cost (tens to hundreds of ms).
			//   stream_2_replay_span_ms — time between first and last replayed
			//     event, expected 0-1ms (all replay events emit in the same
			//     synchronous tick). A regression that scatters replay across
			//     multiple ticks (async/setTimeout inside start()) widens span
			//     while leaving count/content intact — a regression class the
			//     iter-26/27/29 count + iter-29 content probes cannot see.
			stream_2_first_event_ms_after_open_p50: percentile(
				perIntent.map((p) => p.metrics.stream_2_first_event_ms_after_open),
				50
			),
			stream_2_first_event_ms_after_open_p90: percentile(
				perIntent.map((p) => p.metrics.stream_2_first_event_ms_after_open),
				90
			),
			stream_2_first_event_ms_after_open_max: (() => {
				const vals = perIntent
					.map((p) => p.metrics.stream_2_first_event_ms_after_open)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.max(...vals) : null;
			})(),
			stream_2_replay_span_ms_p50: percentile(
				perIntent.map((p) => p.metrics.stream_2_replay_span_ms),
				50
			),
			stream_2_replay_span_ms_p90: percentile(
				perIntent.map((p) => p.metrics.stream_2_replay_span_ms),
				90
			),
			stream_2_replay_span_ms_max: (() => {
				const vals = perIntent
					.map((p) => p.metrics.stream_2_replay_span_ms)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.max(...vals) : null;
			})(),
			// iter-50 Stage 8 oracle latency surfacing. Prompt's Stage 8 list
			// names oracle_synthesis_latency; this promotes the per-intent
			// timings (scalars; null when that code path didn't fire) to
			// cross-intent p50/p90 rollups plus occurrence count sums. Under
			// the broken-auth baseline only cold-start fires (synthesis needs
			// evidence>0, reveal needs evidence>=15), so the expected invariant
			// is oracle_cold_start_count_sum=5 _min=1 with observable
			// oracle_cold_start_latency_ms_p50 (≈180-220ms, matching Anthropic
			// 401 RTT) and both oracle_synthesis_count_sum/_reveal_build_count_sum=0
			// with null p50/p90 timing rollups. Post-healthy-auth, synthesis
			// and reveal latencies become observable and both timing p50s
			// become non-null — the metric is explicitly forward-deploy for
			// the synthesis/reveal paths while immediately useful for cold-start.
			oracle_cold_start_latency_ms_p50: percentile(
				perIntent.map((p) => p.metrics.oracle_cold_start_latency_ms),
				50
			),
			oracle_cold_start_latency_ms_p90: percentile(
				perIntent.map((p) => p.metrics.oracle_cold_start_latency_ms),
				90
			),
			oracle_synthesis_latency_ms_p50: percentile(
				perIntent.map((p) => p.metrics.oracle_synthesis_latency_ms),
				50
			),
			oracle_synthesis_latency_ms_p90: percentile(
				perIntent.map((p) => p.metrics.oracle_synthesis_latency_ms),
				90
			),
			oracle_reveal_build_latency_ms_p50: percentile(
				perIntent.map((p) => p.metrics.oracle_reveal_build_latency_ms),
				50
			),
			oracle_reveal_build_latency_ms_p90: percentile(
				perIntent.map((p) => p.metrics.oracle_reveal_build_latency_ms),
				90
			),
			oracle_cold_start_count_sum: sumMetric('oracle_cold_start_count'),
			oracle_cold_start_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.oracle_cold_start_count ?? 0))
				: 0,
			oracle_synthesis_count_sum: sumMetric('oracle_synthesis_count'),
			oracle_reveal_build_count_sum: sumMetric('oracle_reveal_build_count'),
			// iter-51 Stage 8 per-agent-class latency siblings — scout probe and
			// builder scaffold. Parallel to iter-50's oracle cold-start/synthesis/
			// reveal rollups but for the other two agent classes, giving full
			// per-class latency visibility across the 3-role roster. Under the
			// broken-auth baseline BOTH fire (scout × 6 per run + builder × 1 per
			// run with ~180ms 401 RTT each), so unlike iter-50's synthesis/reveal
			// which are forward-deploy (null until auth is fixed), these light up
			// immediately: scout_probe_count_sum=30 _min=6 (6 scouts × 5 intents),
			// builder_scaffold_count_sum=5 _min=1 (1 builder × 5 intents), and
			// both latency p50/p90 rollups carry observable Anthropic RTT signal.
			// scout_probe_latency_ms_p50/p90 here are percentiles ACROSS intents
			// of each intent's own per-run p50 — a scout-specific cold-start
			// latency orthogonal to oracle_cold_start_latency_ms because they
			// cover different generateText call sites (scout.ts vs oracle.ts)
			// that could regress independently (e.g. scout-only retry loop
			// reintroduction would widen scout p90 while leaving oracle intact).
			scout_probe_latency_ms_p50: percentile(
				perIntent.map((p) => p.metrics.scout_probe_latency_ms_p50),
				50
			),
			scout_probe_latency_ms_p90: percentile(
				perIntent.map((p) => p.metrics.scout_probe_latency_ms_p50),
				90
			),
			scout_probe_latency_ms_max: (() => {
				const vals = perIntent
					.map((p) => p.metrics.scout_probe_latency_ms_max)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.max(...vals) : null;
			})(),
			scout_probe_count_sum: sumMetric('scout_probe_count'),
			scout_probe_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.scout_probe_count ?? 0))
				: 0,
			builder_scaffold_latency_ms_p50: percentile(
				perIntent.map((p) => p.metrics.builder_scaffold_latency_ms),
				50
			),
			builder_scaffold_latency_ms_p90: percentile(
				perIntent.map((p) => p.metrics.builder_scaffold_latency_ms),
				90
			),
			builder_scaffold_count_sum: sumMetric('builder_scaffold_count'),
			builder_scaffold_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.builder_scaffold_count ?? 0))
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
