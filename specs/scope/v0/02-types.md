# 02 — V0 Data Contract Types

## Summary
Define all shared TypeScript types for the V0 data model. These types are the single source of truth for evidence, facades, swipe records, agent state, the prototype draft, probe briefs, emergent axes, taste synthesis, and SSE event payloads. Every other module imports from this file. ~110 LOC.

## Design
One file, zero runtime dependencies. All types are plain interfaces and string literal unions — no classes, no Zod at the type layer (Zod schemas live at validation boundaries in endpoints, not here). No z.union() anywhere — Gemini uses an OpenAPI 3.0 subset that does not support it. Evidence-based model — no TasteAxis, no coded confidence scores, no axis IDs. Oracle discovers `EmergentAxis` dimensions from evidence; `TasteSynthesis` carries axes, edge case flags, scout assignments, and persona-anima divergence. SSE event types are a discriminated union on a `type` string field, with a compile-time `SSEEventMap` derived from the union.

## Scope
### Files
- src/lib/context/types.ts

### Subtasks

## Define core domain types
All types from the V0 evidence-based data contract:

```ts
type Stage = 'words' | 'images' | 'mockups' | 'reveal';

interface SwipeEvidence {
  facadeId: string;
  content: string;
  hypothesis: string;
  decision: 'accept' | 'reject';
  latencySignal: 'fast' | 'slow';
}

interface Facade {
  id: string;
  agentId: string;
  hypothesis: string;
  label: string;
  content: string;
  format: 'word' | 'image' | 'mockup';
  imageDataUrl?: string;
}

interface SwipeRecord {
  facadeId: string;
  agentId: string;
  decision: 'accept' | 'reject';
  latencyMs: number;
  latencyBucket?: 'fast' | 'slow';
}

interface AgentState {
  id: string;
  name: string;
  role: 'scout' | 'builder' | 'oracle';
  status: 'idle' | 'thinking' | 'queued' | 'waiting';
  focus: string;
  lastFacadeId?: string;
}

interface PrototypeDraft {
  title: string;
  summary: string;
  html: string;
  acceptedPatterns: string[];
  rejectedPatterns: string[];
  nextHint?: string;
}

interface ProbeBrief {
  source: string;
  priority: 'high' | 'normal';
  brief: string;
  context: string;
  heldConstant: string[];
}

interface EmergentAxis {
  label: string;
  poleA: string;
  poleB: string;
  confidence: 'unprobed' | 'exploring' | 'leaning' | 'resolved';
  leaning_toward: string | null;
  evidence_basis: string;
}

interface TasteSynthesis {
  axes: EmergentAxis[];
  edge_case_flags: string[];
  scout_assignments: Array<{
    scout: string;
    probe_axis: string;
    reason: string;
  }>;
  persona_anima_divergence: string | null;
}
```

## Define SSE event types
Discriminated union on `type` field. Each event carries only the data the client needs to render the update:

```ts
type SSEEvent =
  | { type: 'facade-ready'; facade: Facade }
  | { type: 'facade-stale'; facadeId: string }
  | { type: 'swipe-result'; record: SwipeRecord }
  | { type: 'evidence-updated'; evidence: SwipeEvidence[]; antiPatterns: string[] }
  | { type: 'agent-status'; agent: AgentState }
  | { type: 'draft-updated'; draft: PrototypeDraft }
  | { type: 'builder-hint'; hint: string }
  | { type: 'stage-changed'; stage: Stage; swipeCount: number }
  | { type: 'synthesis-updated'; synthesis: TasteSynthesis }
  | { type: 'session-ready'; intent: string }
  | { type: 'error'; message: string }
```

## Derive SSEEventMap and helpers
Compile-time `SSEEventMap` type derived from the `SSEEvent` union so the bus and SSE forwarding stay aligned automatically:

```ts
type SSEEventByType<T extends SSEEvent['type']> = Extract<SSEEvent, { type: T }>;
type SSEEventMap = { [E in SSEEvent as E['type']]: Omit<E, 'type'> };
type SSEEventType = SSEEvent['type'];
```

## Export all types
Named exports only. No default export. No runtime code — pure type declarations plus the Stage, SSEEvent, SSEEventMap, and SSEEventType type aliases.

### Acceptance criteria
- [ ] `src/lib/context/types.ts` compiles with `tsc --noEmit` and zero errors
- [ ] No `z.union()` anywhere in the file
- [ ] No `TasteAxis` type — evidence-based model uses `SwipeEvidence` + `EmergentAxis` instead
- [ ] No `axisId` field on any type
- [ ] `Stage` type has exactly four members: words, images, mockups, reveal
- [ ] `Facade` has `format: 'word' | 'image' | 'mockup'` and `label: string` (no `stage` or `axisId`)
- [ ] `SwipeRecord` has no `axisId` field
- [ ] `SwipeRecord.decision` is `'accept' | 'reject'`, not boolean
- [ ] `AgentState.role` is `'scout' | 'builder' | 'oracle'`
- [ ] `SSEEvent` is a discriminated union on the `type` field with 11 event kinds
- [ ] `SSEEvent` includes `evidence-updated` (not `anima-updated`) carrying `evidence: SwipeEvidence[]` and `antiPatterns: string[]`
- [ ] `SSEEvent` includes `synthesis-updated` carrying `synthesis: TasteSynthesis`
- [ ] `session-ready` event carries only `intent: string` (no axes)
- [ ] `swipe-result` event carries only `record: SwipeRecord` (no axisUpdate)
- [ ] `EmergentAxis` has `label`, `poleA`, `poleB`, `confidence` ('unprobed'|'exploring'|'leaning'|'resolved'), `leaning_toward`, `evidence_basis` fields
- [ ] `TasteSynthesis` has `axes: EmergentAxis[]`, `edge_case_flags: string[]`, `scout_assignments: Array<{scout, probe_axis, reason}>`, `persona_anima_divergence: string | null`
- [ ] `ProbeBrief` has `source`, `priority`, `brief`, `context`, and `heldConstant` fields
- [ ] `SSEEventMap` is derived from `SSEEvent` union at compile time
- [ ] File has zero runtime imports — only type/interface declarations
- [ ] File is under 120 LOC

### Dependencies
- 01-scaffold (TypeScript must be configured)
