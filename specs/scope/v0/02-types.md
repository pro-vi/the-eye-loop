# 02 — V0 Data Contract Types

## Summary
Define all shared TypeScript types for the V0 data model. These types are the single source of truth for facades, swipe records, agent state, the prototype draft, probe briefs, and SSE event payloads. Every other module imports from this file. ~180 LOC.

## Design
One file, zero runtime dependencies. All types are plain interfaces and string literal unions — no classes, no Zod at the type layer (Zod schemas live at validation boundaries in endpoints, not here). No z.union() anywhere — Gemini uses an OpenAPI 3.0 subset that does not support it. Fields match the V0 spec data contract exactly. SSE event types are a discriminated union on a `type` string field.

## Scope
### Files
- src/lib/context/types.ts

### Subtasks

## Define core domain types
All types from the V0 spec data contract:

```ts
type Stage = 'words' | 'images' | 'mockups' | 'reveal';

interface TasteAxis {
  id: string;
  label: string;
  options: [string, string];       // binary poles, e.g. ["calm", "energetic"]
  confidence: number;              // 0-1, lowest = most uncertain = probe next
  leaning?: string;                // which pole is currently favored
  evidenceCount: number;
}

interface Facade {
  id: string;
  agentId: string;
  stage: Stage;
  hypothesis: string;
  axisId: string;
  content: string;                 // text | base64 data URL | HTML string
  imageDataUrl?: string;           // set for image-stage facades
}

interface SwipeRecord {
  facadeId: string;
  agentId: string;
  axisId: string;
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
  rejectedPatterns: string[];      // PROHIBITIONS — more reliable than positive mandates
  nextHint?: string;               // builder's "what I need to know next"
}

interface ProbeBrief {
  source: string;                  // 'builder' | agent id
  priority: 'high' | 'normal';
  brief: string;                   // construction-grounded question
  context: string;                 // what's being built, what's resolved
  heldConstant: string[];          // locked resolved dimensions
}
```

## Define SSE event types
Discriminated union on `type` field. Each event carries only the data the client needs to render the update:

```ts
type SSEEvent =
  | { type: 'facade-ready'; facade: Facade }
  | { type: 'facade-stale'; facadeId: string }
  | { type: 'swipe-result'; record: SwipeRecord; axisUpdate: TasteAxis }
  | { type: 'anima-updated'; axes: TasteAxis[]; antiPatterns: string[] }
  | { type: 'agent-status'; agent: AgentState }
  | { type: 'draft-updated'; draft: PrototypeDraft }
  | { type: 'builder-hint'; hint: string }
  | { type: 'stage-changed'; stage: Stage; swipeCount: number }
  | { type: 'session-ready'; intent: string; axes: TasteAxis[] }
  | { type: 'error'; message: string }
```

## Export all types
Named exports only. No default export. No runtime code — pure type declarations plus the Stage and SSEEvent type aliases.

### Acceptance criteria
- [ ] `src/lib/context/types.ts` compiles with `tsc --noEmit` and zero errors
- [ ] No `z.union()` anywhere in the file
- [ ] Every field from the V0 spec data contract (specs/2-v0-spec.md §Data Contract) is present
- [ ] `Stage` type has exactly four members: words, images, mockups, reveal
- [ ] `SwipeRecord.decision` is `'accept' | 'reject'`, not boolean
- [ ] `AgentState.role` is `'scout' | 'builder' | 'oracle'`
- [ ] `SSEEvent` is a discriminated union on the `type` field with at least 7 event kinds
- [ ] `ProbeBrief` has `source`, `priority`, `brief`, `context`, and `heldConstant` fields
- [ ] File has zero runtime imports — only type/interface declarations
- [ ] File is under 200 LOC

### Dependencies
- 01-scaffold (TypeScript must be configured)
