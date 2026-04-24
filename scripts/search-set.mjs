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
		draft_placeholder_count: m.draft_placeholder_count ?? 0,
		draft_refined_count: m.draft_refined_count ?? 0,
		// iter-95: forward-carry draft.nextHint presence-validity probe count
		// from validate.mjs so aggregate rollups below can establish the SHOULD-
		// BE-ZERO invariant (_sum=0/_min=0) under iter-61 healthy-auth 5-intent
		// 12s-window baseline. Under rebuild-reachable forward-deploy regimes
		// the primary count flips positive, paired with iter-93's builder_hint_
		// count in lock-step via builder.ts:369-371's shared `if (output.nextHint)`
		// gate.
		draft_next_hint_present_count: m.draft_next_hint_present_count ?? 0,
		// iter-96: forward-carry draft.acceptedPatterns / .rejectedPatterns
		// presence-validity probe counts from validate.mjs so aggregate rollups
		// below can establish the SHOULD-BE-ZERO invariant (_sum=0/_min=0)
		// under iter-61 healthy-auth 5-intent 12s-window baseline. Under
		// rebuild-reachable forward-deploy regimes both counts flip positive,
		// split per-decision (accept-rebuilds populate accepted_present, reject-
		// rebuilds populate rejected_present) — higher discriminative resolution
		// than iter-95's single-channel nextHint signal.
		draft_accepted_patterns_present_count: m.draft_accepted_patterns_present_count ?? 0,
		draft_rejected_patterns_present_count: m.draft_rejected_patterns_present_count ?? 0,
		// iter-100: forward-carry draft.title / .summary / .html presence-
		// validity probe counts from validate.mjs so aggregate rollups below
		// can establish the POSITIVE-IDENTITY invariant (each = draft_updated_
		// count_sum = 10/_min=2) under iter-61 healthy-auth 5-intent 12s-window
		// baseline. All 4 emission paths populate these 3 required-string
		// fields; POSITIVE-IDENTITY family continuation from iter-97/98/99
		// distinct from iter-95/96's SHOULD-BE-ZERO family on other draft
		// fields. Saturates PrototypeDraft 6-way field-validity matrix.
		draft_title_present_count: m.draft_title_present_count ?? 0,
		draft_summary_present_count: m.draft_summary_present_count ?? 0,
		draft_html_present_count: m.draft_html_present_count ?? 0,
		draft_refined_html_length_p50: m.draft_refined_html_length_p50 ?? null,
		draft_refined_html_length_max: m.draft_refined_html_length_max ?? null,
		draft_refined_html_length_min: m.draft_refined_html_length_min ?? null,
		draft_refined_scaffold_count: m.draft_refined_scaffold_count ?? 0,
		draft_refined_rebuild_count: m.draft_refined_rebuild_count ?? 0,
		draft_refined_unknown_count: m.draft_refined_unknown_count ?? 0,
		draft_refined_scaffold_html_length_p50: m.draft_refined_scaffold_html_length_p50 ?? null,
		draft_refined_scaffold_html_length_min: m.draft_refined_scaffold_html_length_min ?? null,
		draft_refined_scaffold_html_length_max: m.draft_refined_scaffold_html_length_max ?? null,
		draft_refined_rebuild_html_length_p50: m.draft_refined_rebuild_html_length_p50 ?? null,
		draft_refined_rebuild_html_length_min: m.draft_refined_rebuild_html_length_min ?? null,
		draft_refined_rebuild_html_length_max: m.draft_refined_rebuild_html_length_max ?? null,
		synthesis_updated_count: m.synthesis_updated_count ?? 0,
		swipe_result_count: m.swipe_result_count ?? 0,
		evidence_updated_count: m.evidence_updated_count ?? 0,
		// iter-93: forward-carry count probes for the last 2 untouched
		// SSEEvent types (facade-stale, builder-hint) so aggregate rollups
		// below can establish the baseline-regime-invariant identity
		// _sum=0/_min=0 under both healthy-auth and broken-auth regimes.
		facade_stale_count: m.facade_stale_count ?? 0,
		builder_hint_count: m.builder_hint_count ?? 0,
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
		agent_status_role_valid_count: m.agent_status_role_valid_count ?? 0,
		// iter-101: forward-carry AgentState remaining-field presence-validity
		// probe counts (id, name, focus) from validate.mjs so aggregate rollups
		// below can establish POSITIVE-IDENTITY with agent_status_event_count_
		// sum=105/_min=21 under iter-61 healthy-auth 5-intent 12s-window baseline.
		// Saturates AgentState 5-way field-validity matrix alongside iter-58
		// (status) and iter-86 (role) typed-union probes.
		agent_status_id_present_count: m.agent_status_id_present_count ?? 0,
		agent_status_name_present_count: m.agent_status_name_present_count ?? 0,
		agent_status_focus_present_count: m.agent_status_focus_present_count ?? 0,
		stream_2_agent_status_valid_count: m.stream_2_agent_status_valid_count ?? 0,
		stream_2_agent_status_role_valid_count: m.stream_2_agent_status_role_valid_count ?? 0,
		// iter-101: forward-carry stream_2 counterparts for AgentState presence-
		// validity probes. Cross-stream POSITIVE-IDENTITY with primary iter-101
		// under healthy-auth baseline: each = stream_2_agent_status_count ≈
		// 40-42/_min=8 per 5-intent baseline (oscillates [40,42] per iter-89
		// note re scaffold-latency timing).
		stream_2_agent_status_id_present_count: m.stream_2_agent_status_id_present_count ?? 0,
		stream_2_agent_status_name_present_count: m.stream_2_agent_status_name_present_count ?? 0,
		stream_2_agent_status_focus_present_count: m.stream_2_agent_status_focus_present_count ?? 0,
		stage_changed_swipe_count_valid_count: m.stage_changed_swipe_count_valid_count ?? 0,
		stream_2_stage_changed_swipe_count_valid_count: m.stream_2_stage_changed_swipe_count_valid_count ?? 0,
		stream_2_draft_updated_count: m.stream_2_draft_updated_count ?? 0,
		stream_2_draft_placeholder_count: m.stream_2_draft_placeholder_count ?? 0,
		// iter-95: forward-carry stream_2 counterpart of draft.nextHint presence-
		// validity probe. Cross-stream SHOULD-BE-ZERO identity with primary
		// iter-95 under healthy-auth baseline; forward-deploys under rebuild-
		// reachable regime where /api/stream replay snapshot captures context.
		// draft after rebuild has populated nextHint.
		stream_2_draft_next_hint_present_count: m.stream_2_draft_next_hint_present_count ?? 0,
		// iter-96: forward-carry stream_2 counterparts of draft.acceptedPatterns /
		// .rejectedPatterns presence-validity probes. Cross-stream SHOULD-BE-
		// ZERO identity with primary iter-96 under healthy-auth baseline;
		// forward-deploys under rebuild-reachable regime where /api/stream
		// replay snapshot captures context.draft after rebuild has dedupe-
		// appended patterns. Same per-decision split as primary iter-96.
		stream_2_draft_accepted_patterns_present_count:
			m.stream_2_draft_accepted_patterns_present_count ?? 0,
		stream_2_draft_rejected_patterns_present_count:
			m.stream_2_draft_rejected_patterns_present_count ?? 0,
		stream_2_draft_refined_count: m.stream_2_draft_refined_count ?? 0,
		// iter-100: forward-carry stream_2 counterparts for draft.title /
		// .summary / .html presence-validity probes. Cross-stream POSITIVE-
		// IDENTITY with primary iter-100: each = stream_2_draft_updated_count
		// = 5/_min=1 per 5-intent healthy-auth baseline (replay captures draft
		// after scaffold populated all three fields). Regression classes:
		// replay-block field-corruption, envelope-wrapping drift, timing-
		// regime shift from single-draft to placeholder-only stream_2 window.
		stream_2_draft_title_present_count: m.stream_2_draft_title_present_count ?? 0,
		stream_2_draft_summary_present_count: m.stream_2_draft_summary_present_count ?? 0,
		stream_2_draft_html_present_count: m.stream_2_draft_html_present_count ?? 0,
		stream_2_facade_ready_count: m.stream_2_facade_ready_count ?? 0,
		stream_2_synthesis_updated_count: m.stream_2_synthesis_updated_count ?? 0,
		stream_2_evidence_updated_count: m.stream_2_evidence_updated_count ?? 0,
		facade_format_valid_count: m.facade_format_valid_count ?? 0,
		stream_2_facade_format_valid_count: m.stream_2_facade_format_valid_count ?? 0,
		// iter-98: Facade remaining-field presence-validity probes (primary).
		// Forward-carries the 5 required-string-field presence counts (id,
		// agentId, hypothesis, label, content) so aggregate rollups below can
		// establish identity with facade_ready_count_sum=35/_min=7 under the
		// healthy-auth 5-intent baseline. Saturates the Facade 6-way field-
		// validity matrix alongside iter-67's facade_format_valid probe.
		// iter-99: stream_2 counterparts added below — closes the explicitly-
		// named deferred follow-on, mirroring iter-82→90 (evidence items) and
		// iter-83/85→91 (synthesis items) primary-first/stream_2-second pattern.
		facade_id_present_count: m.facade_id_present_count ?? 0,
		facade_agent_id_present_count: m.facade_agent_id_present_count ?? 0,
		facade_hypothesis_present_count: m.facade_hypothesis_present_count ?? 0,
		facade_label_present_count: m.facade_label_present_count ?? 0,
		facade_content_present_count: m.facade_content_present_count ?? 0,
		// iter-99: stream_2 counterparts for iter-98's Facade 5 presence-validity
		// probes — forward-carried so the aggregate rollups below can establish
		// cross-stream identity with iter-98's primary values under healthy-auth
		// 5-intent baseline (each stream_2 metric = stream_2_facade_ready_count
		// = 30/_min=6, matching iter-67's stream_2_facade_format_valid_count).
		// Closes iter-98's explicitly-named stream_2 deferred follow-on —
		// saturates the Facade 6-way field-validity matrix on BOTH streams.
		stream_2_facade_id_present_count: m.stream_2_facade_id_present_count ?? 0,
		stream_2_facade_agent_id_present_count: m.stream_2_facade_agent_id_present_count ?? 0,
		stream_2_facade_hypothesis_present_count: m.stream_2_facade_hypothesis_present_count ?? 0,
		stream_2_facade_label_present_count: m.stream_2_facade_label_present_count ?? 0,
		stream_2_facade_content_present_count: m.stream_2_facade_content_present_count ?? 0,
		// iter-88: stream_2 counterparts for iter-72 primary synthesis content
		// probes (axes + scout_assignments count/min), forward-carried so that
		// the aggregate rollups below can establish the cross-stream identity
		// with primary-bus iter-72 values under the healthy-auth 5-intent
		// baseline (each stream_2 metric = its primary-bus counterpart = 30/6).
		stream_2_synthesis_axes_count: m.stream_2_synthesis_axes_count ?? 0,
		stream_2_synthesis_axes_min: m.stream_2_synthesis_axes_min ?? 0,
		stream_2_synthesis_scout_assignments_count: m.stream_2_synthesis_scout_assignments_count ?? 0,
		stream_2_synthesis_scout_assignments_min: m.stream_2_synthesis_scout_assignments_min ?? 0,
		// iter-89: stream_2 counterparts for iter-81's primary-bus evidence-updated
		// array-shape probes — forward-carried so that the aggregate rollups below
		// can establish cross-stream identity with iter-81's primary values under
		// the healthy-auth 5-intent baseline (each stream_2 metric equals its
		// primary-bus counterpart = 5/_min=1 for presence-validity; 1/1 for length).
		stream_2_evidence_array_valid_count: m.stream_2_evidence_array_valid_count ?? 0,
		stream_2_anti_patterns_array_valid_count: m.stream_2_anti_patterns_array_valid_count ?? 0,
		stream_2_evidence_length_min: m.stream_2_evidence_length_min ?? 0,
		stream_2_evidence_length_max: m.stream_2_evidence_length_max ?? 0,
		// iter-90: stream_2 counterparts for iter-82's primary-bus evidence-updated
		// array-element typed-union probes (item-level decision/format/latency_signal)
		// — forward-carried so that the aggregate rollups below can establish
		// cross-stream identity with iter-82's primary values under healthy-auth
		// 5-intent baseline (each stream_2 metric = its primary-bus counterpart = 5/_min=1).
		stream_2_evidence_items_valid_decision_count: m.stream_2_evidence_items_valid_decision_count ?? 0,
		stream_2_evidence_items_valid_format_count: m.stream_2_evidence_items_valid_format_count ?? 0,
		stream_2_evidence_items_valid_latency_signal_count: m.stream_2_evidence_items_valid_latency_signal_count ?? 0,
		// iter-102: stream_2 counterparts for iter-102's primary-bus SwipeEvidence
		// remaining-field presence-validity probes (facadeId, content, hypothesis,
		// implication) — forward-carried so aggregate rollups can establish cross-
		// stream identity with iter-102's primary values under the healthy-auth
		// 5-intent baseline (each stream_2 metric = its primary-bus counterpart =
		// 5/_min=1). Saturates the SwipeEvidence 7-way field-validity matrix on
		// the /api/stream replay path alongside iter-89's array-shape + iter-90's
		// typed-union probes — the evidence-updated counterpart to iter-99's
		// facade-ready 6-way saturation on stream_2.
		stream_2_evidence_items_facade_id_present_count: m.stream_2_evidence_items_facade_id_present_count ?? 0,
		stream_2_evidence_items_content_present_count: m.stream_2_evidence_items_content_present_count ?? 0,
		stream_2_evidence_items_hypothesis_present_count: m.stream_2_evidence_items_hypothesis_present_count ?? 0,
		stream_2_evidence_items_implication_present_count: m.stream_2_evidence_items_implication_present_count ?? 0,
		// iter-91: stream_2 counterparts for iter-83's primary-bus synthesis-updated.
		// axes[].confidence typed-union probe AND iter-85's scout_assignments[].scout
		// roster-membership probe — forward-carried so that the aggregate rollups below
		// can establish cross-stream identity with iter-83/85's primary values under
		// the healthy-auth 5-intent baseline (each stream_2 metric = its primary-bus
		// counterpart = 30/_min=6). Extends iter-88's whole-array length mirror to
		// within-item field validation, closing the 3rd and 4th of iter-88's 5
		// explicitly-named unclosed stream_2 counterpart backlog items.
		stream_2_synthesis_axes_valid_confidence_count: m.stream_2_synthesis_axes_valid_confidence_count ?? 0,
		// iter-103: stream_2 EmergentAxis remaining-field presence-validity probes
		// (label, poleA, poleB, evidence_basis) — saturates the EmergentAxis 5-way
		// field-validity matrix on stream_2 alongside iter-91's confidence probe.
		stream_2_synthesis_axes_label_present_count: m.stream_2_synthesis_axes_label_present_count ?? 0,
		stream_2_synthesis_axes_pole_a_present_count: m.stream_2_synthesis_axes_pole_a_present_count ?? 0,
		stream_2_synthesis_axes_pole_b_present_count: m.stream_2_synthesis_axes_pole_b_present_count ?? 0,
		stream_2_synthesis_axes_evidence_basis_present_count:
			m.stream_2_synthesis_axes_evidence_basis_present_count ?? 0,
		stream_2_synthesis_scout_assignments_valid_scout_count: m.stream_2_synthesis_scout_assignments_valid_scout_count ?? 0,
		// iter-104: stream_2 scout_assignments[] remaining-field presence-
		// validity probes (probe_axis, reason) — saturates the scout_assignments
		// 3-way field-validity matrix on stream_2 alongside iter-91's scout
		// roster probe.
		stream_2_synthesis_scout_assignments_probe_axis_present_count:
			m.stream_2_synthesis_scout_assignments_probe_axis_present_count ?? 0,
		stream_2_synthesis_scout_assignments_reason_present_count:
			m.stream_2_synthesis_scout_assignments_reason_present_count ?? 0,
		// iter-94: stream_2 counterpart for iter-94's primary-bus synthesis
		// palette-presence probe. Under iter-61 healthy-auth 5-intent 12s-window
		// baseline (cold-start synthesis only, no palette): stream_2 _sum=0
		// matching primary. A SHOULD-BE-ZERO cross-stream identity paired with
		// the primary-bus counterpart.
		stream_2_synthesis_palette_present_count: m.stream_2_synthesis_palette_present_count ?? 0,
		// iter-105: stream_2 counterparts for TasteSynthesis top-level remaining-
		// field probes (edge_case_flags array-shape + persona_anima_divergence
		// null-or-non-empty-string type validity). Forward-carried per-intent so
		// the aggregate rollups below can establish cross-stream POSITIVE-IDENTITY:
		// each = stream_2_synthesis_updated_count = 5/_min=1 under healthy-auth
		// 5-intent baseline. Saturates the TasteSynthesis struct-boundary 5-way
		// field-validity matrix on the /api/stream replay path.
		stream_2_synthesis_edge_case_flags_array_valid_count:
			m.stream_2_synthesis_edge_case_flags_array_valid_count ?? 0,
		stream_2_synthesis_persona_anima_divergence_valid_count:
			m.stream_2_synthesis_persona_anima_divergence_valid_count ?? 0,
		// iter-106: stream_2 counterpart for iter-106's primary-bus EmergentAxis
		// axes[].leaning_toward null-or-non-empty-string union-valid probe.
		// Forward-carries the stream_2 per-intent count so the aggregate rollup
		// below can establish cross-stream POSITIVE-IDENTITY: each = stream_2_
		// synthesis_axes_count = 30/_min=6 under healthy-auth 5-intent baseline
		// (cold-start leaning_toward=null for every axis, replay preserves it).
		// Saturates the EmergentAxis 6-way field-validity matrix on the /api/
		// stream replay path alongside iter-91 (confidence typed-union), iter-
		// 103 (label/poleA/poleB/evidence_basis presence-validity), and iter-88
		// (axes length).
		stream_2_synthesis_axes_leaning_toward_valid_count:
			m.stream_2_synthesis_axes_leaning_toward_valid_count ?? 0,
		swipe_decision_valid_count: m.swipe_decision_valid_count ?? 0,
		swipe_latency_bucket_valid_count: m.swipe_latency_bucket_valid_count ?? 0,
		// iter-97: SwipeRecord remaining-field presence-validity probes (primary).
		// Forward-carries facadeId/agentId/latencyMs validity counts so aggregate
		// rollups below can establish iter-80 cardinality identity (each = swipe_
		// result_count) under the healthy-auth single-swipe baseline.
		swipe_facade_id_present_count: m.swipe_facade_id_present_count ?? 0,
		swipe_agent_id_present_count: m.swipe_agent_id_present_count ?? 0,
		swipe_latency_ms_valid_count: m.swipe_latency_ms_valid_count ?? 0,
		synthesis_axes_count: m.synthesis_axes_count ?? 0,
		synthesis_axes_min: m.synthesis_axes_min ?? 0,
		synthesis_axes_valid_confidence_count: m.synthesis_axes_valid_confidence_count ?? 0,
		// iter-103: EmergentAxis remaining-field presence-validity probes (label,
		// poleA, poleB, evidence_basis) — saturates the 5-way axes matrix on the
		// primary bus alongside iter-83 confidence and iter-72 length probes.
		synthesis_axes_label_present_count: m.synthesis_axes_label_present_count ?? 0,
		synthesis_axes_pole_a_present_count: m.synthesis_axes_pole_a_present_count ?? 0,
		synthesis_axes_pole_b_present_count: m.synthesis_axes_pole_b_present_count ?? 0,
		synthesis_axes_evidence_basis_present_count: m.synthesis_axes_evidence_basis_present_count ?? 0,
		// iter-106: axes[].leaning_toward null-or-non-empty-string union-valid
		// probe on primary bus — saturates the EmergentAxis 6-way field-validity
		// matrix alongside iter-83 confidence typed-union, iter-103 4-string
		// presence-validity, and iter-72 axes length probes. Closes iter-105's
		// explicitly-named follow-on candidate (the LAST unprobed EmergentAxis
		// field). Forward-carried per-intent so aggregate rollups below can
		// establish POSITIVE-IDENTITY: count = synthesis_axes_count = 30/_min=6
		// under healthy-auth 5-intent baseline via null branch (cold-start
		// leaning_toward=null for every axis). Extends the null-or-non-empty-
		// string union-valid predicate family (introduced by iter-105 for top-
		// level persona_anima_divergence) to within-item array-element coverage.
		synthesis_axes_leaning_toward_valid_count: m.synthesis_axes_leaning_toward_valid_count ?? 0,
		synthesis_scout_assignments_count: m.synthesis_scout_assignments_count ?? 0,
		synthesis_scout_assignments_min: m.synthesis_scout_assignments_min ?? 0,
		synthesis_scout_assignments_valid_scout_count: m.synthesis_scout_assignments_valid_scout_count ?? 0,
		// iter-104: scout_assignments[] remaining-field presence-validity probes
		// (probe_axis, reason) on the primary bus — saturates the 3-way scout_
		// assignments matrix alongside iter-85 scout typed-union and iter-72
		// length probes.
		synthesis_scout_assignments_probe_axis_present_count:
			m.synthesis_scout_assignments_probe_axis_present_count ?? 0,
		synthesis_scout_assignments_reason_present_count:
			m.synthesis_scout_assignments_reason_present_count ?? 0,
		synthesis_palette_present_count: m.synthesis_palette_present_count ?? 0,
		// iter-105: TasteSynthesis top-level remaining-field probes on the
		// primary-bus synthesis-updated event (edge_case_flags array-shape +
		// persona_anima_divergence null-or-non-empty-string type validity).
		// Forward-carried per-intent so aggregate rollups below can establish
		// POSITIVE-IDENTITY: each = synthesis_updated_count = 5/_min=1 under
		// healthy-auth 5-intent baseline. Saturates the TasteSynthesis struct-
		// boundary 5-way field-validity matrix on the primary bus.
		synthesis_edge_case_flags_array_valid_count:
			m.synthesis_edge_case_flags_array_valid_count ?? 0,
		synthesis_persona_anima_divergence_valid_count:
			m.synthesis_persona_anima_divergence_valid_count ?? 0,
		evidence_array_valid_count: m.evidence_array_valid_count ?? 0,
		anti_patterns_array_valid_count: m.anti_patterns_array_valid_count ?? 0,
		evidence_length_min: m.evidence_length_min ?? 0,
		evidence_length_max: m.evidence_length_max ?? 0,
		evidence_items_valid_decision_count: m.evidence_items_valid_decision_count ?? 0,
		evidence_items_valid_format_count: m.evidence_items_valid_format_count ?? 0,
		evidence_items_valid_latency_signal_count: m.evidence_items_valid_latency_signal_count ?? 0,
		// iter-102: SwipeEvidence remaining-field presence-validity probes on
		// primary bus — forward-carried per-intent so aggregate rollups can
		// establish the 7-way item-level identity (iter-66 evidence_updated_count
		// = iter-81 evidence_array_valid = iter-82 items_valid_{decision,format,
		// latency_signal} = iter-102 items_{facade_id,content,hypothesis,
		// implication}_present = 1 per intent under healthy-auth 5-intent baseline;
		// sum=5/_min=1 aggregate). Saturates the SwipeEvidence 7-way field-
		// validity matrix on the primary bus alongside iter-97 SwipeRecord 5-way,
		// iter-98 Facade 6-way, iter-100 PrototypeDraft 6-way, iter-101 AgentState
		// 5-way matrix-saturation work — the evidence-updated counterpart in the
		// POSITIVE-IDENTITY cluster iter-97 opened.
		evidence_items_facade_id_present_count: m.evidence_items_facade_id_present_count ?? 0,
		evidence_items_content_present_count: m.evidence_items_content_present_count ?? 0,
		evidence_items_hypothesis_present_count: m.evidence_items_hypothesis_present_count ?? 0,
		evidence_items_implication_present_count: m.evidence_items_implication_present_count ?? 0,
		session_ready_intent_present_count: m.session_ready_intent_present_count ?? 0,
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
		builder_scaffold_count: m.builder_scaffold_count ?? 0,
		builder_rebuild_latency_ms: m.builder_rebuild_latency_ms ?? null,
		builder_rebuild_latency_ms_p50: m.builder_rebuild_latency_ms_p50 ?? null,
		builder_rebuild_latency_ms_max: m.builder_rebuild_latency_ms_max ?? null,
		builder_rebuild_count: m.builder_rebuild_count ?? 0
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
			// iter-64 draft refinement rollups — split iter-63's placeholder-
			// enabled draft_updated_count_sum into placeholder-still-present vs
			// LLM-refined-away. Invariant at aggregate:
			//   draft_placeholder_count_sum + draft_refined_count_sum
			//     === draft_updated_count_sum
			// Under the current healthy-auth 10s-window baseline with iter-63's
			// synchronous placeholder at builder scaffold start, expected values
			// per 5-intent set are placeholder_sum=5/_min=1 (one per session-ready)
			// and refined_sum=0/_min=0 (Haiku scaffold+rebuild rarely complete).
			// Under multi-session mode (VALIDATE_SECOND_INTENT) placeholder_min
			// doubles to 2 per intent, matching draft_updated_count_min=2. Under
			// post-latency-optimization regimes refined_sum flips positive
			// (scaffold returns within the window OR swipe-triggered rebuild
			// completes); under iter-63-revert regimes placeholder_sum drops to
			// 0 while refined_sum stays 0 — silently regressing the V0 pane-
			// never-empty contract. _min probes catch single-intent regression
			// that _sum would hide; the pair discriminates three states:
			// (1) placeholder-only (iter-63 seeded, LLM unfinished) — current,
			// (2) refined (LLM completed) — future product win,
			// (3) empty (both zero) — broken-auth or placeholder regression.
			draft_placeholder_count_sum: sumMetric('draft_placeholder_count'),
			draft_placeholder_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.draft_placeholder_count ?? 0))
				: 0,
			draft_refined_count_sum: sumMetric('draft_refined_count'),
			draft_refined_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.draft_refined_count ?? 0))
				: 0,
			// iter-95: draft.nextHint presence-validity rollup on the primary bus.
			// PrototypeDraft.nextHint (types.ts:52) is `string | undefined` and is
			// populated by ONLY ONE emission path: rebuild() at builder.ts:319-323
			// (placeholder/scaffold/reveal paths all leave it undefined or clear
			// it). Under iter-61 healthy-auth 5-intent 12s-window baseline rebuild
			// is unreachable (swipeCount<4 gate at oracle.ts:260-266 AND ~15s
			// rebuild latency past the 12s window), so:
			//   draft_next_hint_present_count_sum = 0
			//   draft_next_hint_present_count_min = 0
			// A SHOULD-BE-ZERO invariant in the current regime parallel to iter-93's
			// facade_stale_count_sum / builder_hint_count_sum and iter-94's
			// synthesis_palette_present_count_sum — all three are forward-deploy
			// probes whose baseline=0 under the current window constraints but
			// whose discriminative value emerges under widened-window / multi-
			// swipe / rebuild-reachable regimes.
			//
			// Forward-deploy identity chain under rebuild-reachable regime:
			//   draft_next_hint_present_count_sum
			//     == builder_hint_count_sum
			//     == (number of rebuild runs where output.nextHint was truthy)
			// This identity emerges because emitBuilderHint at builder.ts:369-371
			// is gated on `if (output.nextHint)` — the exact predicate that
			// populates context.draft.nextHint three lines earlier. A regression
			// that breaks the builder-hint emit without breaking the draft-updated
			// emit (or vice versa) would split this identity — the probe pair
			// provides two-sided coverage orthogonal to iter-93's single-sided
			// builder-hint count.
			//
			// Regression classes this rollup catches that iter-64/65/75/76
			// html-level rollups cannot:
			//   (a) placeholder or scaffold accidentally populating nextHint (e.g.
			//       someone adds a "warming up" hint string to the sync emit at
			//       builder.ts:454-462). Count flips 0 → 5 under healthy-auth
			//       baseline (one per intent), with iter-64's placeholder_count
			//       unchanged (still 5 per intent) — exactly the field-level
			//       regression that html-shape probes cannot see.
			//   (b) rebuild path refactor that mutates context.draft.nextHint but
			//       fails to emit draft-updated afterward. Under forward-deploy
			//       rebuild-reachable regime, builder_hint_count_sum tracks the
			//       rebuild completions (iter-93) while draft_next_hint_present_
			//       count_sum stays at 0 — the identity break pinpoints the
			//       missing emit.
			//   (c) reveal path bug where nextHint isn't cleared (builder.ts:711
			//       removed or bypassed). Under forward-deploy reveal-reachable
			//       regime, count inflates past the rebuild-success baseline
			//       because reveal's draft-updated emit carries the stale rebuild
			//       nextHint instead of the expected cleared-to-undefined state.
			//
			// Paired with stream_2 counterpart rollup (iter-95 below) for cross-
			// stream identity: under healthy-auth both _sum=0; under rebuild-
			// reachable regime primary count matches stream_2 snapshot count IF
			// context.draft.nextHint is still set at stream_2 open time (it is,
			// until the next scaffold cycle clears it). A /api/stream replay block
			// regression that drops nextHint from the snapshot payload while
			// primary retains it would drop stream_2 count below primary under
			// forward-deploy.
			draft_next_hint_present_count_sum: sumMetric('draft_next_hint_present_count'),
			draft_next_hint_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.draft_next_hint_present_count ?? 0))
				: 0,
			// iter-96: draft.acceptedPatterns / .rejectedPatterns presence-validity
			// rollups on the primary bus. Both PrototypeDraft pattern arrays
			// (types.ts:50-51) start at [] (context.ts:35-36) and are only
			// mutated by rebuild() at builder.ts:325-341 (placeholder/scaffold/
			// reveal paths leave them at the [] init or preserve rebuild's
			// state). Under iter-61 healthy-auth 5-intent 12s-window 1-swipe
			// baseline rebuild is unreachable (~15s Haiku rebuild past the 12s
			// window), so:
			//   draft_accepted_patterns_present_count_sum = 0
			//   draft_accepted_patterns_present_count_min = 0
			//   draft_rejected_patterns_present_count_sum = 0
			//   draft_rejected_patterns_present_count_min = 0
			// SHOULD-BE-ZERO invariants in the current regime parallel to
			// iter-93 (facade_stale_count, builder_hint_count), iter-94
			// (synthesis_palette_present_count), and iter-95 (draft_next_hint_
			// present_count) — all forward-deploy probes whose baseline=0 under
			// the current 12s/1-swipe window but whose discriminative value
			// emerges under widened-window / multi-swipe / rebuild-reachable
			// regimes.
			//
			// Forward-deploy identity under rebuild-reachable regime is DISTINCT
			// from iter-95's nextHint identity (which pairs with iter-93's
			// builder_hint_count via builder.ts:369-371's shared `if (output.
			// nextHint)` gate). Pattern arrays instead split per swipe DECISION:
			//   draft_accepted_patterns_present_count_sum
			//     == (number of rebuild runs where output.acceptedPatterns
			//        was non-empty AND survived dedupe-append)
			//   draft_rejected_patterns_present_count_sum
			//     == (number of rebuild runs where output.rejectedPatterns
			//        was non-empty AND survived dedupe-append)
			// These channels are INDEPENDENT — a single rebuild can populate
			// one without the other (e.g. accept rebuild emits acceptedPatterns
			// =['warm'] but rejectedPatterns stays at []), giving HIGHER
			// discriminative resolution than nextHint's single combined signal.
			//
			// Regression classes these rollups catch that iter-64/65/75/76/95
			// rollups cannot:
			//   (a) placeholder/scaffold accidentally seeding pattern arrays
			//       (e.g. someone defaults acceptedPatterns: ['warming up'] in
			//       context.ts init or a future "scaffold patterns" feature).
			//       Both counts flip from 0 → 5 per intent under healthy-auth
			//       baseline, with iter-64's placeholder_count (5) and iter-95's
			//       next_hint count (0) both unchanged — pinpoints the seed
			//       regression to the patterns fields specifically.
			//   (b) rebuild path refactor that mutates patterns but skips the
			//       emitDraftUpdated call. Under forward-deploy rebuild-
			//       reachable regime, builder_hint_count_sum (iter-93) and
			//       draft_next_hint_present_count_sum (iter-95) track rebuild
			//       completions-with-hint, but BOTH pattern_present counts stay
			//       at 0 — the missing emit is uniquely visible at the patterns
			//       layer.
			//   (c) rebuild emits acceptedPatterns ALWAYS truthy regardless of
			//       swipe decision (e.g. dedupe-append accidentally pulls from
			//       the wrong output field on reject paths). accepted count
			//       tracks ALL rebuilds while rejected count drops below match
			//       — the per-decision split discriminates accept-vs-reject
			//       corruption invisible to a single combined patterns_present
			//       probe.
			//   (d) dedupe regression where existingAccepted/existingRejected
			//       Set check is broken (builder.ts:326,334), causing repeated
			//       patterns to inflate the array. Length-based presence stays
			//       boolean (true once any pattern lands), so this rollup
			//       cannot catch growth-vs-correct-dedupe — that would need a
			//       separate iter-96-follow-on length distribution probe.
			//
			// Paired with stream_2 counterpart rollups (iter-96 below) for
			// cross-stream identity: under healthy-auth both _sum=0; under
			// rebuild-reachable regime primary count matches stream_2 snapshot
			// count IF context.draft pattern arrays are still set at stream_2
			// open time (they always are — rebuild is the only mutation site
			// and reveal does NOT clear them). A /api/stream replay block
			// regression that drops one or both arrays from the snapshot
			// payload while primary retains them would drop stream_2 count
			// below primary under forward-deploy.
			draft_accepted_patterns_present_count_sum: sumMetric(
				'draft_accepted_patterns_present_count'
			),
			draft_accepted_patterns_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.draft_accepted_patterns_present_count ?? 0)
					)
				: 0,
			draft_rejected_patterns_present_count_sum: sumMetric(
				'draft_rejected_patterns_present_count'
			),
			draft_rejected_patterns_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.draft_rejected_patterns_present_count ?? 0)
					)
				: 0,
			// iter-100: draft.title / .summary / .html presence-validity rollups
			// on the primary bus. PrototypeDraft has 3 REQUIRED-string fields
			// (types.ts:47-49) — title, summary, html — that are populated by
			// ALL 4 emission paths (placeholder/scaffold/rebuild/reveal per the
			// detailed rationale in validate.mjs primary-bus block). Under iter-61
			// healthy-auth 5-intent 12s-window baseline each draft-updated emit
			// carries non-empty strings on all three fields, so:
			//   draft_title_present_count_sum = 10 (5 placeholder + 5 refined)
			//   draft_title_present_count_min = 2 (per intent: 1 placeholder + 1
			//     refined draft-updated emit)
			//   draft_summary_present_count_sum = 10
			//   draft_summary_present_count_min = 2
			//   draft_html_present_count_sum = 10
			//   draft_html_present_count_min = 2
			// POSITIVE-IDENTITY invariants matching draft_updated_count_sum (10)
			// and draft_updated_count_min (2) under the current regime. A per-
			// field _sum below 10 or _min below 2 pinpoints a field-specific
			// emission regression that iter-64/65's html-shape probe and iter-
			// 95/96's SHOULD-BE-ZERO probes cannot surface.
			//
			// POSITIVE-IDENTITY family continuation from iter-97 (SwipeRecord
			// 5-way matrix completion) and iter-98/99 (Facade 6-way matrix on
			// both streams); third consecutive iteration in this family after
			// iter-93/94/95/96 ran 4 consecutive SHOULD-BE-ZERO iterations
			// (same-family admissibility maintained: each iteration adds
			// independent per-field discriminative power on a distinct event).
			// Saturates the PrototypeDraft 6-way field-validity matrix: 3
			// POSITIVE-IDENTITY fields (iter-100) + 3 SHOULD-BE-ZERO fields
			// (iter-95 nextHint, iter-96 acceptedPatterns, iter-96 rejectedPatterns)
			// — the draft-updated counterpart to iter-98/99's Facade 6-way
			// saturation on facade-ready.
			//
			// Forward-deploy identity chain: under rebuild-reachable or reveal-
			// reachable regimes, these counts scale with draft_updated_count_sum
			// (which itself scales with completed rebuilds/reveals). The _min
			// probe catches single-intent regression that _sum would hide — if
			// one intent's scaffold silently emits with title='', _sum drops
			// from 10 to 9 AND _min drops from 2 to 1, providing two-sided
			// discrimination between aggregate-level drift and single-intent
			// failure.
			//
			// Regression classes these rollups catch that iter-64/65/75/76/95/96
			// cannot: (a) placeholder path clearing one of the three fields
			// while html-shape passes (e.g. title assignment refactored out);
			// (b) scaffold LLM producing empty string on one field (zod parses
			// empty strings, so schema doesn't reject); (c) rebuild merge
			// typo (title = output.ttile yields undefined); (d) reveal path
			// missing field. Paired with stream_2 counterpart rollups (below)
			// for cross-stream identity: under healthy-auth each primary count
			// = 10, each stream_2 count = 5 (one less completed scaffold per
			// intent since stream_2 replay catches only the final draft state
			// at ~12s).
			draft_title_present_count_sum: sumMetric('draft_title_present_count'),
			draft_title_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.draft_title_present_count ?? 0))
				: 0,
			draft_summary_present_count_sum: sumMetric('draft_summary_present_count'),
			draft_summary_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.draft_summary_present_count ?? 0))
				: 0,
			draft_html_present_count_sum: sumMetric('draft_html_present_count'),
			draft_html_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.draft_html_present_count ?? 0))
				: 0,
			// iter-100: stream_2 counterparts for primary-bus draft.title /
			// .summary / .html presence-validity rollups. Under iter-61 healthy-
			// auth baseline /api/stream replay snapshot captures context.draft
			// AFTER scaffold populated all three fields (~12s replay window),
			// so each stream_2 count = stream_2_draft_updated_count = 5/_min=1.
			// Cross-stream POSITIVE-IDENTITY with primary iter-100.
			//
			// The 5-unit gap between primary (10) and stream_2 (5) is stable
			// across intents and matches the (placeholder + refined) vs (refined-
			// only snapshot) split — placeholder fires at session-ready and gets
			// clobbered by scaffold ~10s later before stream_2 opens at ~12s,
			// so the snapshot only replays the final refined draft. A future
			// observation of stream_2 count above 5 or below 5 under healthy-auth
			// baseline is a timing-regime shift signal distinct from per-intent-
			// count drift.
			//
			// Regression classes these rollups catch uniquely at stream_2:
			//   (a) replay-block field-corruption (e.g. a .map(d => ({...d,
			//     title: undefined})) transform inserted into +server.ts:27-29):
			//     primary stays at 10, stream_2 drops below 5 — pinpoints
			//     replay-specific mutation.
			//   (b) payload-shape divergence where stream_2 envelopes the
			//     draft differently than primary (e.g. { draft: { title:
			//     stringified JSON } }): primary holds at 10, stream_2 drops
			//     to 0 since typeof fails.
			//   (c) scaffold-never-completes regime where context.draft remains
			//     at placeholder at stream_2 open time: primary stays at 10
			//     (tracks placeholder emits), stream_2 holds at 5 (replay
			//     captures placeholder's non-empty title/summary/html). Note:
			//     this is NOT a regression — placeholder populates all three
			//     fields, so the probe still passes POSITIVE-IDENTITY. A
			//     scaffold-never-completes regime WOULD drop iter-64's refined_
			//     count while iter-100 counts stay at 5 — distinguishing
			//     field-level emission from content-quality regression.
			stream_2_draft_title_present_count_sum: sumMetric('stream_2_draft_title_present_count'),
			stream_2_draft_title_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.stream_2_draft_title_present_count ?? 0)
					)
				: 0,
			stream_2_draft_summary_present_count_sum: sumMetric(
				'stream_2_draft_summary_present_count'
			),
			stream_2_draft_summary_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.stream_2_draft_summary_present_count ?? 0)
					)
				: 0,
			stream_2_draft_html_present_count_sum: sumMetric('stream_2_draft_html_present_count'),
			stream_2_draft_html_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_draft_html_present_count ?? 0))
				: 0,
			// iter-75 draft refined html length distribution rollups — iter-74
			// reduced Haiku's scaffold output from ~5800-7300 chars (iter-71
			// observation) to ~4200-5500 chars via a prompt-level length hint
			// in SCAFFOLD_PROMPT, but there was no typed metric surfaced at
			// aggregate to confirm the length intervention holds across future
			// iterations. Converts iter-74's ad-hoc observation into a
			// forward-deploy measurement: a regression where Haiku drifts back
			// to verbose outputs (or a future further-reduction intervention
			// like tighter prompt hints, or a rebuild-path length hint per the
			// iter-74 pattern applied to SWIPE_PROMPT) is directly visible at
			// aggregate without requiring manual sample inspection.
			//
			// Distinct from iter-64's count probe (tracks emission cardinality,
			// not size), iter-51/70's latency probes (tracks time, not size),
			// and iter-67/72's content-validation probes (tracks shape, not
			// magnitude). Null at aggregate when all per-intent p50 values are
			// null (broken-auth or iter-64 refined=0 regime); non-null tier
			// aligns with iter-64's refined_count_sum >= 1 gating.
			//
			// Expected invariants under the iter-74 healthy-auth 12s-window
			// baseline: aggregate p50 should sit in the 4200-5500 range
			// matching iter-74's observed "asked for 2000-3000, got 4200-5500"
			// steering outcome. A regression that flips refined HTML back to
			// the iter-71 ~5800-7300 range would move p50 upward; a future
			// further-reduction intervention would move p50 downward below
			// 4200. Aggregation pattern matches iter-51/70's scaffold/rebuild
			// latency family: p50 (median of per-intent p50 values), p90
			// (p90 of per-intent p50 values — tail sensitivity), max (max of
			// per-intent max values — single-worst-refined-draft ceiling).
			draft_refined_html_length_p50: percentile(
				perIntent.map((p) => p.metrics.draft_refined_html_length_p50),
				50
			),
			draft_refined_html_length_p90: percentile(
				perIntent.map((p) => p.metrics.draft_refined_html_length_p50),
				90
			),
			draft_refined_html_length_max: (() => {
				const vals = perIntent
					.map((p) => p.metrics.draft_refined_html_length_max)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.max(...vals) : null;
			})(),
			draft_refined_html_length_min: (() => {
				const vals = perIntent
					.map((p) => p.metrics.draft_refined_html_length_min)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.min(...vals) : null;
			})(),
			// iter-76: scaffold-vs-rebuild source split rollups on refined-draft
			// html length and count. iter-75's collapsed metric was named in its
			// own learnings as deferring "split draft_refined_html_length by
			// source (scaffold-refined vs rebuild-refined) to discriminate these
			// two tails" — iter-76 closes that gap. Anchor: validate-latest.json
			// from the iter-75 multi-session run shows refined html lengths of
			// 1498c (rebuild) and 4222c (scaffold) collapsed into the same
			// distribution, hiding the 2.8× tail divergence. Identity invariant
			// at aggregate (per intent and across intents):
			//   draft_refined_scaffold_count_sum + draft_refined_rebuild_count_sum
			//     + draft_refined_unknown_count_sum === draft_refined_count_sum
			// Distinct from iter-75's collapsed length probe (no source axis),
			// iter-67/72's content-validation probes (tracks shape, not source),
			// and iter-51/70's per-call latency probes (tracks time per source,
			// not output size per source). Forward-deploy: rebuild_count_min
			// flips from 0→1 when a future product win brings rebuild completion
			// inside the default 12s window (e.g. via SWIPE_PROMPT trim), at
			// which point rebuild_html_length_p50 becomes the discriminative
			// surface for rebuild-output-quality regressions.
			//
			// Expected baselines under iter-74 healthy-auth 12s window:
			//   scaffold_count_sum=5 _min=1, rebuild_count_sum=0 _min=0,
			//   unknown_count_sum=0 _min=0; scaffold_html_length_p50≈4988c
			//   matching iter-75's collapsed p50; rebuild_html_length_*=null
			//   across the board (no completed rebuilds in 12s window).
			// Expected baselines under multi-session 20s window: scaffold_count_
			// sum=2 (both sessions), rebuild_count_sum=1 (one swipe-triggered
			// rebuild), scaffold_html_length_min=1498c (iter-76 anchor — the
			// session-2 stale-scaffold-overwrites-rebuild bug surfaces here),
			// rebuild_html_length_p50=4222c.
			draft_refined_scaffold_count_sum: sumMetric('draft_refined_scaffold_count'),
			draft_refined_scaffold_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.draft_refined_scaffold_count ?? 0))
				: 0,
			draft_refined_rebuild_count_sum: sumMetric('draft_refined_rebuild_count'),
			draft_refined_rebuild_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.draft_refined_rebuild_count ?? 0))
				: 0,
			draft_refined_unknown_count_sum: sumMetric('draft_refined_unknown_count'),
			draft_refined_unknown_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.draft_refined_unknown_count ?? 0))
				: 0,
			draft_refined_scaffold_html_length_p50: percentile(
				perIntent.map((p) => p.metrics.draft_refined_scaffold_html_length_p50),
				50
			),
			draft_refined_scaffold_html_length_p90: percentile(
				perIntent.map((p) => p.metrics.draft_refined_scaffold_html_length_p50),
				90
			),
			draft_refined_scaffold_html_length_max: (() => {
				const vals = perIntent
					.map((p) => p.metrics.draft_refined_scaffold_html_length_max)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.max(...vals) : null;
			})(),
			draft_refined_scaffold_html_length_min: (() => {
				const vals = perIntent
					.map((p) => p.metrics.draft_refined_scaffold_html_length_min)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.min(...vals) : null;
			})(),
			draft_refined_rebuild_html_length_p50: percentile(
				perIntent.map((p) => p.metrics.draft_refined_rebuild_html_length_p50),
				50
			),
			draft_refined_rebuild_html_length_p90: percentile(
				perIntent.map((p) => p.metrics.draft_refined_rebuild_html_length_p50),
				90
			),
			draft_refined_rebuild_html_length_max: (() => {
				const vals = perIntent
					.map((p) => p.metrics.draft_refined_rebuild_html_length_max)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.max(...vals) : null;
			})(),
			draft_refined_rebuild_html_length_min: (() => {
				const vals = perIntent
					.map((p) => p.metrics.draft_refined_rebuild_html_length_min)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.min(...vals) : null;
			})(),
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
			// iter-86 agent.role union-membership rollups (primary + stream_2).
			// Companion to iter-58's agent.status rollups, closing the 2nd
			// typed-union field on AgentState payload (agent.role ∈ {'scout',
			// 'builder','oracle'} per types.ts:40). The iter-40/52 per-role
			// counts (scout/oracle/builder) classify by role equality but fall
			// through silently on any unknown role value, so their sum CAN drop
			// below agent_status_event_count without any probe firing — a gap
			// iter-58's status probe cannot see (status field is role-independent).
			//
			// Cross-references:
			//   types.ts:40 AgentState.role: 'scout' | 'builder' | 'oracle'
			//   scout.ts:32-39 SCOUT_ROSTER (6 agents, role='scout')
			//   oracle.ts:135 ORACLE_AGENT (role='oracle')
			//   builder.ts:BUILDER_AGENT (role='builder')
			//
			// Under iter-74 healthy-auth 5-intent 12s-window baseline:
			//   agent_status_role_valid_count_sum ≈ 105 _min ≈ 21 (matches the
			//     iter-31 agent_status_event_count_sum=105, identity invariant:
			//     every primary-stream agent-status emit carries a valid role)
			//   stream_2_agent_status_role_valid_count_sum = 40 _min = 8
			//     (matches stream_2_agent_status_count_sum=40 across 5 intents)
			//
			// Under broken-auth baseline:
			//   agent_status_role_valid_count_sum=90 _min=18 (per-intent 2 replay
			//     idle + 8 scout thinking + 8 scout post-failure idle with
			//     provider-auth-failed focus, all valid 'scout' role from
			//     SCOUT_ROSTER[].role constant)
			//   stream_2_agent_status_role_valid_count_sum=40 _min=8 (6 scouts
			//     + 1 oracle + 1 builder in the /api/stream replay block with
			//     valid roles)
			//
			// Three-way identity at aggregate:
			//   agent_status_role_valid_count_sum ==
			//     agent_status_scout_count_sum +
			//     agent_status_oracle_count_sum +
			//     agent_status_builder_count_sum ==
			//     agent_status_event_count_sum
			// A regression where the sum of per-role counts drops below
			// agent_status_event_count (e.g., a future role-union extension
			// leaking 'critic' through an uncaught branch) would also drop
			// role_valid_count below agent_status_event_count, pinpointing the
			// off-union emission without needing 3 separate count alerts.
			//
			// Orthogonal regression classes this probe uniquely catches:
			//   - a future role-union extension ('critic','synth','moderator')
			//     leaking onto the wire from a new AgentState construction site
			//     that iter-40/52 per-role counters would silently uncategorize
			//   - a typo/refactor setting agent.role to undefined/null/empty
			//     string — invisible to iter-31 (total count), iter-58 (status
			//     probe — filters on status field), iter-50/51 (latency
			//     derivation — filters on role === 'scout'/'oracle'/'builder'
			//     via agentId prefix, independent of role field)
			//   - cross-session state leak where a scout agent's role gets
			//     mutated to 'oracle' mid-session — would keep all iter-40/52
			//     per-role counters ABOVE baseline (double-counting) but drop
			//     this probe below event_count if the mutation is 'unknown'
			//
			// Pairs with iter-58's agent.status probe to establish complete
			// typed-union coverage on AgentState payload fields across both
			// streams — the 2nd and final typed-union field on this event type.
			agent_status_role_valid_count_sum: sumMetric('agent_status_role_valid_count'),
			agent_status_role_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_status_role_valid_count ?? 0))
				: 0,
			stream_2_agent_status_role_valid_count_sum: sumMetric('stream_2_agent_status_role_valid_count'),
			stream_2_agent_status_role_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_agent_status_role_valid_count ?? 0))
				: 0,
			// iter-101: AgentState remaining-field presence-validity rollups
			// (id, name, focus) on both primary and stream_2. Saturates the
			// AgentState 5-way field-validity matrix alongside iter-58 status
			// (typed-union) and iter-86 role (typed-union) probes — the
			// AgentState counterpart to iter-97's SwipeRecord 5-way matrix,
			// iter-98/99's Facade 6-way matrix, and iter-100's PrototypeDraft
			// 6-way matrix saturations.
			//
			// AgentState (types.ts:37-44) has 5 required fields:
			//   id: string         — agent identity (e.g. 'scout-01', 'oracle')
			//   name: string       — display name (e.g. 'Iris', 'Meridian')
			//   role: typed-union  — PROBED iter-86
			//   status: typed-union — PROBED iter-58
			//   focus: string      — current-activity descriptor
			// Plus 1 optional field (lastFacadeId?) not probed — absence is in-regime.
			//
			// Under iter-61 healthy-auth 5-intent 12s-window baseline:
			//   agent_status_id_present_count_sum = 105 _min = 21 (primary —
			//     matches iter-31 agent_status_event_count_sum=105 and iter-58
			//     agent_status_valid_count_sum=105 and iter-86 agent_status_role_
			//     valid_count_sum=105 identity — every primary agent-status emit
			//     carries a valid id string)
			//   agent_status_name_present_count_sum = 105 _min = 21 (primary —
			//     same identity as id)
			//   agent_status_focus_present_count_sum = 105 _min = 21 (primary —
			//     same identity; focus is always non-empty under current
			//     12s-window healthy-auth regime because clean-exit setStatus(
			//     agent, 'idle', '') at scout.ts:507 is unreachable within 12s —
			//     verified via debug-latest probe showing 21 emits all with
			//     non-empty focus values like 'generating probe', '"label"',
			//     'monitoring', 'analyzing accept on ...'.)
			//   stream_2_agent_status_id_present_count_sum = 40-42 _min = 8
			//     (stream_2 — matches iter-66 stream_2_agent_status_count_sum
			//     baseline with [40,42] range per iter-89 note re scaffold-
			//     latency edge timing; identity holds with iter-58's stream_2_
			//     agent_status_valid_count and iter-86's stream_2_agent_status_
			//     role_valid_count)
			//   stream_2_agent_status_name_present_count_sum = 40-42 _min = 8
			//   stream_2_agent_status_focus_present_count_sum = 40-42 _min = 8
			//
			// Under broken-auth baseline (pre-iter-61): agent_status_event_count=
			//   90 per 5-intent (18/intent — 2 replay + 8 scout thinking + 8
			//   scout idle-with-auth-failed-focus); all 3 new probes track
			//   agent_status_event_count_sum=90/_min=18 because initial replay
			//   emits with focus='' do not fire from scout.ts construction
			//   (scouts are only constructed, first emit is setStatus with
			//   non-empty focus).
			//
			// Five-way AgentState identity chain under healthy-auth 5-intent:
			//   agent_status_event_count_sum (iter-31) =
			//   agent_status_valid_count_sum (iter-58) =
			//   agent_status_role_valid_count_sum (iter-86) =
			//   agent_status_id_present_count_sum (iter-101) =
			//   agent_status_name_present_count_sum (iter-101) =
			//   agent_status_focus_present_count_sum (iter-101) = 105
			// With the matching stream_2 identity at 40-42 matching stream_2_
			// agent_status_count_sum (iter-66) + iter-58/86/101 stream_2 siblings.
			// An observation where any field's _sum drops below agent_status_
			// event_count_sum under healthy-auth regime uniquely pinpoints that
			// field's emission regression while leaving iter-31/58/86 probes at
			// identity.
			//
			// Regression classes these rollups catch that iter-31/52/58/86 cannot:
			//   (a) scout construction at scout.ts:229-236 passes id=undefined
			//     from an upstream agentId generator bug: event_count holds at
			//     105, status/role_valid hold, id_present drops below 105 —
			//     pinpoints id-generation corruption invisible to typed-union
			//     probes (status/role still valid literals).
			//   (b) setStatus call site refactor flips focus to null/undefined
			//     via a typo (focus = focus ?? undefined instead of ''):
			//     event_count + status + role all hold at 105, focus_present
			//     drops — catches per-field payload corruption distinct from
			//     iter-29 diagnostic_preserved (SPECIFIC-VALUE probe for 'provider
			//     auth failed', not presence).
			//   (c) name stripped by a refactor that renames field in SCOUT_
			//     ROSTER but misses one emit path: event_count holds, role_valid
			//     holds, name_present drops — catches partial-rename drift.
			//   (d) SSE serializer (bus.ts emit chain) strips entire 'agent'
			//     field (JSON.stringify circular-ref bug or Symbol key): ALL 5
			//     AgentState field probes (iter-58/86/101) collapse to 0
			//     simultaneously while agent_status_event_count holds at 105 —
			//     distinguishes serialization-level from field-specific corruption.
			//
			// Stream_2 cross-stream identity catches regressions invisible to
			// primary-only probes: a replay-block bug in +server.ts:33-35 that
			// preserves stream_2_agent_status_count (the loop still fires per
			// context.agent) but corrupts individual fields (a .map transform,
			// a clone-then-truncate bug, field rename that misses the replay
			// emit) would leave primary iter-101 at identity while dropping
			// these stream_2 probes below stream_2_agent_status_count.
			//
			// POSITIVE-IDENTITY family continuation: iter-97 SwipeRecord, iter-
			// 98/99 Facade, iter-100 PrototypeDraft, iter-101 AgentState — 5
			// consecutive iterations saturating event-type field-validity
			// matrices, each on a distinct event type. After iter-101, the 4
			// largest SSEEvent payloads (Facade, SwipeRecord, PrototypeDraft,
			// AgentState) all have saturated field-validity matrices across both
			// primary and stream_2 where replayed. Remaining harness-completeness
			// audit surfaces: (a) TasteSynthesis array-element remaining fields
			// (EmergentAxis label/poleA/poleB/evidence_basis — iter-83 covered
			// confidence; scout_assignments probe_axis/reason — iter-85 covered
			// scout); (b) SwipeEvidence remaining-field presence (facadeId/
			// content/hypothesis/implication on evidence[] items — iter-82
			// covered decision/format/latencySignal); (c) error event fields
			// beyond iter-14/54/56 (agentId presence — covered by distinct_
			// error_agent_count implicitly). Each is a natural follow-on
			// candidate if harness-completeness continues as the chosen axis.
			agent_status_id_present_count_sum: sumMetric('agent_status_id_present_count'),
			agent_status_id_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_status_id_present_count ?? 0))
				: 0,
			agent_status_name_present_count_sum: sumMetric('agent_status_name_present_count'),
			agent_status_name_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_status_name_present_count ?? 0))
				: 0,
			agent_status_focus_present_count_sum: sumMetric('agent_status_focus_present_count'),
			agent_status_focus_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_status_focus_present_count ?? 0))
				: 0,
			stream_2_agent_status_id_present_count_sum: sumMetric(
				'stream_2_agent_status_id_present_count'
			),
			stream_2_agent_status_id_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.stream_2_agent_status_id_present_count ?? 0)
					)
				: 0,
			stream_2_agent_status_name_present_count_sum: sumMetric(
				'stream_2_agent_status_name_present_count'
			),
			stream_2_agent_status_name_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.stream_2_agent_status_name_present_count ?? 0)
					)
				: 0,
			stream_2_agent_status_focus_present_count_sum: sumMetric(
				'stream_2_agent_status_focus_present_count'
			),
			stream_2_agent_status_focus_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.stream_2_agent_status_focus_present_count ?? 0)
					)
				: 0,
			// iter-60 session-ready.intent content-presence rollup. Closes the
			// last unprobed content field across all SSE event types — iter-20
			// added the count probe + distinct-intent multi-session identity,
			// but never validated each session-ready event's intent was a non-
			// empty string. Under broken-auth baseline: _sum=5 _min=1 across
			// the 5-intent search-set (identity with iter-20's per-intent
			// session_ready_count=1, because POST /api/session rejects empty
			// intents at the endpoint level and seedSession forwards
			// trimmedIntent to emitSessionReady without mutation). A
			// regression where seedSession drops or mutates the intent field
			// to undefined/null/empty — invisible to every iter-20 through
			// iter-59 probe (count stays intact; distinct_intent could still
			// register 1 with a shared empty string) — would drop _min below
			// 1 while session_ready_count stays at its baseline. Under multi-
			// session mode the probe doubles from 1 to 2 per intent,
			// confirming both session-ready emissions carry valid intents.
			session_ready_intent_present_count_sum: sumMetric('session_ready_intent_present_count'),
			session_ready_intent_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.session_ready_intent_present_count ?? 0))
				: 0,
			// iter-61 stage-changed.swipeCount integer-validity rollups (primary +
			// stream_2). Closes the last unprobed field on the stage-changed event
			// type per types.ts:87 ({stage, swipeCount}) after iter-41/55 covered
			// the stage field on both streams. Validation predicate:
			// typeof === 'number' && Number.isInteger && >= 0. Under broken-auth
			// baseline:
			//   stage_changed_swipe_count_valid_count_sum=5 _min=1 (primary —
			//     matches the iter-34 stage_changed_event_count_sum baseline
			//     of 5/5 since exactly one stage-changed event fires per intent
			//     on the primary stream, from the /api/stream replay at connect
			//     with context.swipeCount=0 on a fresh context)
			//   stream_2_stage_changed_swipe_count_valid_count_sum=5 _min=1
			//     (stream_2 — matches stream_2_stage_changed_count baseline of
			//     5/5 since the replay block emits exactly one stage-changed
			//     event per stream_2 open, with context.swipeCount=0 under
			//     broken-auth)
			// Orthogonal regression class: a payload-shape bug that strips the
			// swipeCount field from the wire, coerces it to string, leaks NaN
			// from an arithmetic bug in context.onSwipe, or decrements past 0
			// would be invisible to iter-41/55's stage union-membership probes
			// (which filter on the stage field) and invisible to iter-34's
			// count probe (which doesn't touch the payload), but would drop
			// these _min rollups below 1.
			stage_changed_swipe_count_valid_count_sum: sumMetric('stage_changed_swipe_count_valid_count'),
			stage_changed_swipe_count_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stage_changed_swipe_count_valid_count ?? 0))
				: 0,
			stream_2_stage_changed_swipe_count_valid_count_sum: sumMetric(
				'stream_2_stage_changed_swipe_count_valid_count'
			),
			stream_2_stage_changed_swipe_count_valid_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.stream_2_stage_changed_swipe_count_valid_count ?? 0
						)
					)
				: 0,
			// iter-65 stream_2 draft-replay rollups — mirror iter-64's primary-
			// stream draft_placeholder/draft_refined split onto the /api/stream
			// replay path. Under iter-61's healthy-auth regime with iter-63's
			// synchronous placeholder at session-ready, context.draft.html is
			// reliably set before stream_2 opens, so the replay block at
			// +server.ts:27-29 emits exactly one draft-updated per stream_2
			// connect. Expected baseline under 14s-window healthy auth:
			//   stream_2_draft_updated_count_sum=5 _min=1 (one replay per intent)
			//   stream_2_draft_placeholder_count_sum=5 _min=1 (scaffold rarely
			//     completes before stream_2 opens at ~13s)
			//   stream_2_draft_refined_count_sum=0 _min=0 (forward-deploy: flips
			//     positive when scaffold latency improves OR stream_2 opens
			//     later than rebuild completion)
			// Identity invariant (per intent, per aggregate):
			//   stream_2_draft_placeholder_count + stream_2_draft_refined_count
			//     === stream_2_draft_updated_count
			// Regression classes:
			//   - iter-63 placeholder revert: all three probes drop to 0 (context.
			//     draft.html not set at session-ready, replay block's gate falsy)
			//   - /api/stream replay gate broken (+server.ts:27 condition): all
			//     three probes drop to 0 while primary iter-64 probes stay intact
			//   - payload corruption (context.draft mutated between set and
			//     replay): _updated stays at 1 but _placeholder AND _refined
			//     both drop to 0 (neither filter matches), exposing the identity
			//     violation that primary-only probes cannot see
			// Orthogonal to iter-64's primary-stream split: primary tests
			// event-emission integrity on the live bus; stream_2 tests snapshot-
			// replay integrity at connect time. A regression that fires draft-
			// updated live but drops it from replay would leave iter-64 intact
			// while collapsing these three probes.
			stream_2_draft_updated_count_sum: sumMetric('stream_2_draft_updated_count'),
			stream_2_draft_updated_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_draft_updated_count ?? 0))
				: 0,
			stream_2_draft_placeholder_count_sum: sumMetric('stream_2_draft_placeholder_count'),
			stream_2_draft_placeholder_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_draft_placeholder_count ?? 0))
				: 0,
			stream_2_draft_refined_count_sum: sumMetric('stream_2_draft_refined_count'),
			stream_2_draft_refined_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_draft_refined_count ?? 0))
				: 0,
			// iter-95: stream_2 counterpart for iter-95's primary-bus draft.nextHint
			// presence-validity rollup. /api/stream replay at +server.ts:27-29
			// emits draft-updated when context.draft.html is set — the payload is
			// context.draft by reference, so stream_2 carries whatever nextHint
			// state is on context.draft at open time. Under iter-61 healthy-auth
			// 5-intent 12s-window baseline rebuild is unreachable within the
			// window, so context.draft.nextHint is never populated; the replay
			// carries undefined on the wire, yielding:
			//   stream_2_draft_next_hint_present_count_sum = 0
			//   stream_2_draft_next_hint_present_count_min = 0
			// Cross-stream SHOULD-BE-ZERO identity with primary iter-95 rollup.
			// Forward-deploy transition under a rebuild-reachable regime: when
			// rebuild completes before stream_2 opens, context.draft.nextHint is
			// set; the replay emits a draft-updated with nextHint populated so
			// stream_2 count rises to match the snapshot replay count (1 per
			// intent — +server.ts:27 only fires once per stream_2 connect, gated
			// on html non-empty). A /api/stream replay block regression that
			// drops nextHint from the snapshot payload while primary retains it
			// would drop stream_2 count below primary under forward-deploy — two-
			// sided coverage that primary-only probes cannot provide.
			stream_2_draft_next_hint_present_count_sum: sumMetric('stream_2_draft_next_hint_present_count'),
			stream_2_draft_next_hint_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.stream_2_draft_next_hint_present_count ?? 0)
					)
				: 0,
			// iter-96: stream_2 counterparts for iter-96 primary-bus draft.
			// acceptedPatterns / .rejectedPatterns presence-validity rollups.
			// /api/stream replay at +server.ts:27-29 emits draft-updated when
			// context.draft.html is non-empty — the payload is context.draft by
			// reference, so stream_2 carries whatever pattern array state is on
			// context.draft at open time. Under iter-61 healthy-auth 5-intent
			// 12s-window baseline rebuild is unreachable within the window, so
			// context.draft.acceptedPatterns / .rejectedPatterns stay at the []
			// init from context.ts:35-36; the replay carries the empty arrays
			// on the wire, yielding:
			//   stream_2_draft_accepted_patterns_present_count_sum = 0
			//   stream_2_draft_accepted_patterns_present_count_min = 0
			//   stream_2_draft_rejected_patterns_present_count_sum = 0
			//   stream_2_draft_rejected_patterns_present_count_min = 0
			// Cross-stream SHOULD-BE-ZERO identity with primary iter-96 rollups.
			// Forward-deploy transition under a rebuild-reachable regime: when
			// rebuild completes before stream_2 opens, context.draft pattern
			// arrays are populated; the replay emits a draft-updated with non-
			// empty arrays so stream_2 counts rise to match the snapshot replay
			// count (1 per intent — +server.ts:27 only fires once per stream_2
			// connect, gated on html non-empty). Same per-decision split as
			// primary iter-96 — accepted and rejected channels independent.
			// A /api/stream replay block regression that drops one or both
			// pattern arrays from the snapshot payload while primary retains
			// them would drop stream_2 count below primary under forward-deploy
			// — two-sided per-decision coverage that primary-only probes cannot
			// provide. This pattern (primary + stream_2 paired in same iter)
			// continues the iter-89-91 backlog-closure cadence: any new draft-
			// updated content probe naturally requires both stream sides.
			stream_2_draft_accepted_patterns_present_count_sum: sumMetric(
				'stream_2_draft_accepted_patterns_present_count'
			),
			stream_2_draft_accepted_patterns_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.stream_2_draft_accepted_patterns_present_count ?? 0
						)
					)
				: 0,
			stream_2_draft_rejected_patterns_present_count_sum: sumMetric(
				'stream_2_draft_rejected_patterns_present_count'
			),
			stream_2_draft_rejected_patterns_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.stream_2_draft_rejected_patterns_present_count ?? 0
						)
					)
				: 0,
			// iter-66: close the three remaining unprobed cells on /api/stream
			// replay (iter-65 explicitly named these as future harness-completeness
			// opportunities). Under iter-61's healthy-auth regime the replay
			// block at +server.ts:24-38 emits six event types — three already had
			// first-class stream_2 probes before iter-66 (agent-status iter-26,
			// stage-changed iter-27, draft-updated iter-65) plus the error
			// replay (iter-26/39/41/54/55/56). iter-66 closes the remaining
			// three: facade-ready (one per context.facades entry),
			// synthesis-updated (one if context.synthesis is present),
			// evidence-updated (one if context.evidence.length > 0). Expected
			// baselines vary by regime:
			//   - broken-auth (pre-iter-61): all three _sum=0 _min=0 because
			//     context never accumulates facades/synthesis/evidence under
			//     401 failure.
			//   - healthy-auth (current, 12-14s window): _sum varies with
			//     timing of stream_2 open relative to when scouts/oracle fill
			//     context. Typical: facade_ready_sum=~20-30 _min=~4-6 across
			//     5 intents (~4-6 facades at replay time per intent; only 6-7
			//     facades total per session but stream_2 opens before last);
			//     synthesis_updated_sum=~5 _min=~1 (synthesis is single-emit);
			//     evidence_updated_sum=~5 _min=~1 (evidence-updated is also
			//     single-emit per session under current oracle flow).
			// Regression classes these catch:
			//   - /api/stream replay of facade-ready dropped (+server.ts:36-38
			//     for-loop broken): stream_2_facade_ready_count collapses to 0
			//     while primary facade_ready_count stays at 7.
			//   - /api/stream replay of synthesis-updated dropped (+server.ts:24-26
			//     gate broken): stream_2_synthesis_updated_count collapses to 0
			//     while primary synthesis_updated_count stays at 1.
			//   - /api/stream replay of evidence-updated dropped (+server.ts:30-32
			//     gate broken): stream_2_evidence_updated_count collapses to 0
			//     while primary evidence_updated_count stays at 1.
			//   - context state drift (facades array mutated mid-replay,
			//     synthesis overwritten between set and replay): counts drift
			//     from expected without breaking primary metrics.
			// Orthogonal to every existing stream_2 probe: none of the count/
			// content/cardinality/membership/timing probes on agent-status /
			// error / stage-changed / draft-updated would catch a replay-only
			// regression on these three event types. With iter-66, the full
			// 6-event-type × stream_2 matrix is closed on count dimension.
			stream_2_facade_ready_count_sum: sumMetric('stream_2_facade_ready_count'),
			stream_2_facade_ready_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_facade_ready_count ?? 0))
				: 0,
			stream_2_synthesis_updated_count_sum: sumMetric('stream_2_synthesis_updated_count'),
			stream_2_synthesis_updated_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_synthesis_updated_count ?? 0))
				: 0,
			stream_2_evidence_updated_count_sum: sumMetric('stream_2_evidence_updated_count'),
			stream_2_evidence_updated_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_updated_count ?? 0))
				: 0,
			// iter-67: facade.format union-membership rollups (primary + stream_2)
			// — first content-probe aggregates on the facade-ready event type,
			// closing the 66-iteration gap where facade-ready had only count
			// rollups. Under iter-61's healthy-auth baseline with V0 stage='words',
			// every facade carries format='word', so the identity invariants are:
			//   facade_format_valid_count_sum = facade_ready_count_sum = 35 _min=7
			//     (primary — 7 facades × 5 intents, all format='word')
			//   stream_2_facade_format_valid_count_sum = stream_2_facade_ready_
			//     count_sum = 30 _min=6 (stream_2 — 6 facades replayed at snapshot
			//     per iter-66, one late-arriving facade missed)
			// Regression classes these aggregate rollups catch that the iter-66
			// count rollups cannot:
			//   - facade-ready emit site passes format=undefined: facade_ready_
			//     count stays at 7/6 while facade_format_valid drops to 0.
			//   - format='image' stale literal reintroduced from pre-iter-12
			//     cleanup: both count rollups hold, format_valid collapses to 0.
			//   - format=null from JSON.stringify of a Date/enum object: count
			//     rollups hold, format_valid collapses below the count.
			// Forward-deploy discriminator for future stage='mockups' regime: when
			// scouts emit format='mockup' facades, the 'mockup' ∈ {'word','mockup'}
			// union continues to hold identity — unlike specific-value probes
			// (e.g. a hypothetical 'facade_word_count') that would drop when the
			// product correctly advances to mockup-format facades. This is the
			// preferred pattern per iter-56's 'specific-value ≠ union-membership'
			// learning, replicated on the facade-ready event.
			facade_format_valid_count_sum: sumMetric('facade_format_valid_count'),
			facade_format_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.facade_format_valid_count ?? 0))
				: 0,
			stream_2_facade_format_valid_count_sum: sumMetric('stream_2_facade_format_valid_count'),
			stream_2_facade_format_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_facade_format_valid_count ?? 0))
				: 0,
			// iter-98: Facade remaining-field presence-validity rollups — saturates
			// the Facade 6-way field-validity matrix by adding the 5 required
			// string fields (id, agentId, hypothesis, label, content) not covered
			// by iter-67's format typed-union probe. Matches iter-97's 5-way
			// SwipeRecord saturation pattern on a different event type — facade-
			// ready instead of swipe-result — completing the presence-validity
			// coverage for the most-emitted event type per intent (7/intent under
			// healthy auth).
			//
			// Family: POSITIVE-IDENTITY (continues iter-97's shift from the iter-
			// 93/94/95/96 SHOULD-BE-ZERO cluster). Under iter-61 healthy-auth
			// 5-intent baseline each _sum = facade_ready_count_sum = 35, each
			// _min = 7 (all 7 facades per intent carry all 5 fields). Six-way
			// identity: facade_id_present = facade_agent_id_present = facade_
			// hypothesis_present = facade_label_present = facade_content_present
			// = facade_format_valid (iter-67) = facade_ready_count = 35/_min=7.
			//
			// Regression classes these aggregate rollups catch that iter-67 +
			// facade_ready_count_sum cannot:
			//   - scout.ts emits facade.id='' (generator bug): _sum drops below
			//     35 / _min drops to <7 while facade_format_valid holds at 35.
			//   - scout bootstrap skips agentId assignment: facade_agent_id_
			//     present_count_sum drops to 0 / _min to 0, distinguishing
			//     scout-attribution corruption from field-shape corruption.
			//   - LLM output drops hypothesis in one facade: _sum drops by the
			//     number of affected facades, _min drops per-affected-intent.
			//   - silent field-rename refactor (e.g. 'content' → 'body'): _sum
			//     and _min collapse to 0 on the renamed field while format_valid
			//     holds — pinpoints rename drift.
			//   - SSE serializer strips the entire facade field: ALL 6 Facade
			//     field probes (iter-67 + iter-98) collapse to 0 simultaneously
			//     while facade_ready_count_sum holds at 35 — distinguishes
			//     serialization-level from field-specific corruption.
			//
			// Forward-deploy: when future multi-stage validators advance stage to
			// 'mockups' and scouts emit mockup-format facades, all 5 present-
			// validity probes continue to hold identity because mockup facades
			// still populate all 5 required fields — probe is baseline-regime-
			// invariant just like iter-67's facade_format_valid_count.
			//
			// Stream_2 counterparts deferred to a follow-on iteration (iter-67
			// paired primary+stream_2 from day one for a single field; bundling 5
			// fields × 2 streams in one iteration would exceed the scope pattern
			// established by iter-82/90 primary-then-stream_2 pairing).
			facade_id_present_count_sum: sumMetric('facade_id_present_count'),
			facade_id_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.facade_id_present_count ?? 0))
				: 0,
			facade_agent_id_present_count_sum: sumMetric('facade_agent_id_present_count'),
			facade_agent_id_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.facade_agent_id_present_count ?? 0))
				: 0,
			facade_hypothesis_present_count_sum: sumMetric('facade_hypothesis_present_count'),
			facade_hypothesis_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.facade_hypothesis_present_count ?? 0))
				: 0,
			facade_label_present_count_sum: sumMetric('facade_label_present_count'),
			facade_label_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.facade_label_present_count ?? 0))
				: 0,
			facade_content_present_count_sum: sumMetric('facade_content_present_count'),
			facade_content_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.facade_content_present_count ?? 0))
				: 0,
			// iter-99: stream_2 counterparts for iter-98's 5 Facade presence-
			// validity rollups — closes the explicitly-named deferred follow-on
			// and saturates the Facade 6-way field-validity matrix on BOTH
			// streams. Mirrors iter-67's stream_2_facade_format_valid_count_sum
			// pattern: primary probe counts all 7 facades per intent while
			// stream_2 counts only the 6 in context.facades at snapshot time
			// (last-arriving facade at ~11-12s typically misses the stream_2
			// window that opens ~12s; see iter-66 for cardinality baseline).
			// Under iter-61 healthy-auth 5-intent 12s-window baseline the 6-way
			// cross-stream identity on facade-ready holds:
			//   stream_2_facade_id_present_count_sum = stream_2_facade_ready_
			//     count_sum = 30 _min=6
			//   stream_2_facade_agent_id_present_count_sum = 30 _min=6
			//   stream_2_facade_hypothesis_present_count_sum = 30 _min=6
			//   stream_2_facade_label_present_count_sum = 30 _min=6
			//   stream_2_facade_content_present_count_sum = 30 _min=6
			// Together with iter-67's stream_2_facade_format_valid_count_sum=30/
			// _min=6 and iter-66's stream_2_facade_ready_count_sum=30/_min=6,
			// this establishes a 6-way identity on the stream_2 facade-ready
			// replay — the exact cross-stream counterpart to the primary 6-way
			// identity at 35/_min=7. Under broken-auth all 5 = 0 / _min=0.
			//
			// Regression classes these stream_2 rollups catch that primary
			// iter-98 + stream_2_facade_ready_count cannot:
			//   - /api/stream replay block mutates facade payload in transit
			//     (a .map transform inserted at +server.ts:36-38, a clone that
			//     drops specific fields, payload-shape divergence from the
			//     primary emit): primary iter-98 probes hold at 35 while
			//     stream_2 probes drop below 30 / _min drops to <6 — uniquely
			//     pinpoints replay-block corruption invisible to primary probes.
			//   - /api/stream replay emits facade-ready with all fields intact
			//     but wraps the facade in an extra envelope (e.g. emits
			//     {type:'facade-ready', data:{facade:{facade:{...}}}}) breaking
			//     the e.data?.facade?.id path: stream_2_facade_ready_count
			//     (iter-66) stays at 30 because type-matching fires, but all
			//     5 stream_2 presence probes drop to 0 simultaneously.
			//   - Late-arriving facade DOES land in stream_2 (wider replay
			//     window) but with missing fields: stream_2_facade_ready_count
			//     rises to 35 while stream_2 presence probes stay at 30 —
			//     distinguishes timing-regime shift from field-corruption.
			//
			// Forward-deploy under wider stream_2 windows: if VALIDATE_RUN_MS
			// widens and all 7 facades land in the replay, stream_2_*_sum rises
			// to 35 matching primary iter-98; 6-way identity re-establishes at
			// the new 35 baseline. Baseline-regime-invariant (probe = replay
			// count regardless of how many facades the replay captures).
			stream_2_facade_id_present_count_sum: sumMetric('stream_2_facade_id_present_count'),
			stream_2_facade_id_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_facade_id_present_count ?? 0))
				: 0,
			stream_2_facade_agent_id_present_count_sum: sumMetric('stream_2_facade_agent_id_present_count'),
			stream_2_facade_agent_id_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_facade_agent_id_present_count ?? 0))
				: 0,
			stream_2_facade_hypothesis_present_count_sum: sumMetric('stream_2_facade_hypothesis_present_count'),
			stream_2_facade_hypothesis_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_facade_hypothesis_present_count ?? 0))
				: 0,
			stream_2_facade_label_present_count_sum: sumMetric('stream_2_facade_label_present_count'),
			stream_2_facade_label_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_facade_label_present_count ?? 0))
				: 0,
			stream_2_facade_content_present_count_sum: sumMetric('stream_2_facade_content_present_count'),
			stream_2_facade_content_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_facade_content_present_count ?? 0))
				: 0,
			// iter-80: swipe-result content-validation rollups — first content-probe
			// aggregates on the swipe-result event type after 79 iterations of
			// count-only coverage. Parallel to iter-67's facade.format rollups
			// (first content rollup on facade-ready) and iter-72's synthesis.axes/
			// scout_assignments rollups. Under iter-61 healthy-auth baseline with
			// the validator's single hardcoded accept-swipe-per-intent:
			//   swipe_decision_valid_count_sum = swipe_result_count_sum = 5
			//   swipe_decision_valid_count_min = 1 (one swipe per intent)
			//   swipe_latency_bucket_valid_count_sum = swipe_result_count_sum = 5
			//   swipe_latency_bucket_valid_count_min = 1
			// Identity invariants: both equal swipe_result_count_sum because the
			// validator's single swipe always has decision='accept' (validator
			// hardcodes this at line ~358) and latencyBucket='slow' (first swipe
			// per session triggers sessionMedianLatency=0 → else-branch 'slow' in
			// context.addEvidence). Under broken-auth both are 0 because no
			// facade-ready means no swipe-watcher POST means no swipe-result emit.
			// Regression classes these aggregate rollups catch that swipe_result_
			// count_sum alone cannot: record.decision stripped or set to an invalid
			// literal (_sum drops below count, _min drops to 0 on any intent
			// missing decision); record.latencyBucket set to a non-union value
			// (e.g. 'medium' from a misguided three-bucket refactor) or stripped
			// (if addEvidence logic regresses): _sum drops, _min drops to 0.
			// Forward-deploy: when future multi-swipe validators land, identity
			// invariants scale linearly (_sum = N*swipe_result_count_sum) because
			// both union-value sets cover all valid emissions; this is a baseline-
			// regime-invariant probe just like iter-67's facade_format_valid_count.
			swipe_decision_valid_count_sum: sumMetric('swipe_decision_valid_count'),
			swipe_decision_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.swipe_decision_valid_count ?? 0))
				: 0,
			swipe_latency_bucket_valid_count_sum: sumMetric('swipe_latency_bucket_valid_count'),
			swipe_latency_bucket_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.swipe_latency_bucket_valid_count ?? 0))
				: 0,
			// iter-97: SwipeRecord remaining-field presence-validity rollups —
			// closes the 3 of 5 SwipeRecord fields not covered by iter-80's typed-
			// union pair (decision, latencyBucket). After iter-80 closed the typed-
			// union half (decision/latencyBucket), this iteration closes the
			// presence-validity half (facadeId/agentId as non-empty strings,
			// latencyMs as a finite non-negative number) — together saturating the
			// SwipeRecord field-validity matrix on the swipe-result event type.
			//
			// Family: POSITIVE-IDENTITY (distinct from SHOULD-BE-ZERO of iter-93/
			// 94/95/96) — under healthy-auth single-intent baseline all 3 probes
			// equal swipe_result_count = 1, so identity holds at probe = swipe_
			// result_count for every probe. Identity invariants under iter-61
			// healthy-auth 5-intent baseline:
			//   swipe_facade_id_present_count_sum = swipe_result_count_sum = 5
			//   swipe_facade_id_present_count_min = 1
			//   swipe_agent_id_present_count_sum = swipe_result_count_sum = 5
			//   swipe_agent_id_present_count_min = 1
			//   swipe_latency_ms_valid_count_sum = swipe_result_count_sum = 5
			//   swipe_latency_ms_valid_count_min = 1
			// Three-way identity matches iter-80 swipe_decision_valid_count_sum=5
			// _min=1 and swipe_latency_bucket_valid_count_sum=5 _min=1, completing
			// the 5-way SwipeRecord field validity identity chain on swipe-result.
			// Under broken-auth all 3 = 0 / _min=0 (no swipe-result fires).
			//
			// Regression classes these aggregate rollups catch that iter-80's
			// typed-union rollups + swipe_result_count_sum cannot:
			//   - /api/swipe drops record.facadeId before passing to addEvidence:
			//     swipe_decision_valid_count_sum stays at 5 (decision intact),
			//     swipe_facade_id_present_count_sum drops to 0 / _min to 0.
			//   - context.addEvidence breaks the facade.agentId lookup (mutation
			//     bug, find returning undefined silently): decision/bucket hold,
			//     swipe_agent_id_present drops below 5.
			//   - latencyMs corrupted to NaN/undefined/negative/string: bucket
			//     logic at context.ts:69 short-circuits to 'slow' when median=0
			//     so swipe_latency_bucket_valid stays at 5; swipe_latency_ms_valid
			//     drops to 0 — pinpoints number-corruption distinct from bucket-
			//     classification corruption (iter-80 catches the latter).
			//   - SSE serializer strips entire record field: ALL 5 SwipeRecord
			//     field probes (iter-80 + iter-97) collapse to 0 simultaneously,
			//     distinguishing serialization-level from field-specific corruption.
			//
			// Forward-deploy: under multi-swipe validators (e.g. 5-swipe per
			// intent harness) identity scales linearly: each _sum = 5*N where N is
			// per-intent swipe count, _min = N. Identity holds because all probe
			// predicates (string non-empty, number finite>=0) cover every valid
			// emission shape regardless of swipe count, decision distribution, or
			// latencyMs value within the legal range.
			//
			// No stream_2 counterpart by construction: iter-91 documented swipe-
			// result is NOT replayed on /api/stream (+server.ts:23-38 replay block
			// emits only synthesis/evidence/facade/draft/stage/agent-status).
			// Same N/A structural status as iter-80 (decision/latencyBucket) and
			// iter-93 (facade-stale, builder-hint).
			swipe_facade_id_present_count_sum: sumMetric('swipe_facade_id_present_count'),
			swipe_facade_id_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.swipe_facade_id_present_count ?? 0))
				: 0,
			swipe_agent_id_present_count_sum: sumMetric('swipe_agent_id_present_count'),
			swipe_agent_id_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.swipe_agent_id_present_count ?? 0))
				: 0,
			swipe_latency_ms_valid_count_sum: sumMetric('swipe_latency_ms_valid_count'),
			swipe_latency_ms_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.swipe_latency_ms_valid_count ?? 0))
				: 0,
			// iter-72: synthesis content-validation rollups — first content-probe
			// aggregates on the synthesis-updated event after 71 iterations of
			// count-only coverage. Parallel to iter-67's facade.format rollups
			// (first content rollup on facade-ready) and iter-60's session-ready
			// content rollup. Under iter-61 healthy-auth baseline, synthesis-
			// updated fires once per intent from cold-start (oracle.ts:350) with
			// 6 axes + 6 scout_assignments, so the identity invariants are:
			//   synthesis_axes_count_sum = 6 * synthesis_updated_count_sum = 30
			//   synthesis_axes_min = 6 (per intent)
			//   synthesis_scout_assignments_count_sum = 30
			//   synthesis_scout_assignments_min = 6
			// Regression classes these rollups catch that synthesis_updated_count_
			// sum cannot: empty axes from a degraded Haiku call (event_count_sum
			// stays 5, axes_min drops to 0); scout_assignments truncated below
			// the 6-roster (event_count_sum stays 5, assignments_min drops to 5);
			// axes serialized as object instead of array (Array.isArray coerces
			// to 0, event_count holds at 1 but min drops to 0). Forward-deploy:
			// when real evidence-synthesis fires (4+ swipes, currently unreachable
			// in 12s window) the same min invariants apply because Haiku's
			// synthesis schema requires axes + scout_assignments populated.
			synthesis_axes_count_sum: sumMetric('synthesis_axes_count'),
			synthesis_axes_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.synthesis_axes_min ?? 0))
				: 0,
			// iter-83: array-element typed-union rollup on synthesis-updated.
			// axes[].confidence — extends iter-82's evidence-updated array-element
			// pattern (decision/format/latencySignal) to a NEW event type and
			// closes iter-82's explicitly-named follow-on. Confidence is the only
			// typed-union field on EmergentAxis (types.ts:67) ∈ {'unprobed',
			// 'exploring', 'leaning', 'resolved'}. Under iter-61 healthy-auth
			// baseline, cold-start synthesis (oracle.ts:338) hard-codes
			// confidence='unprobed' on every axis — so identity invariant under
			// healthy-auth 5-intent baseline is _sum=30 (= synthesis_axes_count_
			// sum) / _min=6 (= 6 axes per intent, all with valid confidence).
			//
			// Forward-deploy regimes:
			//   - real evidence-synthesis (runSynthesis path, 4+ swipes) lands
			//     within window: confidence values become a mix of 'exploring'/
			//     'leaning'/'resolved' as evidence accumulates; all three values
			//     satisfy union, so identity holds — the probe is synthesis-
			//     regime-invariant just like iter-67's facade.format across
			//     word/mockup stages.
			//   - oracle.runSynthesis truncates an axis or returns confidence as
			//     null/typo'd ('exploringg'): event_count_sum stays at 5,
			//     synthesis_axes_count_sum stays at 30, but synthesis_axes_valid_
			//     confidence_count_sum drops below 30 — pinpointing field-level
			//     corruption invisible to iter-72's whole-array length probe.
			//
			// Three-way comparison at aggregate (iter-82 pattern extended): a
			// regression dropping confidence on ONE axis would drop synthesis_
			// axes_valid_confidence_count_sum to 29 while synthesis_axes_count_
			// sum stays at 30 — the gap (synthesis_axes_count_sum - synthesis_
			// axes_valid_confidence_count_sum) directly counts corrupted-confidence
			// axes across the full search set.
			synthesis_axes_valid_confidence_count_sum: sumMetric('synthesis_axes_valid_confidence_count'),
			synthesis_axes_valid_confidence_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.synthesis_axes_valid_confidence_count ?? 0))
				: 0,
			// iter-103: EmergentAxis remaining-field presence-validity rollups —
			// saturate the EmergentAxis 5-way field-validity matrix on the primary
			// bus alongside iter-83's axes[].confidence typed-union rollup and
			// iter-72's axes whole-array length rollups. Closes iter-101's
			// explicitly-named follow-on candidate (a) on the primary bus. Parallel
			// to iter-102's SwipeEvidence 7-way closure (4 string fields added
			// alongside iter-82's 3 typed-union fields) — continues the POSITIVE-
			// IDENTITY family from iter-97 SwipeRecord 5-way / iter-98 Facade 6-way
			// / iter-100 PrototypeDraft 6-way / iter-101 AgentState 5-way / iter-102
			// SwipeEvidence 7-way.
			//
			// EmergentAxis has 6 fields per types.ts:63-70: 1 typed-union (confidence,
			// closed by iter-83) + 4 required-string (label, poleA, poleB,
			// evidence_basis, closed by iter-103) + 1 nullable-string (leaning_toward,
			// NOT a presence-validity probe candidate because null is in-regime
			// under cold-start). Under iter-61 healthy-auth 5-intent 12s-window
			// baseline with cold-start synthesis only (oracle.ts:339-347 fires once
			// per session at ~3-5s, runSynthesis at oracle.ts:176 unreachable in
			// 12s window): each of 6 axes per intent carries non-empty strings for
			// all 4 fields:
			//   label = h.hypothesis (non-empty, from coldStartSchema z.string())
			//   poleA = h.word_probe (non-empty, from coldStartSchema z.string())
			//   poleB = '(unknown)' (hardcoded non-empty literal)
			//   evidence_basis = 'intent analysis (no evidence yet)' (hardcoded non-empty)
			//
			// 5-way item-level POSITIVE-IDENTITY chain at aggregate (iter-102 pattern
			// extended to EmergentAxis):
			//   synthesis_axes_count_sum (iter-72, 30)
			//     = synthesis_axes_valid_confidence_count_sum (iter-83, 30)
			//     = synthesis_axes_label_present_count_sum (iter-103, 30)
			//     = synthesis_axes_pole_a_present_count_sum (iter-103, 30)
			//     = synthesis_axes_pole_b_present_count_sum (iter-103, 30)
			//     = synthesis_axes_evidence_basis_present_count_sum (iter-103, 30)
			//     = 6 × synthesis_updated_count_sum (iter-66, 5)
			//
			// Regression classes these rollups catch that iter-72/83 cannot:
			//   - runColdStart at oracle.ts:339-347 mutating one string field
			//     without the others (a refactor that sets poleB='' when
			//     h.word_probe is missing, or a null-coalesce chain producing ''
			//     instead of a fallback): synthesis_axes_valid_confidence_count_sum
			//     stays at 30 while pole_b_present_count_sum drops to 0 —
			//     distinguishing field-level mutation from typed-union corruption.
			//     iter-83 probes cannot see this because confidence is hard-coded
			//     to 'unprobed' in cold-start and stays valid regardless of which
			//     other fields are corrupted.
			//   - a coldStartSchema refactor that relaxes z.string() to
			//     z.string().optional() on hypothesis/word_probe (oracle.ts:103):
			//     LLM could emit empty strings for one field; label_present or
			//     pole_a_present drops independently while confidence_count stays
			//     at 30 — orthogonal discriminative signal invisible to iter-83.
			//   - runSynthesis path (oracle.ts:176, unreachable in 12s window but
			//     forward-deploy reachable) returning an axis with evidence_basis
			//     null/undefined from a degraded LLM output: under forward-deploy,
			//     evidence_basis_present_count_sum drops below synthesis_axes_
			//     count_sum while confidence_count_sum stays at identity — forward-
			//     deploy-specific regression invisible to current-baseline probes.
			//   - a TasteSynthesis refactor that drops poleB from the EmergentAxis
			//     object literal in cold-start construction (types.ts widens to
			//     `poleB?: string` or cold-start spreads a partial object):
			//     TypeScript may still type-check but runtime carries undefined/'';
			//     pole_b_present_count_sum drops to 0 across all intents while
			//     axes_count_sum stays at 30, pinpointing the schema-widening regression.
			//
			// Forward-deploy regimes: under runSynthesis path (4+ swipes, currently
			// unreachable) evidence_basis is populated by the LLM from prior swipe
			// evidence; synthesisSchema (oracle.ts:34) requires z.string() so the
			// probe stays at identity. Under reveal-reachable regime, axes may
			// carry runSynthesis-fresh values for poleB ('muted' instead of
			// '(unknown)'); both non-empty so probe at identity. The 4 string
			// probes are cold-start-vs-runSynthesis path-invariant, synthesis-
			// regime-invariant, and intent-invariant — just like iter-83's
			// confidence probe.
			synthesis_axes_label_present_count_sum: sumMetric('synthesis_axes_label_present_count'),
			synthesis_axes_label_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.synthesis_axes_label_present_count ?? 0))
				: 0,
			synthesis_axes_pole_a_present_count_sum: sumMetric('synthesis_axes_pole_a_present_count'),
			synthesis_axes_pole_a_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.synthesis_axes_pole_a_present_count ?? 0))
				: 0,
			synthesis_axes_pole_b_present_count_sum: sumMetric('synthesis_axes_pole_b_present_count'),
			synthesis_axes_pole_b_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.synthesis_axes_pole_b_present_count ?? 0))
				: 0,
			synthesis_axes_evidence_basis_present_count_sum: sumMetric(
				'synthesis_axes_evidence_basis_present_count'
			),
			synthesis_axes_evidence_basis_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.synthesis_axes_evidence_basis_present_count ?? 0)
					)
				: 0,
			synthesis_scout_assignments_count_sum: sumMetric('synthesis_scout_assignments_count'),
			synthesis_scout_assignments_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.synthesis_scout_assignments_min ?? 0))
				: 0,
			// iter-85: scout-roster-membership rollup on synthesis-updated.scout_
			// assignments[].scout — closes iter-83's explicitly-named follow-on
			// ('scout-roster-membership probe on scout_assignments[].scout') and
			// pairs with iter-84's oracle.ts:58 schema tightening as the wire-level
			// observe-side complement to iter-84's Output.object-layer prevent-
			// side enforcement. Canonical roster {Iris, Prism, Lumen, Aura, Facet,
			// Echo} matches oracle.ts:58 synthesisSchema enum, oracle.ts:103
			// coldStartSchema enum, SYNTHESIS_PROMPT line 96 explicit name list,
			// and scout.ts:33-38 SCOUTS[].name consumer constant.
			//
			// Under iter-61 healthy-auth 5-intent 12s-window baseline (cold-start
			// synthesis fires once per intent with 6 roster-valid scouts):
			//   synthesis_scout_assignments_valid_scout_count_sum = 30
			//     = synthesis_scout_assignments_count_sum (6 * 5)
			//   synthesis_scout_assignments_valid_scout_count_min = 6 (per-intent)
			// Under broken-auth baseline: 0 = synthesis_scout_assignments_count_sum
			// (= 0, no cold-start emission reaches the wire).
			//
			// Three-way identity at aggregate (iter-82/83 pattern continued):
			//   synthesis_scout_assignments_valid_scout_count_sum == synthesis_
			//   scout_assignments_count_sum == 6 * synthesis_updated_count_sum
			// A regression that (a) relaxes iter-84's z.enum back to z.string()
			// AND (b) the LLM hallucinates an off-roster name ('Nova', 'Flux'),
			// would leave scout_assignments_count at 30 and iter-83's axes_valid_
			// confidence_count at 30 but drop this probe below 30 — pinpointing
			// the exact failure class iter-84 learned about (scout.ts:191 silent-
			// fallback to 'No assignment yet — self-assign' invisible to SSE).
			//
			// Forward-deploy regimes:
			//   - runSynthesis path fires within window (4+ swipes land before
			//     window close): scout_assignments carries 6 runSynthesis-assigned
			//     roster values; identity holds (all 6 roster names still valid).
			//   - schema-layer regression where z.enum is removed and LLM picks
			//     off-roster: count_sum stays at 30, valid_scout_count_sum drops,
			//     the gap directly counts off-roster entries across the search set.
			//
			// Orthogonal to iter-83's axes.confidence probe: that one catches
			// corrupted confidence on EmergentAxis elements; this one catches
			// off-roster scout on scout_assignments elements. Together they
			// form the complete within-element typed-union coverage on synthesis-
			// updated (2 arrays, 1 typed-union field per element = 2 probes).
			synthesis_scout_assignments_valid_scout_count_sum: sumMetric('synthesis_scout_assignments_valid_scout_count'),
			synthesis_scout_assignments_valid_scout_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.synthesis_scout_assignments_valid_scout_count ?? 0))
				: 0,
			// iter-104: scout_assignments[] remaining-field presence-validity
			// rollups on synthesis-updated.scout_assignments[].{probe_axis, reason}
			// — closes iter-103's explicitly-named follow-on candidate (a):
			// 'scout_assignments probe_axis/reason — iter-85 covered only scout'.
			// Saturates the scout_assignments 3-way field-validity matrix alongside
			// iter-85's scout roster-membership typed-union probe and iter-72's
			// length probe. The scout_assignments counterpart to iter-103's
			// EmergentAxis 5-way saturation on synthesis-updated.axes[], completing
			// within-element coverage on ALL array-typed synthesis-updated fields.
			//
			// Under iter-61 healthy-auth 5-intent 12s-window baseline (cold-start
			// synthesis fires once per intent with 6 fully-populated scout_
			// assignments per oracle.ts:350-354 — probe_axis from h.hypothesis,
			// reason from h.word_probe, both required z.string() in coldStartSchema
			// at oracle.ts:103):
			//   synthesis_scout_assignments_probe_axis_present_count_sum = 30
			//     = synthesis_scout_assignments_count_sum (6 * 5)
			//     = synthesis_scout_assignments_valid_scout_count_sum (iter-85)
			//   synthesis_scout_assignments_probe_axis_present_count_min = 6
			//   synthesis_scout_assignments_reason_present_count_sum = 30
			//   synthesis_scout_assignments_reason_present_count_min = 6
			// Under broken-auth baseline: 0 = synthesis_scout_assignments_count_sum
			// (= 0, no cold-start emission reaches the wire).
			//
			// 3-way item-level POSITIVE-IDENTITY chain at aggregate (iter-82/83/102/
			// 103 pattern continued for the second array-typed field on synthesis-
			// updated):
			//   synthesis_scout_assignments_count_sum (iter-72, 30)
			//     = synthesis_scout_assignments_valid_scout_count_sum (iter-85, 30)
			//     = synthesis_scout_assignments_probe_axis_present_count_sum (iter-104, 30)
			//     = synthesis_scout_assignments_reason_present_count_sum (iter-104, 30)
			//     = 6 × synthesis_updated_count_sum (iter-66, 5)
			//
			// Regression classes these probes catch that iter-72/85 cannot:
			//   - runColdStart at oracle.ts:350-354 mutating probe_axis or reason
			//     without the other (a refactor that sets reason='' when h.word_
			//     probe is falsy, or a null-coalesce chain producing '' instead of
			//     a fallback): valid_scout_count stays at 30 while probe_axis_
			//     present or reason_present drops to 0 — field-level mutation
			//     distinct from typed-union corruption on the same array element.
			//   - coldStartSchema (oracle.ts:103) relaxing z.string() to z.string().
			//     optional() on hypothesis or word_probe: LLM could emit empty
			//     strings for one field; probe_axis_present drops independently
			//     while valid_scout_count stays at 30 — orthogonal discriminative
			//     signal iter-85's scout-roster probe cannot provide.
			//   - runSynthesis path (oracle.ts:176, unreachable in 12s window)
			//     returning a scout_assignment with reason null/undefined: under
			//     forward-deploy (widened window or multi-swipe), reason_present
			//     drops below synthesis_scout_assignments_count while valid_scout_
			//     count stays at identity — forward-deploy-specific regression
			//     invisible to iter-85's typed-union probe.
			//   - a TasteSynthesis refactor that drops probe_axis from the scout_
			//     assignment object literal in cold-start construction (types.ts
			//     widens to `probe_axis?: string` or cold-start spreads a partial
			//     object): TypeScript may still type-check but runtime carries
			//     undefined/'' depending on regime; probe_axis_present drops to 0
			//     across all intents.
			//
			// Orthogonal to iter-103's EmergentAxis string-field probes (label,
			// poleA, poleB, evidence_basis on axes[]): those catch corruption on
			// EmergentAxis elements; these catch corruption on scout_assignments
			// elements. Together with iter-83 (axes.confidence) and iter-85 (scout_
			// assignments.scout), they form the complete within-element field-
			// validity coverage on synthesis-updated — 2 arrays × 2-5 field-probes
			// per element = 7 array-element probes total after iter-104.
			synthesis_scout_assignments_probe_axis_present_count_sum: sumMetric(
				'synthesis_scout_assignments_probe_axis_present_count'
			),
			synthesis_scout_assignments_probe_axis_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.synthesis_scout_assignments_probe_axis_present_count ?? 0
						)
					)
				: 0,
			synthesis_scout_assignments_reason_present_count_sum: sumMetric(
				'synthesis_scout_assignments_reason_present_count'
			),
			synthesis_scout_assignments_reason_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.synthesis_scout_assignments_reason_present_count ?? 0
						)
					)
				: 0,
			// iter-94: synthesis-updated.palette presence-validity rollup on the
			// primary bus. TasteSynthesis.palette? (types.ts:85 iter-73) is an
			// optional 6-field object (paletteSchema at oracle.ts:37-44 with bg,
			// card, accent, text, muted, radius as strings). The emission topology
			// creates a discriminative two-regime baseline keyed on WHICH synthesis
			// path fires:
			//
			//   cold-start (oracle.ts:339-355, fires once per session at ~3-5s):
			//     synthesis object is constructed manually WITHOUT a palette
			//     property, so palette is undefined on the wire.
			//   runSynthesis (oracle.ts:176, fires every 4 swipes post-swipe-4):
			//     synthesisSchema.palette is required (oracle.ts:49), so the zod
			//     Output.object layer enforces a full 6-string-field palette
			//     object on every successful emit.
			//
			// Under iter-61 healthy-auth 5-intent 12s-window baseline (cold-start
			// only, runSynthesis unreachable because REVEAL_THRESHOLD=15 evidence
			// beyond the 1-swipe per-intent budget):
			//   synthesis_palette_present_count_sum = 0
			//   synthesis_palette_present_count_min = 0
			// Under broken-auth baseline: both still 0 (no synthesis fires at all).
			//
			// A SHOULD-BE-ZERO invariant in the current regime — parallel to iter-93's
			// facade_stale_count_sum=0 and builder_hint_count_sum=0 which also hold
			// at zero under the current baseline and transition to positive under
			// widened-window / multi-swipe regimes.
			//
			// Regression classes this catches that iter-72/83 primary probes cannot:
			//   (a) cold-start accidentally starts emitting a palette object (someone
			//       extends coldStartSchema with a palette field, or runColdStart's
			//       manual synthesis construction adds a palette literal). The current
			//       iter-72/83 probes cannot see this: axes_count stays at 30 and
			//       axes_valid_confidence_count stays at 30 but palette_present_count
			//       would flip 0→5 under this regression, a unique direct signal.
			//   (b) palette emitted as wrong shape/type (string/array/partial). Typed
			//       6-field check fails and count stays at 0 under forward-deploy
			//       while synthesis_updated_count grows — the gap directly counts
			//       malformed payloads.
			//
			// Forward-deploy regime transition: under widened VALIDATE_RUN_MS window
			// (4+ swipes per intent land before window close) or a multi-swipe
			// validator mode, runSynthesis emissions carry palette and count flips
			// from 0 to match runSynthesis-emission-count per intent. The identity
			// invariant shifts from 'palette_present == 0' to 'palette_present ==
			// (synthesis_updated_count - cold_start_synthesis_count)'.
			//
			// Orthogonal to iter-72's length probes (axes_count, scout_assignments_
			// count) and iter-83/85's within-element typed-union probes (axes[].
			// confidence, scout_assignments[].scout) — those test payload dimensions
			// that are populated in BOTH cold-start and runSynthesis paths, so they
			// cannot discriminate between the two emission origins. palette_present
			// is the FIRST field-level probe on synthesis-updated that distinguishes
			// cold-start-emitted synthesis from runSynthesis-emitted synthesis — a
			// cross-path discriminative signal that none of the previous 94 iterations'
			// synthesis probes could provide.
			synthesis_palette_present_count_sum: sumMetric('synthesis_palette_present_count'),
			synthesis_palette_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.synthesis_palette_present_count ?? 0))
				: 0,
			// iter-105: TasteSynthesis top-level remaining-field presence-validity
			// rollups on synthesis-updated.{edge_case_flags, persona_anima_divergence}.
			// Saturates the TasteSynthesis struct-boundary 5-way field-validity
			// matrix (types.ts:81-91) alongside iter-72 (axes+scout_assignments count),
			// iter-83/103 (axes 5-way within-item), iter-85/104 (scout_assignments
			// 3-way within-item), and iter-94 (palette SHOULD-BE-ZERO presence).
			// Closes the LAST unprobed fields at the TasteSynthesis struct boundary,
			// extending the POSITIVE-IDENTITY matrix-saturation cluster that began
			// iter-97 (SwipeRecord 5-way) to a 10-iteration run: iter-97 SwipeRecord
			// 5-way → iter-98/99 Facade 6-way → iter-100 PrototypeDraft 6-way →
			// iter-101 AgentState 5-way → iter-102 SwipeEvidence 7-way → iter-103
			// EmergentAxis 5-way (within-item) → iter-104 scout_assignments 3-way
			// (within-item) → iter-105 TasteSynthesis top-level 5-way (this rollup).
			//
			// Under iter-61 healthy-auth 5-intent 12s-window baseline, cold-start
			// synthesis (oracle.ts:339-355) hard-codes edge_case_flags=[] (always
			// an array — passes Array.isArray) and persona_anima_divergence=null
			// (always null — passes the null-or-non-empty-string union check). Both
			// rollups hold at synthesis_updated_count_sum per intent = 5 (_min=1).
			//
			// POSITIVE-IDENTITY chain at aggregate under healthy-auth baseline:
			//   synthesis_updated_count_sum (iter-66, 5)
			//     = synthesis_edge_case_flags_array_valid_count_sum (iter-105, 5)
			//     = synthesis_persona_anima_divergence_valid_count_sum (iter-105, 5)
			//
			// Under broken-auth baseline: both rollups = 0 (no cold-start emission
			// reaches the wire — iter-72's synthesis_updated_count_sum also drops
			// to 0). The identity chain holds at 0 on both sides.
			//
			// Regression classes these rollups catch that iter-72/83/85/94/103/104
			// cannot:
			//   - oracle.ts:348 refactor assigning edge_case_flags = null/undefined
			//     instead of []: iter-72/83/103 hold at 30 (axes intact); iter-94
			//     palette holds at 0 (SHOULD-BE-ZERO unchanged); iter-105 edge_case_
			//     flags_array_valid drops from 5 to 0, pinpointing the exact field-
			//     level regression invisible to all other synthesis probes.
			//   - oracle.ts:354 refactor assigning persona_anima_divergence = '' or
			//     undefined instead of null: iter-72/83/85/94/103/104 all hold at
			//     their identity baselines; iter-105 persona_anima_divergence_valid
			//     drops from 5 to 0 — the null-vs-empty-string boundary is exactly
			//     what this probe discriminates.
			//   - synthesisSchema (oracle.ts:48) or coldStartSchema narrowing:
			//     z.array(z.string()) relaxed to z.any() or z.unknown(), or z.string
			//     ().nullable() changed to z.string().optional() (allows undefined)
			//     — one or both rollups drop below 5 while other rollups hold at
			//     identity, catching schema-narrowing regressions at the field-
			//     type layer.
			//   - TasteSynthesis interface refactor dropping edge_case_flags or
			//     persona_anima_divergence from the required field set: runtime
			//     wire-level probe catches omission even if compile-time types
			//     narrow silently.
			//
			// Forward-deploy regimes: under runSynthesis (oracle.ts:176, 4+ swipes,
			// unreachable in 12s window), edge_case_flags may carry populated
			// string entries (e.g. ['all accepted', 'axis X contradictory']) —
			// rollup still holds at identity because Array.isArray is orthogonal
			// to array length. persona_anima_divergence may carry a non-empty
			// string instead of null — rollup still holds at identity because the
			// union-valid-type check accepts both null and non-empty string per
			// types.ts:90. Both probes are cold-start-vs-runSynthesis path-
			// invariant, synthesis-regime-invariant, and intent-invariant.
			//
			// Orthogonal to iter-94's palette SHOULD-BE-ZERO rollup: that probe
			// fires ZERO under cold-start and positive under runSynthesis, discrim-
			// inating emission origin; iter-105 probes fire identity under BOTH
			// paths, providing structural validity signal independent of which
			// synthesis path ran. Together iter-94 (origin-discriminative) and
			// iter-105 (origin-invariant) give two-sided coverage: iter-94 tells
			// WHICH path ran, iter-105 tells HOW WELL that path populated the
			// remaining top-level fields.
			synthesis_edge_case_flags_array_valid_count_sum: sumMetric(
				'synthesis_edge_case_flags_array_valid_count'
			),
			synthesis_edge_case_flags_array_valid_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.synthesis_edge_case_flags_array_valid_count ?? 0)
					)
				: 0,
			synthesis_persona_anima_divergence_valid_count_sum: sumMetric(
				'synthesis_persona_anima_divergence_valid_count'
			),
			synthesis_persona_anima_divergence_valid_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.synthesis_persona_anima_divergence_valid_count ?? 0
						)
					)
				: 0,
			// iter-106: axes[].leaning_toward nullable-string union-valid rollups on
			// synthesis-updated events. Closes iter-105's explicitly-named follow-on
			// candidate — the LAST unprobed EmergentAxis field per types.ts:63-70.
			// Saturates the EmergentAxis 6-way field-validity matrix alongside iter-
			// 72 (axes length), iter-83 (confidence typed-union), iter-103 (label/
			// poleA/poleB/evidence_basis presence-validity). Extends the iter-97→105
			// POSITIVE-IDENTITY matrix-saturation cluster from 10 to 11 consecutive
			// iterations, applying the null-or-non-empty-string union-valid predicate
			// family (iter-105 introduced at TasteSynthesis struct boundary) to
			// within-item array-element coverage for the first time.
			//
			// Under iter-61 healthy-auth 5-intent 12s-window baseline: cold-start
			// synthesis (oracle.ts:339-347) hard-codes leaning_toward=null for every
			// axis. Probe fires once per axis that passes (=== null OR non-empty-
			// string) — under cold-start, all 6 axes pass via the null branch, yield
			// count = 6 per intent. Aggregate _sum=30/_min=6 identity-matched with
			// iter-83 axes_valid_confidence, iter-103 4-string probes, and iter-72
			// axes length.
			//
			// 6-way EmergentAxis POSITIVE-IDENTITY chain at aggregate under healthy-auth:
			//   synthesis_axes_count_sum (iter-72, 30)
			//     = synthesis_axes_valid_confidence_count_sum (iter-83, 30)
			//     = synthesis_axes_label_present_count_sum (iter-103, 30)
			//     = synthesis_axes_pole_a_present_count_sum (iter-103, 30)
			//     = synthesis_axes_pole_b_present_count_sum (iter-103, 30)
			//     = synthesis_axes_evidence_basis_present_count_sum (iter-103, 30)
			//     = synthesis_axes_leaning_toward_valid_count_sum (iter-106, 30)  ← this rollup
			//
			// Under broken-auth baseline: rollup = 0 (no cold-start emission reaches
			// the wire — iter-72 synthesis_axes_count_sum also 0). The identity chain
			// holds at 0 on both sides, baseline-regime-invariant.
			//
			// Regression classes this rollup catches that iter-72/83/103 cannot:
			//   - oracle.ts:345 refactor assigning leaning_toward = '' or undefined
			//     instead of null: iter-83/103 hold at 30 (confidence typed-union and
			//     4 string presence-validity intact); iter-72 axes length holds at
			//     30; iter-106 leaning_toward_valid drops from 30 to 0 — the null-vs-
			//     empty-string boundary on the within-item axis field is exactly what
			//     this probe discriminates. No other EmergentAxis probe can catch
			//     this at the wire-level independent of structural count.
			//   - synthesisSchema/coldStartSchema narrowing: z.string().nullable()
			//     changed to z.string().optional() (allows undefined) — iter-106
			//     drops below 30 while iter-83 confidence holds (still a valid union
			//     member 'unprobed'); catches schema-narrowing at the nullable-field-
			//     type layer specifically.
			//   - runSynthesis path emitting leaning_toward as wrong type (number,
			//     object, array from LLM JSON parse bug or payload-shape drift):
			//     iter-83 confidence may hold if typed-union intact; iter-106 drops
			//     because typeof !== 'string' and !== null.
			//   - cold-start refactor dropping leaning_toward from the EmergentAxis
			//     object literal (oracle.ts:340-347 construction omits the field):
			//     runtime carries undefined; TypeScript catches at compile-time only
			//     if consumers reference the field; iter-106 catches at runtime via
			//     the null-vs-undefined discrimination.
			//
			// Forward-deploy regimes: under runSynthesis (oracle.ts:176, 4+ swipes,
			// unreachable in 12s window), leaning_toward may carry a non-empty string
			// (resolved pole like 'muted' or 'sharp') per synthesisSchema's z.string
			// ().nullable() at oracle.ts:33 — rollup still holds at identity because
			// the union-valid predicate accepts both null and non-empty string per
			// types.ts:68. Under reveal-reachable regime, axes may carry a mix of
			// null and populated values across axes; rollup still holds at identity
			// because every axis passes one branch of the union. PATH-INVARIANT
			// probe — iter-106 is the within-item counterpart to iter-105's struct-
			// boundary persona_anima_divergence probe.
			//
			// Orthogonal to iter-94's palette SHOULD-BE-ZERO rollup: that probe fires
			// ZERO under cold-start and positive under runSynthesis (origin-
			// discriminative); iter-106 fires identity under BOTH paths (origin-
			// invariant). Together iter-94 (path-discriminative) + iter-105/106
			// (path-invariant) provide two-sided coverage of synthesis emission: iter-
			// 94 tells WHICH path ran, iter-105/106 tell HOW WELL that path populated
			// the struct-boundary and within-item nullable fields.
			synthesis_axes_leaning_toward_valid_count_sum: sumMetric(
				'synthesis_axes_leaning_toward_valid_count'
			),
			synthesis_axes_leaning_toward_valid_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.synthesis_axes_leaning_toward_valid_count ?? 0
						)
					)
				: 0,
			// iter-88: stream_2 counterparts for iter-72's primary-bus synthesis
			// axes + scout_assignments count rollups — closing the last unprobed
			// synthesis cells on the /api/stream snapshot matrix. Mirror pattern
			// of iter-66 (which closed stream_2_facade_ready + synthesis_updated
			// + evidence_updated counts) and iter-67 (which added stream_2 facade
			// format_valid alongside the primary). Under iter-61 healthy-auth
			// 5-intent 12s-window baseline the stream_2 replay snapshot captures
			// the cold-start synthesis payload (fires at ~3-5s, stream_2 opens
			// at ~12s), so the same primary-bus identity invariants from iter-72
			// also hold on the replay path:
			//   stream_2_synthesis_axes_count_sum = 30
			//     = 6 * stream_2_synthesis_updated_count_sum (iter-66)
			//     = synthesis_axes_count_sum (iter-72, primary bus)
			//   stream_2_synthesis_axes_count_min = 6 (per intent)
			//   stream_2_synthesis_scout_assignments_count_sum = 30
			//   stream_2_synthesis_scout_assignments_count_min = 6
			//
			// Regression classes these aggregate rollups catch that iter-72's
			// primary rollups cannot: a bug in +server.ts:24-26's replay block
			// that emits synthesis-updated with axes dropped (stream_2 count
			// drops to 0 while iter-66 stream_2_synthesis_updated_count holds
			// at 5); replay serializing synthesis as null (stream_2 axes_count
			// at 0 but primary synthesis_axes_count_sum stays at 30); a clone-
			// and-mutate bug where synthesis is cloned then axes truncated on
			// the way out (_min drops to 5 while primary holds at 6).
			// Cross-stream divergence (stream_2_axes_count_sum != primary
			// axes_count_sum under healthy-auth) pinpoints replay-block bugs
			// invisible to single-stream probes.
			//
			// Under broken-auth baseline: both primary and stream_2 synthesis
			// count _sum=0 because no cold-start fires on the broken-auth
			// regime — the cross-stream identity 0==0 is preserved without
			// being discriminative on either side. This makes these probes
			// baseline-regime-invariant in the same way iter-67's facade_
			// format_valid probes are (identity holds under any regime, the
			// absolute values differ).
			stream_2_synthesis_axes_count_sum: sumMetric('stream_2_synthesis_axes_count'),
			stream_2_synthesis_axes_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_synthesis_axes_min ?? 0))
				: 0,
			stream_2_synthesis_scout_assignments_count_sum: sumMetric('stream_2_synthesis_scout_assignments_count'),
			stream_2_synthesis_scout_assignments_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_synthesis_scout_assignments_min ?? 0))
				: 0,
			// iter-89: stream_2 counterparts for iter-81's primary-bus evidence-
			// updated array-shape rollups — closing one of iter-88's 5 explicitly-
			// named unclosed stream_2 counterpart backlog items (evidence array-
			// shape). Mirror pattern of iter-88 (which closed the synthesis axes/
			// scout_assignments count+min counterparts). Under iter-61 healthy-
			// auth 5-intent 12s-window baseline the stream_2 replay snapshot
			// captures the 1-item evidence array + empty antiPatterns array that
			// context.ts:93 persisted from the single accept-swipe (swipe at
			// ~4-5s, stream_2 opens at ~12s), so the same primary-bus identity
			// invariants from iter-81 also hold on the replay path:
			//   stream_2_evidence_array_valid_count_sum = 5
			//     = evidence_array_valid_count_sum (iter-81, primary bus)
			//     = stream_2_evidence_updated_count_sum (iter-66)
			//   stream_2_evidence_array_valid_count_min = 1 (per intent)
			//   stream_2_anti_patterns_array_valid_count_sum = 5 (antiPatterns
			//     is always an array, even empty [] satisfies Array.isArray)
			//   stream_2_anti_patterns_array_valid_count_min = 1
			//   stream_2_evidence_length_cross_intent_min = 1 (cumulative after
			//     1 swipe)
			//   stream_2_evidence_length_cross_intent_max = 1 (same rationale,
			//     grows with multi-swipe validators landing)
			//
			// Regression classes these aggregate rollups catch that iter-81's
			// primary rollups cannot: a bug in +server.ts:30-32's replay block
			// that serializes context.evidence as an object (stream_2 array_valid
			// drops to 0 while iter-66 stream_2_evidence_updated_count holds at
			// 5); replay cloning evidence then truncating to an empty array
			// (length_max drops to 0 while primary holds at 1); replay stripping
			// antiPatterns from the payload (anti_patterns_array_valid drops to
			// 0 while evidence_array_valid holds — discriminating the two sides
			// of the payload shape); replay emitting {evidence: evidence[0]}
			// instead of {evidence: [...evidence]} (stream_2 array_valid drops
			// to 0 across all intents).
			//
			// Cross-stream divergence (stream_2_evidence_array_valid_count_sum
			// != primary evidence_array_valid_count_sum under healthy-auth)
			// pinpoints replay-block bugs invisible to single-stream probes. A
			// regression that breaks BOTH the live emission path and the replay
			// path would show both counts dropping together (e.g. context.ts:93
			// corruption affecting both context.evidence state AND its [...]
			// spread at emit time); a regression affecting ONLY the replay path
			// (e.g. +server.ts:31 spreading stripped) shows stream_2 drop while
			// primary holds.
			//
			// Under broken-auth baseline: both primary and stream_2 evidence
			// array_valid _sum=0 because no facade-ready → no swipe → no
			// addEvidence → no evidence-updated emit on either stream — the
			// cross-stream identity 0==0 is preserved without being
			// discriminative on either side. Baseline-regime-invariant just like
			// iter-67/72/88 probes.
			stream_2_evidence_array_valid_count_sum: sumMetric('stream_2_evidence_array_valid_count'),
			stream_2_evidence_array_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_array_valid_count ?? 0))
				: 0,
			stream_2_anti_patterns_array_valid_count_sum: sumMetric('stream_2_anti_patterns_array_valid_count'),
			stream_2_anti_patterns_array_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_anti_patterns_array_valid_count ?? 0))
				: 0,
			stream_2_evidence_length_cross_intent_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_length_min ?? 0))
				: 0,
			stream_2_evidence_length_cross_intent_max: perIntent.length
				? Math.max(...perIntent.map((p) => p.metrics.stream_2_evidence_length_max ?? 0))
				: 0,
			// iter-90: stream_2 counterparts for iter-82's primary-bus evidence-
			// updated array-element typed-union rollups — closing the 2nd of iter-
			// 88's 5 explicitly-named unclosed stream_2 counterpart backlog items
			// (iter-89 closed the 1st: evidence array-shape; iter-90 closes the
			// 2nd: evidence items typed-union). Extends iter-89's whole-array
			// presence-validity stream_2 mirror to within-item field validation,
			// establishing a deeper cross-stream identity layer. Under iter-61
			// healthy-auth 5-intent 12s-window baseline the replay carries the
			// same 1-item evidence array as the primary bus (decision='accept',
			// format='word', latencySignal='slow'), so all three item-level counts
			// match iter-82's primary identity:
			//   stream_2_evidence_items_valid_decision_count_sum = 5
			//     = evidence_items_valid_decision_count_sum (iter-82, primary bus)
			//     = stream_2_evidence_array_valid_count_sum (iter-89)
			//     × stream_2_evidence_length_cross_intent_max (iter-89)
			//   stream_2_evidence_items_valid_decision_count_min = 1 (per intent)
			//   stream_2_evidence_items_valid_format_count_sum = 5 / _min = 1
			//   stream_2_evidence_items_valid_latency_signal_count_sum = 5 / _min = 1
			//
			// Regression classes these rollups catch that iter-89's whole-array
			// probes alone cannot: a replay-block transform that preserves array-
			// shape but corrupts per-item fields (e.g. +server.ts:30-32 adds a
			// .map(e => ({...e, decision: 'unknown'})) — stream_2 array_valid stays
			// at 5 but stream_2 items_valid_decision_count drops to 0 while primary
			// stays at 5); a serialization that strips typed-union fields from
			// replay-only payloads (stream_2 items_valid drops while primary holds);
			// a payload-shape divergence where replay synthesizes evidence items
			// with default-value fields rather than the real context.evidence
			// entries (stream_2 items_valid may hold by accident if defaults match
			// union values, but a multi-swipe baseline would expose the
			// cumulative-state loss — forward-deploy discriminative).
			//
			// Cross-stream divergence (stream_2 items_valid != primary items_valid
			// under healthy-auth) pinpoints replay-block item-corruption bugs
			// invisible to iter-89's whole-array probes and iter-82's primary-
			// only item probes. A regression affecting BOTH the live emission
			// path and the replay path would show both counts dropping together;
			// a regression affecting ONLY the replay path shows stream_2 drop
			// while primary holds.
			//
			// Under broken-auth baseline: both primary and stream_2 items_valid
			// _sum=0 because no facade-ready → no swipe → no addEvidence → no
			// evidence-updated emit on either stream — the cross-stream identity
			// 0==0 is preserved without being discriminative on either side.
			// Baseline-regime-invariant just like iter-67/72/82/88/89 probes.
			stream_2_evidence_items_valid_decision_count_sum: sumMetric('stream_2_evidence_items_valid_decision_count'),
			stream_2_evidence_items_valid_decision_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_items_valid_decision_count ?? 0))
				: 0,
			stream_2_evidence_items_valid_format_count_sum: sumMetric('stream_2_evidence_items_valid_format_count'),
			stream_2_evidence_items_valid_format_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_items_valid_format_count ?? 0))
				: 0,
			stream_2_evidence_items_valid_latency_signal_count_sum: sumMetric('stream_2_evidence_items_valid_latency_signal_count'),
			stream_2_evidence_items_valid_latency_signal_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_items_valid_latency_signal_count ?? 0))
				: 0,
			// iter-102: stream_2 counterparts for iter-102's primary-bus SwipeEvidence
			// remaining-field presence-validity rollups (facadeId, content, hypothesis,
			// implication) — saturating the SwipeEvidence 7-way field-validity matrix
			// on the /api/stream replay path alongside iter-89's array-shape + length
			// probes and iter-90's typed-union probes. Closes the evidence-updated
			// counterpart to iter-99's facade-ready 6-way stream_2 saturation.
			//
			// Under iter-61 healthy-auth 5-intent 12s-window baseline: +server.ts:30-32
			// replays evidence-updated once per new client when context.evidence.length
			// > 0; context.ts:93 addEvidence emits at ~4-5s (well before stream_2 opens
			// at ~12s) and persists context.evidence with 1 item carrying all 4 string
			// fields populated from the facade lookup (per iter-89 learnings). So the
			// replay's 1-item array mirrors primary, and each stream_2 probe = its
			// primary-bus counterpart = 1 per intent (sum=5/_min=1 aggregate).
			//
			// 7-way cross-stream POSITIVE-IDENTITY under healthy-auth baseline:
			//   stream_2_evidence_updated_count_sum (iter-66)
			//     = stream_2_evidence_array_valid_count_sum (iter-89)
			//     = stream_2_evidence_items_valid_decision_count_sum (iter-90)
			//     = stream_2_evidence_items_valid_format_count_sum (iter-90)
			//     = stream_2_evidence_items_valid_latency_signal_count_sum (iter-90)
			//     = stream_2_evidence_items_facade_id_present_count_sum (iter-102)
			//     = stream_2_evidence_items_content_present_count_sum (iter-102)
			//     = stream_2_evidence_items_hypothesis_present_count_sum (iter-102)
			//     = stream_2_evidence_items_implication_present_count_sum (iter-102)
			//     = 5 (sum) / 1 (min) across 5-intent search set, matching primary.
			//
			// Regression classes these rollups catch that iter-90 stream_2 typed-union
			// probes alone cannot: a +server.ts:30-32 replay-block transform that
			// preserves decision/format/latencySignal union-membership but corrupts
			// a string field (e.g. a JSON-serialize pipeline that truncates non-ASCII
			// chars in implication, a .map(e => ({...e, content: null})) test shim
			// accidentally landed, a payload-shape change where replay emits evidence
			// items with only the typed-union fields populated) — stream_2
			// items_valid_decision stays at 5 while stream_2 items_{facade_id,content,
			// hypothesis,implication}_present drops below 5, distinguishing union-
			// membership corruption from string-field corruption on the replay path.
			//
			// Cross-stream divergence (stream_2 counts != primary counts under
			// healthy-auth) pinpoints replay-block-only string-field bugs that iter-89
			// whole-array probes, iter-90 stream_2 typed-union probes, and iter-102
			// primary string-field probes cannot individually discriminate. A
			// regression affecting BOTH live emission and replay paths shows both
			// counts drop together; a regression affecting ONLY replay shows stream_2
			// drop while primary holds — exactly the cross-stream discrimination
			// pattern iter-88 established as the unique value of stream_2 counterparts.
			//
			// Baseline-regime-invariant: under broken-auth baseline both primary and
			// stream_2 items_{facade_id,content,hypothesis,implication}_present _sum=0
			// because no facade-ready → no swipe → no addEvidence → no evidence-
			// updated emit on either stream — the cross-stream identity 0==0 is
			// preserved without being discriminative on either side, matching
			// iter-67/72/82/88/89/90/91 probe behavior across regimes.
			stream_2_evidence_items_facade_id_present_count_sum: sumMetric('stream_2_evidence_items_facade_id_present_count'),
			stream_2_evidence_items_facade_id_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_items_facade_id_present_count ?? 0))
				: 0,
			stream_2_evidence_items_content_present_count_sum: sumMetric('stream_2_evidence_items_content_present_count'),
			stream_2_evidence_items_content_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_items_content_present_count ?? 0))
				: 0,
			stream_2_evidence_items_hypothesis_present_count_sum: sumMetric('stream_2_evidence_items_hypothesis_present_count'),
			stream_2_evidence_items_hypothesis_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_items_hypothesis_present_count ?? 0))
				: 0,
			stream_2_evidence_items_implication_present_count_sum: sumMetric('stream_2_evidence_items_implication_present_count'),
			stream_2_evidence_items_implication_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_evidence_items_implication_present_count ?? 0))
				: 0,
			// iter-91: stream_2 counterparts for iter-83's primary-bus synthesis-
			// updated.axes[].confidence typed-union probe AND iter-85's scout_
			// assignments[].scout roster-membership probe — closes the 3rd and 4th
			// of iter-88's 5 explicitly-named unclosed stream_2 counterpart backlog
			// items in a single iteration (iter-89 closed the 1st: evidence array-
			// shape; iter-90 closed the 2nd: evidence items typed-union; the 5th
			// named item — swipe-result — is NOT replayed on /api/stream, so no
			// stream_2 counterpart by construction, closing the backlog).
			//
			// Pattern mirrors iter-90's cross-stream identity extension: iter-88
			// established stream_2 axes/scout_assignments COUNT identity with
			// primary (iter-72); iter-91 extends to within-item FIELD-validity
			// identity. Under iter-61 healthy-auth 5-intent 12s-window baseline,
			// +server.ts:24-26 replays synthesis-updated via JSON.stringify on
			// context.synthesis; cold-start synthesis fires by ~3-5s and persists
			// on context, so the replay at ~12s carries the same 6 axes (all
			// confidence='unprobed' per oracle.ts:332-349 cold-start hard-code)
			// and 6 scout_assignments (all scout ∈ 6-name roster per oracle.ts:
			// 58 z.enum and iter-84's synthesisSchema tightening). Identity:
			//   stream_2_synthesis_axes_valid_confidence_count_sum = 30
			//     = synthesis_axes_valid_confidence_count_sum (iter-83, primary)
			//     = stream_2_synthesis_axes_count_sum (iter-88)
			//     = 6 * synthesis_updated_count_sum (5 intents)
			//   stream_2_synthesis_axes_valid_confidence_count_min = 6 per intent
			//   stream_2_synthesis_scout_assignments_valid_scout_count_sum = 30
			//     = synthesis_scout_assignments_valid_scout_count_sum (iter-85)
			//     = stream_2_synthesis_scout_assignments_count_sum (iter-88)
			//     = 6 * synthesis_updated_count_sum (5 intents)
			//   stream_2_synthesis_scout_assignments_valid_scout_count_min = 6
			//
			// Regression classes these rollups catch that iter-88's count probes
			// alone cannot: a replay-block transform that preserves synthesis-
			// updated array-shape but corrupts per-item fields (e.g. +server.ts:
			// 24-26 adds a .map(a => ({...a, confidence: 'unknown'})) — iter-88
			// stream_2_synthesis_axes_count stays at 6, iter-91 stream_2_synthesis_
			// axes_valid_confidence_count drops to 0 while primary iter-83 stays
			// at 6); a serialization that strips typed-union fields on replay-only
			// payload (stream_2 items_valid drops while primary holds); a payload-
			// shape divergence where replay synthesizes axes with default values
			// (stream_2 items_valid may hold by accident if defaults match union
			// values, but any future broken roster 'confidence' addition to
			// EmergentAxis type would expose mismatch). Cross-stream divergence
			// (stream_2 items_valid != primary items_valid under healthy-auth)
			// pinpoints replay-block item-corruption invisible to iter-88's
			// whole-array length probes and iter-83/85's primary-only item probes.
			//
			// Forward-deploy discriminative signal: under runSynthesis path (4+
			// swipes, currently unreachable in 12s window) confidence becomes a
			// mix of 'exploring'/'leaning'/'resolved' per evidence strength. A
			// replay-block bug that truncates confidence to 'unprobed' universally
			// (stale-snapshot sync bug) would leave iter-88 axes_count at identity
			// but flip iter-91 stream_2_axes_valid_confidence_count distribution
			// from multi-value to single-value — orthogonal to primary iter-83's
			// detection of the same regression on the live path.
			//
			// Under broken-auth baseline: both primary and stream_2 items_valid
			// _sum=0 because no synthesis-updated event fires on either stream —
			// the cross-stream identity 0==0 is preserved without being
			// discriminative on either side. Baseline-regime-invariant just like
			// iter-67/72/82/88/89/90 probes.
			stream_2_synthesis_axes_valid_confidence_count_sum: sumMetric('stream_2_synthesis_axes_valid_confidence_count'),
			stream_2_synthesis_axes_valid_confidence_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_synthesis_axes_valid_confidence_count ?? 0))
				: 0,
			// iter-103: stream_2 counterparts for iter-103's primary-bus EmergentAxis
			// remaining-field presence-validity rollups (label, poleA, poleB,
			// evidence_basis) — saturating the EmergentAxis 5-way field-validity
			// matrix on the /api/stream replay path alongside iter-91's stream_2
			// axes.confidence typed-union rollup and iter-88's whole-array axes
			// length rollup. Closes the synthesis-updated counterpart to iter-102's
			// evidence-updated stream_2 saturation — continues the cross-stream
			// POSITIVE-IDENTITY family across iter-99 (Facade stream_2) / iter-100
			// (PrototypeDraft stream_2) / iter-101 (AgentState stream_2) / iter-102
			// (SwipeEvidence stream_2).
			//
			// Under iter-61 healthy-auth 5-intent 12s-window baseline: +server.ts:
			// 24-26 replays synthesis-updated via JSON.stringify on context.synthesis;
			// cold-start synthesis fires by ~3-5s (oracle.ts:339-347) and persists
			// on context, so the replay at ~12s carries 6 axes with all 4 string
			// fields populated — matching the primary-bus iter-103 identity. Each
			// stream_2 probe = primary counterpart = 6 per intent (sum=30/_min=6
			// aggregate).
			//
			// 5-way cross-stream POSITIVE-IDENTITY chain at aggregate under healthy-auth:
			//   stream_2_synthesis_axes_count_sum (iter-88, 30)
			//     = stream_2_synthesis_axes_valid_confidence_count_sum (iter-91, 30)
			//     = stream_2_synthesis_axes_label_present_count_sum (iter-103, 30)
			//     = stream_2_synthesis_axes_pole_a_present_count_sum (iter-103, 30)
			//     = stream_2_synthesis_axes_pole_b_present_count_sum (iter-103, 30)
			//     = stream_2_synthesis_axes_evidence_basis_present_count_sum (iter-103, 30)
			//     = 6 × stream_2_synthesis_updated_count_sum (iter-66, 5)
			//     = primary synthesis_axes_*_present_count_sum (iter-103, 30)
			//
			// Regression classes these rollups catch that iter-91 stream_2 typed-
			// union probes alone cannot: a +server.ts:24-26 replay-block transform
			// that preserves axes array-shape and confidence union-membership but
			// corrupts a string field (e.g. a .map(a => ({...a, poleB: null}))
			// transform accidentally landed, a JSON-serialize pipeline that strips
			// non-ASCII chars from evidence_basis, a payload-shape change where
			// replay emits axes with only the typed-union fields populated) —
			// stream_2 axes_valid_confidence stays at 30 while stream_2 axes_
			// {label,pole_a,pole_b,evidence_basis}_present drops below 30,
			// distinguishing union-membership corruption from string-field
			// corruption on the replay path. Cross-stream divergence (stream_2
			// counts != primary counts under healthy-auth) pinpoints replay-block-
			// only string-field bugs that iter-91 stream_2 typed-union probes and
			// iter-103 primary string-field probes cannot individually discriminate.
			//
			// A regression affecting BOTH live emission and replay paths shows both
			// counts dropping together; a regression affecting ONLY the replay path
			// shows stream_2 drop while primary holds — exactly the cross-stream
			// discrimination pattern iter-88/90/91/99/100/101/102 established as
			// the unique value of stream_2 counterparts.
			//
			// Baseline-regime-invariant: under broken-auth baseline both primary
			// and stream_2 axes string-field probes _sum=0 because no cold-start
			// fires on either stream — the cross-stream identity 0==0 is preserved
			// without being discriminative on either side, matching iter-67/72/82/
			// 88/89/90/91/102 probe behavior across regimes.
			stream_2_synthesis_axes_label_present_count_sum: sumMetric(
				'stream_2_synthesis_axes_label_present_count'
			),
			stream_2_synthesis_axes_label_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.stream_2_synthesis_axes_label_present_count ?? 0)
					)
				: 0,
			stream_2_synthesis_axes_pole_a_present_count_sum: sumMetric(
				'stream_2_synthesis_axes_pole_a_present_count'
			),
			stream_2_synthesis_axes_pole_a_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.stream_2_synthesis_axes_pole_a_present_count ?? 0)
					)
				: 0,
			stream_2_synthesis_axes_pole_b_present_count_sum: sumMetric(
				'stream_2_synthesis_axes_pole_b_present_count'
			),
			stream_2_synthesis_axes_pole_b_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map((p) => p.metrics.stream_2_synthesis_axes_pole_b_present_count ?? 0)
					)
				: 0,
			stream_2_synthesis_axes_evidence_basis_present_count_sum: sumMetric(
				'stream_2_synthesis_axes_evidence_basis_present_count'
			),
			stream_2_synthesis_axes_evidence_basis_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.stream_2_synthesis_axes_evidence_basis_present_count ?? 0
						)
					)
				: 0,
			stream_2_synthesis_scout_assignments_valid_scout_count_sum: sumMetric('stream_2_synthesis_scout_assignments_valid_scout_count'),
			stream_2_synthesis_scout_assignments_valid_scout_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_synthesis_scout_assignments_valid_scout_count ?? 0))
				: 0,
			// iter-104: stream_2 counterparts for iter-104's primary-bus scout_
			// assignments[] remaining-field presence-validity probes (probe_axis,
			// reason). Cross-stream POSITIVE-IDENTITY with iter-91 stream_2 scout
			// roster probe and primary iter-104 string probes under healthy-auth
			// 5-intent 12s-window baseline: each = 30/_min=6, matching primary.
			// Saturates the scout_assignments 3-way field-validity matrix on the
			// /api/stream replay path — the scout_assignments counterpart to iter-
			// 103's stream_2 EmergentAxis 4-field closure (label/poleA/poleB/
			// evidence_basis) and iter-102's stream_2 SwipeEvidence 4-field closure.
			//
			// Regression classes catchable only by stream_2 counterparts (distinct
			// from iter-91's stream_2 roster probe): a +server.ts:24-26 replay-
			// block transform that preserves scout_assignments array-shape and
			// scout roster-membership but corrupts a string field (a .map(a =>
			// ({...a, reason: null})) transform, a JSON-serialize pipeline that
			// strips probe_axis chars, a payload-shape change where replay emits
			// assignments with only the scout field populated) — stream_2_valid_
			// scout_count stays at 30 while stream_2 probe_axis_present or reason_
			// present drops below 30, distinguishing roster-membership corruption
			// from string-field corruption on the replay path without needing
			// primary to also drop. Cross-stream divergence (stream_2 counts !=
			// primary counts under healthy-auth) pinpoints replay-block-only
			// string-field bugs that iter-91's stream_2 typed-union probe and
			// this iteration's primary string-field probes cannot individually
			// discriminate — continuing the cross-stream discrimination pattern
			// iter-88/90/91/102/103 established.
			stream_2_synthesis_scout_assignments_probe_axis_present_count_sum: sumMetric(
				'stream_2_synthesis_scout_assignments_probe_axis_present_count'
			),
			stream_2_synthesis_scout_assignments_probe_axis_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.stream_2_synthesis_scout_assignments_probe_axis_present_count ?? 0
						)
					)
				: 0,
			stream_2_synthesis_scout_assignments_reason_present_count_sum: sumMetric(
				'stream_2_synthesis_scout_assignments_reason_present_count'
			),
			stream_2_synthesis_scout_assignments_reason_present_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.stream_2_synthesis_scout_assignments_reason_present_count ?? 0
						)
					)
				: 0,
			// iter-94: stream_2 counterpart rollup for iter-94's primary-bus
			// synthesis_palette_present_count. Paired with the primary rollup
			// above as a cross-stream identity — under any regime the stream_2
			// replay snapshot of synthesis.palette should match the primary-bus
			// emit's palette on every replayed synthesis event. Under iter-61
			// healthy-auth 5-intent 12s-window baseline both hold at 0. A replay-
			// block regression that emits synthesis-updated with palette dropped
			// while primary retains it would drop stream_2_palette_present below
			// primary_palette_present under forward-deploy runSynthesis regimes.
			// Baseline-regime-invariant structure (identity 0==0 under current
			// baseline, positive identity under forward-deploy) parallel to the
			// iter-88/89/90/91 cross-stream synthesis/evidence rollups.
			stream_2_synthesis_palette_present_count_sum: sumMetric('stream_2_synthesis_palette_present_count'),
			stream_2_synthesis_palette_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.stream_2_synthesis_palette_present_count ?? 0))
				: 0,
			// iter-105: stream_2 counterparts for iter-105's primary-bus TasteSynthesis
			// top-level remaining-field rollups — cross-stream POSITIVE-IDENTITY
			// under healthy-auth 5-intent 12s-window baseline: both stream_2
			// counterparts = stream_2_synthesis_updated_count_sum = 5/_min=1, identity-
			// matched with primary iter-105 at 5/_min=1. Saturates the TasteSynthesis
			// struct-boundary 5-way field-validity matrix on the /api/stream replay
			// path alongside iter-88 (axes+scout_assignments count), iter-91 (axes.
			// confidence + scout_assignments.scout typed-union), iter-94 (palette
			// SHOULD-BE-ZERO), iter-103 (EmergentAxis 4 string fields), iter-104
			// (scout_assignments 2 string fields).
			//
			// Cross-stream POSITIVE-IDENTITY chain under healthy-auth baseline:
			//   stream_2_synthesis_updated_count_sum (iter-66, 5)
			//     = stream_2_synthesis_edge_case_flags_array_valid_count_sum (iter-105, 5)
			//     = stream_2_synthesis_persona_anima_divergence_valid_count_sum (iter-105, 5)
			//     = synthesis_edge_case_flags_array_valid_count_sum (primary iter-105, 5)
			//     = synthesis_persona_anima_divergence_valid_count_sum (primary iter-105, 5)
			//
			// Regression classes catchable only at stream_2 (orthogonal to primary
			// iter-105): a +server.ts:24-26 replay-block transform that strips
			// edge_case_flags from the JSON payload (a test shim left in, a clone
			// that drops empty arrays, a payload-shape refactor that omits nullable/
			// default fields) — primary iter-105 holds at 5 (live emission preserves
			// the fields), stream_2 iter-105 drops below 5, distinguishing replay-
			// block serialization from primary-emission corruption. Similarly,
			// persona_anima_divergence may be mutated by replay: a replay that
			// coerces null to undefined (e.g. through a JSON.stringify pipeline
			// followed by a JSON.parse + field-stripping pass) catches in stream_2
			// but not primary. Cross-stream divergence pinpoints replay-block-only
			// serialization bugs that neither primary iter-105 nor iter-88/91/94/
			// 103/104 stream_2 probes can individually discriminate — continuing
			// the cross-stream discrimination pattern iter-88/90/91/99/102/103/104
			// established.
			//
			// Forward-deploy regimes: same as primary iter-105 — both probes hold
			// at identity under cold-start (edge_case_flags=[] / persona_anima_
			// divergence=null) AND runSynthesis (edge_case_flags may be populated /
			// persona_anima_divergence may be a string). The replay path at
			// +server.ts:24-26 JSON.stringify's context.synthesis, preserving
			// both regime outputs unchanged, so the cross-stream identity holds
			// on BOTH synthesis paths.
			stream_2_synthesis_edge_case_flags_array_valid_count_sum: sumMetric(
				'stream_2_synthesis_edge_case_flags_array_valid_count'
			),
			stream_2_synthesis_edge_case_flags_array_valid_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.stream_2_synthesis_edge_case_flags_array_valid_count ?? 0
						)
					)
				: 0,
			stream_2_synthesis_persona_anima_divergence_valid_count_sum: sumMetric(
				'stream_2_synthesis_persona_anima_divergence_valid_count'
			),
			stream_2_synthesis_persona_anima_divergence_valid_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.stream_2_synthesis_persona_anima_divergence_valid_count ?? 0
						)
					)
				: 0,
			// iter-106: stream_2 counterpart for iter-106's primary-bus axes[].
			// leaning_toward nullable-string union-valid rollup — cross-stream
			// POSITIVE-IDENTITY under healthy-auth 5-intent 12s-window baseline:
			// stream_2_synthesis_axes_leaning_toward_valid_count_sum = 30/_min=6,
			// identity-matched with primary iter-106 at 30/_min=6. Saturates the
			// EmergentAxis 6-way field-validity matrix on the /api/stream replay
			// path alongside iter-88 (axes length), iter-91 (confidence typed-
			// union), iter-103 (4 string presence-validity). Closes iter-105's
			// explicitly-named follow-on — the LAST unprobed EmergentAxis field
			// on the replay stream.
			//
			// Cross-stream POSITIVE-IDENTITY chain under healthy-auth baseline:
			//   stream_2_synthesis_axes_count_sum (iter-88, 30)
			//     = stream_2_synthesis_axes_valid_confidence_count_sum (iter-91, 30)
			//     = stream_2_synthesis_axes_label_present_count_sum (iter-103, 30)
			//     = stream_2_synthesis_axes_pole_a_present_count_sum (iter-103, 30)
			//     = stream_2_synthesis_axes_pole_b_present_count_sum (iter-103, 30)
			//     = stream_2_synthesis_axes_evidence_basis_present_count_sum (iter-103, 30)
			//     = stream_2_synthesis_axes_leaning_toward_valid_count_sum (iter-106, 30) ← this rollup
			//     = synthesis_axes_leaning_toward_valid_count_sum (primary iter-106, 30)
			//
			// Regression classes catchable only at stream_2 (orthogonal to primary
			// iter-106): a +server.ts:24-26 replay-block transform that preserves
			// axes array-shape, confidence union-membership, and all string fields
			// but corrupts leaning_toward specifically — e.g. a .map(a => ({...a,
			// leaning_toward: undefined})) transform, a JSON serialize/parse
			// pipeline that normalizes null to undefined, a payload-shape refactor
			// that changes the nullable field to optional-and-omitted. Primary
			// iter-106 holds at 30 (live emission preserves null), stream_2 iter-
			// 106 drops below 30, pinpointing replay-block-only nullable-field
			// corruption distinct from typed-union (iter-91) / string-field (iter-
			// 103) / array-shape (iter-88) regression classes. Cross-stream
			// divergence (stream_2 != primary under healthy-auth) continues the
			// pattern iter-88/90/91/99/102/103/104/105 established.
			//
			// Forward-deploy regimes: same as primary iter-106 — probe holds at
			// identity under both cold-start (null) and runSynthesis (non-empty-
			// string resolved pole). The replay path at +server.ts:24-26 JSON.
			// stringify's context.synthesis, preserving both regime outputs
			// unchanged, so the cross-stream identity holds on BOTH synthesis paths.
			// Under reveal-reachable regime with runSynthesis-populated synthesis,
			// stream_2 continues to track primary identity because the replay
			// snapshot carries whatever context.synthesis state is current at
			// open time.
			stream_2_synthesis_axes_leaning_toward_valid_count_sum: sumMetric(
				'stream_2_synthesis_axes_leaning_toward_valid_count'
			),
			stream_2_synthesis_axes_leaning_toward_valid_count_min: perIntent.length
				? Math.min(
						...perIntent.map(
							(p) => p.metrics.stream_2_synthesis_axes_leaning_toward_valid_count ?? 0
						)
					)
				: 0,
			// iter-81: evidence-updated content-validation rollups — first
			// content-probe aggregates on the evidence-updated event after 80
			// iterations of count-only coverage. Parallel to iter-72's synthesis
			// content rollups and iter-80's swipe-result content rollups. Closes
			// iter-80's explicitly-named gap: 'evidence-updated (payload =
			// evidence[] + antiPatterns[], both arrays — would need array-shape
			// probes not union-membership)'. Under iter-69 healthy-auth baseline
			// with the validator's single hardcoded accept-swipe-per-intent:
			//   evidence_array_valid_count_sum = evidence_updated_count_sum = 5
			//   evidence_array_valid_count_min = 1 (addEvidence's emit always
			//     passes a real array — [...this.evidence] is constructed inline
			//     at emit time, so presence-validity identity holds on the wire
			//     as long as JSON.stringify preserves array-ness)
			//   anti_patterns_array_valid_count_sum = 5
			//   anti_patterns_array_valid_count_min = 1 (antiPatterns is always
			//     an array, even when empty — context.ts:38 initializes as
			//     string[] = [], the [] zero-value satisfies Array.isArray)
			//   evidence_length_cross_intent_min = 1 (cumulative evidence after
			//     1st swipe has length exactly 1 — per-intent min equals max)
			//   evidence_length_cross_intent_max = 1 (same rationale; becomes
			//     > 1 when multi-swipe validators land or rebuild's evidence-
			//     updated emit fires within window adding a 2nd event — but the
			//     cumulative state in that 2nd event still equals swipeCount)
			// Regression classes these aggregate rollups catch that evidence_
			// updated_count_sum alone cannot: context.evidence serialized as
			// object rather than array (event_count_sum stays 5, array_valid_
			// sum drops below 5); emit-side regression replacing [...evidence]
			// with a single SwipeEvidence object (same collapse); evidence-as-
			// deltas refactor where each emit carries the new entry rather than
			// cumulative state (array_valid identity holds, but evidence_length_
			// cross_intent_max stays at 1 after multi-swipe validators land,
			// flagging the semantic regression); antiPatterns stripped from
			// payload (event_count_sum stays 5, anti_patterns_array_valid_sum
			// drops to 0, orthogonal to evidence-side regressions). Forward-
			// deploy: when multi-swipe validators land, evidence_length_cross_
			// intent_max grows with swipe count per intent while both presence-
			// validity probes track event_count — the probe is baseline-regime-
			// invariant just like iter-67/72/80's content probes.
			evidence_array_valid_count_sum: sumMetric('evidence_array_valid_count'),
			evidence_array_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_array_valid_count ?? 0))
				: 0,
			anti_patterns_array_valid_count_sum: sumMetric('anti_patterns_array_valid_count'),
			anti_patterns_array_valid_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.anti_patterns_array_valid_count ?? 0))
				: 0,
			evidence_length_cross_intent_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_length_min ?? 0))
				: 0,
			evidence_length_cross_intent_max: perIntent.length
				? Math.max(...perIntent.map((p) => p.metrics.evidence_length_max ?? 0))
				: 0,
			// iter-82: evidence-updated array-element typed-union rollups —
			// extends iter-81's array-shape probes (presence-validity + length
			// distribution) to within-element field validation. Each SwipeEvidence
			// entry in evidence[] has three typed-union fields (decision ∈
			// {accept,reject}, format ∈ {word,mockup}, latencySignal ∈
			// {fast,slow}) per types.ts:7-15. This is the 'array-element union-
			// membership' follow-on iter-81's learning explicitly called out,
			// and the first validator probes that test fine-grained element
			// content rather than whole-array presence. Parallel to iter-67's
			// Facade.format first-content-probe, iter-80's SwipeRecord.{decision,
			// latencyBucket}, and iter-61's stage-changed.stage — all union-
			// membership probes on typed-union fields, differing only in what
			// carries the field (whole event payload vs item inside array).
			//
			// Under iter-69 healthy-auth baseline (12s window, 1 accept-swipe,
			// 1 evidence-updated emission per intent, 1 item in evidence array):
			//   evidence_items_valid_decision_count_sum = 5 / _min = 1
			//     (each intent's 1 item carries decision='accept' — one of the
			//     two valid union values)
			//   evidence_items_valid_format_count_sum = 5 / _min = 1
			//     (each intent's 1 item carries format='word' under stage=words)
			//   evidence_items_valid_latency_signal_count_sum = 5 / _min = 1
			//     (each intent's 1 item carries latencySignal='slow' because
			//     first-swipe median is 0, context.ts:69 forces 'slow')
			//
			// Three-way item-level identity: under healthy baseline all three
			// counts SHOULD equal evidence_array_valid_count_sum × evidence_
			// length_cross_intent_max (= 5 × 1 = 5). A regression where one
			// evidence item's 'decision' is null/undefined/typoed would drop
			// ONLY decision_count below 5 while format_count and latency_signal_
			// count stay at 5, pinpointing which field corrupted — stronger
			// discrimination than iter-81's whole-array checks alone.
			//
			// Forward-deploy regimes:
			//   - multi-swipe validators land: all three counts scale with
			//     sum-over-events-of-array-length per intent (cumulative running
			//     total); three-way identity still holds under correct behavior.
			//   - stage transitions to 'mockups' (evidence.length >= 4 per iter-
			//     context.ts:57 concretenessFloor): format='mockup' items start
			//     appearing; both 'word' and 'mockup' values satisfy union, so
			//     format_count stays at identity; the typed-union probe is
			//     stage-invariant just like iter-67's facade format probe.
			//   - latency distribution flips (second swipe with latencyMs<median):
			//     latencySignal='fast' starts appearing; both 'fast' and 'slow'
			//     values satisfy union, so latency_signal_count stays at identity;
			//     the typed-union probe is latency-regime-invariant.
			//
			// Regression classes these probes catch that iter-81 alone cannot:
			//   - evidence item decision field typo'd in context.ts addEvidence
			//     (e.g. 'accepted' instead of 'accept'): evidence_array_valid
			//     still =5 (array exists), evidence_length_max still =1 (shape
			//     preserved), but evidence_items_valid_decision_count drops below 5
			//   - evidence item format field stripped at emit-serialization
			//     boundary: array_valid =5, length_max =1, decision_count =5,
			//     latency_signal_count =5, but format_count drops — only the
			//     format probe catches the field-level loss
			//   - evidence item latencySignal set to undefined by a refactor
			//     removing context.ts:69's median-compare: array_valid =5,
			//     decision_count =5, format_count =5, latency_signal_count drops
			evidence_items_valid_decision_count_sum: sumMetric('evidence_items_valid_decision_count'),
			evidence_items_valid_decision_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_items_valid_decision_count ?? 0))
				: 0,
			evidence_items_valid_format_count_sum: sumMetric('evidence_items_valid_format_count'),
			evidence_items_valid_format_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_items_valid_format_count ?? 0))
				: 0,
			evidence_items_valid_latency_signal_count_sum: sumMetric('evidence_items_valid_latency_signal_count'),
			evidence_items_valid_latency_signal_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_items_valid_latency_signal_count ?? 0))
				: 0,
			// iter-102: SwipeEvidence remaining-field presence-validity rollups —
			// saturate the SwipeEvidence 7-way field-validity matrix on the primary
			// bus alongside iter-82's three typed-union fields (decision, format,
			// latencySignal) and iter-81's array-shape probes (evidence_array_valid,
			// anti_patterns_array_valid, evidence_length_cross_intent_min/max).
			// Closes the SwipeEvidence counterpart to iter-97 SwipeRecord 5-way /
			// iter-98 Facade 6-way / iter-100 PrototypeDraft 6-way / iter-101
			// AgentState 5-way matrix saturation — completing the POSITIVE-IDENTITY
			// cluster iter-97 opened.
			//
			// SwipeEvidence has 7 total fields per types.ts:7-15: 3 typed-union
			// fields (decision, format, latencySignal — closed by iter-82) + 4
			// required-string fields (facadeId, content, hypothesis, implication —
			// closed by iter-102). Under iter-61 healthy-auth 5-intent 12s-window
			// baseline with 1 accept-swipe per intent: context.ts:80-89 addEvidence
			// populates all 4 string fields from the facade lookup (facade.label/
			// hypothesis/acceptImplies are required z.string() in scout.ts:71-85 —
			// LLM guarantees non-empty on every scout output) plus record.facadeId
			// (always present since swipe POST requires it). Every emitted item
			// carries non-empty strings for all 4 fields, so each probe equals
			// evidence_items_valid_decision_count per intent = 1 (sum=5/_min=1
			// across 5-intent search set).
			//
			// 7-way item-level POSITIVE-IDENTITY chain under healthy-auth baseline:
			//   evidence_updated_count_sum (iter-66)
			//     = evidence_array_valid_count_sum (iter-81)
			//     = evidence_items_valid_decision_count_sum (iter-82)
			//     = evidence_items_valid_format_count_sum (iter-82)
			//     = evidence_items_valid_latency_signal_count_sum (iter-82)
			//     = evidence_items_facade_id_present_count_sum (iter-102)
			//     = evidence_items_content_present_count_sum (iter-102)
			//     = evidence_items_hypothesis_present_count_sum (iter-102)
			//     = evidence_items_implication_present_count_sum (iter-102)
			//     = 5 (sum) / 1 (min) across 5-intent search set.
			//
			// Regression classes iter-102 probes catch that iter-82 cannot:
			//   - addEvidence at context.ts:80-89 mutating one string field without
			//     the others (a refactor that sets content='' when facade.label is
			//     missing, or a null-coalesce chain that produces '' instead of a
			//     fallback): evidence_items_valid_decision_count stays at 5 while
			//     content_present drops to 0 — distinguishing field-level mutation
			//     from event-level loss that iter-82 typed-union probes cannot see
			//     because empty strings satisfy z.string() in the emit path.
			//   - a context.ts refactor that drops one of the 4 string fields
			//     entirely from the SwipeEvidence object literal (e.g. an object-
			//     spread that omits implication): TypeScript catches this at
			//     compile time but the zod-unvalidated emit at context.ts:93 would
			//     slip runtime-null values through, and per-field probes flag
			//     exactly which field dropped — orthogonal discriminative signal.
			//   - facade lookup at context.ts:73-74 returning undefined (a race-
			//     condition bug where consumedFacades mutates concurrently with
			//     facades): content/hypothesis/implication all fall through to
			//     their ?? '' fallback and ALL THREE probes drop together while
			//     facadeId stays at identity — the three-way drop discriminates
			//     facade-lookup failure from individual-field corruption.
			//   - implication specifically: if facade.acceptImplies is schema-
			//     optional in a future refactor (currently required z.string()
			//     per scout.ts:74), implication could become '' silently —
			//     implication_present drops to 0 while facadeId/content/hypothesis
			//     stay at identity, pinpointing the schema-narrowing regression.
			//
			// Forward-deploy regimes: under multi-swipe validators, all 4 string
			// probes scale with sum-of-array-lengths-across-events (cumulative
			// running total in context.evidence per context.ts:89); 7-way identity
			// holds under correct multi-swipe behavior. Under reject-swipe regime,
			// implication = facade.rejectImplies instead of acceptImplies — both
			// satisfy z.string() non-empty guarantees so the probe stays at
			// identity. The 4 string probes are stage-invariant (word vs mockup),
			// latency-regime-invariant (first-swipe slow vs multi-swipe fast/slow
			// mix), and decision-regime-invariant (accept vs reject) — just like
			// iter-82's typed-union probes.
			evidence_items_facade_id_present_count_sum: sumMetric('evidence_items_facade_id_present_count'),
			evidence_items_facade_id_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_items_facade_id_present_count ?? 0))
				: 0,
			evidence_items_content_present_count_sum: sumMetric('evidence_items_content_present_count'),
			evidence_items_content_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_items_content_present_count ?? 0))
				: 0,
			evidence_items_hypothesis_present_count_sum: sumMetric('evidence_items_hypothesis_present_count'),
			evidence_items_hypothesis_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_items_hypothesis_present_count ?? 0))
				: 0,
			evidence_items_implication_present_count_sum: sumMetric('evidence_items_implication_present_count'),
			evidence_items_implication_present_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_items_implication_present_count ?? 0))
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
				: 0,
			// iter-70 builder rebuild latency rollups — sibling to iter-51's
			// scaffold rollups, completing the per-builder-call latency family.
			// iter-69 unblocked the rebuild path by removing the scaffold's
			// `swipeCount === 0` gate, which had implicitly suppressed rebuild
			// completions from emitting draft-updated under healthy-auth demo
			// timing. Post-iter-69 the rebuild fires once per swipe, observable
			// at 3-12s Haiku latency between thinking 'analyzing X' and the
			// next idle transition. Under iter-69 healthy-auth baseline with the
			// validate.mjs swipeWatcher posting exactly one accept per intent,
			// the expected invariants are:
			//   builder_rebuild_count_sum=5 _min=1 (1 swipe per intent × 5 intents)
			//   builder_rebuild_latency_ms_p50 ≈ 3000-12000ms (Haiku rebuild RTT)
			//   builder_rebuild_latency_ms_p90 ≈ p50 + small jitter
			// Distinct from time_to_first_draft_after_swipe_ms (iter-68): that
			// measures swipe-POST → first draft-updated wall-clock, this measures
			// the agent-status thinking→idle interval which excludes SSE / event-
			// loop overhead and isolates the Haiku rebuild call latency. The two
			// together discriminate end-to-end product latency from raw LLM RTT —
			// a regression in SSE flush would diverge them while a regression in
			// rebuild prompt complexity would move them together. Forward-deploy:
			// when multi-swipe support lands, the count scales with swipe count
			// per intent and the p50/p90 latency profile becomes a forward-deploy
			// product-optimization target distinct from scaffold's one-shot
			// latency. Orthogonal regression class to iter-51's scaffold latency:
			// scaffold uses SCAFFOLD_PROMPT (intent-only, no evidence), rebuild
			// uses SWIPE_PROMPT (evidence + draft + anti-patterns), so prompt-
			// complexity regressions on the rebuild path would inflate this
			// without touching scaffold; vice-versa for scaffold-only regressions.
			builder_rebuild_latency_ms_p50: percentile(
				perIntent.map((p) => p.metrics.builder_rebuild_latency_ms),
				50
			),
			builder_rebuild_latency_ms_p90: percentile(
				perIntent.map((p) => p.metrics.builder_rebuild_latency_ms),
				90
			),
			builder_rebuild_latency_ms_max: (() => {
				const vals = perIntent
					.map((p) => p.metrics.builder_rebuild_latency_ms_max)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.max(...vals) : null;
			})(),
			builder_rebuild_count_sum: sumMetric('builder_rebuild_count'),
			builder_rebuild_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.builder_rebuild_count ?? 0))
				: 0,
			// iter-68 harness-completeness close-out: promote the three per-intent
			// metrics that were forward-carried through extractMetrics (since
			// iter-18/20/22) but never surfaced at aggregate level. iter-66's
			// learning explicitly named this audit surface ("field in extractMetrics
			// but not in aggregate_metrics"), distinct from the iter-54/55/56/58/
			// 60/61/67 "content probe on event X" pattern and distinct from the
			// iter-26/27/29/37/39/40/41/65/66 "stream_2 cell" pattern. Under the
			// current iter-61 healthy-auth baseline:
			//   evidence_updated_count_sum=5 _min=1 — one evidence-updated per
			//     session, fired by oracle.handleSwipe after swipe ingestion.
			//     Identity with swipe_result_count_sum=5 today (one swipe per
			//     session); a regression where oracle fails to emit evidence-
			//     updated after swipe-result would drop _min to 0 while leaving
			//     swipe_result_count_sum intact. Complementary to iter-66's
			//     stream_2_evidence_updated_count_sum=5 _min=1 (snapshot-replay
			//     cardinality): primary tests live-emission, stream_2 tests
			//     replay-on-connect. A regression that fires evidence-updated
			//     live but drops it from replay would leave primary intact while
			//     collapsing stream_2.
			//   time_to_first_draft_after_swipe_ms_{p50,p90,max} — measures swipe-
			//     to-rebuild latency (not the placeholder which fires pre-swipe).
			//     Under the current 12s-window search-set this is null across all
			//     5 intents because rebuild doesn't complete before window close
			//     (builder_scaffold_latency_ms_p90=~12087ms per iter-51 probe).
			//     Forward-deploy: when scaffold latency drops OR window widens,
			//     this metric flips non-null and becomes the primary refinement-
			//     latency surface — directly connecting to iter-64's
			//     draft_refined_count_sum=0 frontier anchor (refined_sum becomes
			//     positive iff rebuild completes in-window, which this latency
			//     measures). A single-intent 14s-window run already shows
			//     ~11738ms, confirming the metric is derivable when rebuild
			//     completes.
			//   agent_error_signal_count_sum _min — stderr-derived Anthropic SDK
			//     error line count (ERROR_SIGNAL_RE match). Under healthy-auth
			//     baseline =0 per intent (no provider errors). Under broken-auth
			//     baseline flips non-zero (~8-40+ depending on backoff regime).
			//     iter-54's learning noted SSE-derived probes are more stable
			//     than stderr-derived; this rollup surfaces the stderr channel
			//     as a cross-check against iter-25/26/39/54 SSE-side probes that
			//     could drift from stderr signal under SDK upgrades or stderr
			//     format changes. A divergence between agent_error_signal_count
			//     (stderr) and error_event_count (SSE) under the same regime
			//     flags SDK-to-bus wiring bugs invisible to either alone.
			evidence_updated_count_sum: sumMetric('evidence_updated_count'),
			evidence_updated_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.evidence_updated_count ?? 0))
				: 0,
			time_to_first_draft_after_swipe_ms_p50: percentile(
				perIntent.map((p) => p.metrics.time_to_first_draft_after_swipe_ms),
				50
			),
			time_to_first_draft_after_swipe_ms_p90: percentile(
				perIntent.map((p) => p.metrics.time_to_first_draft_after_swipe_ms),
				90
			),
			time_to_first_draft_after_swipe_ms_max: (() => {
				const vals = perIntent
					.map((p) => p.metrics.time_to_first_draft_after_swipe_ms)
					.filter((v) => typeof v === 'number' && Number.isFinite(v));
				return vals.length ? Math.max(...vals) : null;
			})(),
			agent_error_signal_count_sum: sumMetric('agent_error_signal_count'),
			agent_error_signal_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.agent_error_signal_count ?? 0))
				: 0,
			// iter-93: count-probe rollups for the final 2 SSEEvent types with
			// zero prior probe coverage (facade-stale, builder-hint). Closes
			// the last 2 of 11 typed SSEEvent union members after 92 iterations.
			// Both are TRANSIENT events not replayed on /api/stream (per iter-91
			// audit of +server.ts replay block emitting only synthesis/evidence/
			// facade/draft/stage/agent-status), so no stream_2 counterparts exist
			// by construction — structurally N/A just like swipe-result (iter-91
			// noted it as the 5th of iter-88's backlog that cannot be closed).
			//
			// Under iter-61 healthy-auth 5-intent 12s-window baseline both = 0:
			//   facade_stale_count_sum = 0 / _min = 0 — oracle.ts:427 fires in
			//     the reveal path (REVEAL_THRESHOLD=15 evidence, unreachable
			//     under 1-swipe baseline); scout.ts:450 fires on stage
			//     transition / dedup (requires concretenessFloor flip from
			//     'word'→'mockup' at >=4 evidence, also unreachable). Identity
			//     with a never-fires-under-baseline invariant.
			//   builder_hint_count_sum = 0 / _min = 0 — builder.ts:370 fires
			//     only when rebuild's output.nextHint is non-empty AND rebuild
			//     completes (rebuild latency ~10-17s per iter-70, past 12s
			//     window). Under broken-auth baseline also = 0 because rebuild
			//     never fires.
			//
			// Baseline-regime-invariant: both probes hold _sum=0 identity across
			// healthy-auth, broken-auth, and mixed regimes because neither event
			// is reached by 1-swipe in-window. The probe's discriminative power
			// is on the SHOULD-BE-ZERO invariant — catches classes of regression
			// that iter-67/72/80/81/82/83/85/86/88-91 probes cannot:
			//   - spurious facade-stale emission: a dedup/diversity bug that
			//     fires facade-stale during healthy sessions (e.g. iter-76
			//     multi-session race variant where session 1's facades are
			//     staled by session 2's scouts) would flip facade_stale_count_
			//     sum above 0 while facade_ready_count_sum stays at 35.
			//   - wrong-phase builder-hint: a refactor that accidentally routes
			//     emitBuilderHint into the scaffold path (which doesn't currently
			//     emit hints) would flip builder_hint_count_sum above 0 without
			//     affecting builder_scaffold_count_sum.
			//   - cardinality-family regression: adding a new emit site for
			//     facade-stale or builder-hint in a non-reveal/non-rebuild path
			//     would shift _sum away from 0, surfacing the addition as a
			//     probe-coverage alert even before a content probe is authored.
			//
			// Forward-deploy: when a widened VALIDATE_RUN_MS (~20-30s) lets
			// rebuild complete in-window, builder_hint_count_sum will transition
			// from 0 to positive (once per rebuild that produces a nextHint).
			// That transition is a LEGITIMATE shift, not a regression — future
			// iterations noting _sum>0 should check whether the window changed
			// rather than assuming bug. Similarly, when reveal-path becomes
			// reachable (REVEAL_THRESHOLD dropped or multi-swipe harness lands),
			// facade_stale_count_sum transitions from 0 to positive (~7 per
			// intent as the reveal prune clears the facade queue).
			facade_stale_count_sum: sumMetric('facade_stale_count'),
			facade_stale_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.facade_stale_count ?? 0))
				: 0,
			builder_hint_count_sum: sumMetric('builder_hint_count'),
			builder_hint_count_min: perIntent.length
				? Math.min(...perIntent.map((p) => p.metrics.builder_hint_count ?? 0))
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
