# Announcement: Emergent Axes Update

**Date:** 2026-03-21
**Affects:** All agents working on oracle, scout, builder, types, context, panels
**Source of truth:** `specs/4-akinator.md` (updated)

---

## What Changed

The oracle synthesis output has been upgraded from flat text (known/unknown/contradictions) to **emergent axes** — structured taste dimensions that the oracle discovers from evidence. Scouts now receive axis assignments and queue visibility for cross-scout coordination.

This was validated across 3 edge case scenarios (normal, contradictory, reject-everything) with 3/3 scout diversity in all cases.

---

## Per-Agent Impact

### Oracle Agent (`src/lib/server/agents/oracle.ts`)

Your synthesis output changes shape. Instead of:
```typescript
{ known: string[], unknown: string[], contradictions: string[], scout_guidance: string, ... }
```

Produce:
```typescript
{
  axes: EmergentAxis[],           // 3-5 discovered taste dimensions
  edge_case_flags: string[],      // "user accepts everything", "axis X contradictory"
  scout_assignments: Array<{      // assign each scout a different axis
    scout: string,
    probe_axis: string,
    reason: string
  }>,
  persona_anima_divergence: string | null
}
```

Where `EmergentAxis` is:
```typescript
{ label, poleA, poleB, confidence: 'unprobed'|'exploring'|'leaning'|'resolved', leaning_toward, evidence_basis }
```

Key rules:
- Discover 3-5 axes from evidence patterns. Don't invent — ground in accepts/rejects.
- Assign each of the 3 scouts to a DIFFERENT axis.
- Flag edge cases: all-reject, all-accept, all-hesitant, contradictory evidence.
- Detect persona-anima divergence.

See `specs/4-akinator.md` "Oracle: Emergent Axes" for the full validated prompt.

---

### Scout Agent (`src/lib/server/agents/scout.ts`)

Your prompt now receives:
1. Evidence history (unchanged)
2. **Emergent axes** from oracle (new — replaces flat synthesis text)
3. **Your axis assignment** (new — "Probe interaction modality because...")
4. **Queue contents** (new — "These probes are already pending: [list]")
5. Format instruction (unchanged)

Key rules:
- Follow your assignment OR pick the most uncertain axis not already queued.
- Do NOT duplicate what's in the queue.
- Output includes `axis_targeted: string` — which emergent axis you probed.

Before the first oracle synthesis (swipes 1-3), you get just intent + evidence. No axes, no assignment. Generate your "first Akinator question" from intent alone.

See `specs/4-akinator.md` "Scout Prompt" for the full template.

---

### Builder Agent (`src/lib/server/agents/builder.ts`)

Your prompt now receives emergent axes instead of flat synthesis. Use them to:
- Know which dimensions are **resolved** (build from these)
- Know which are **exploring** (don't commit yet)
- Know which are **contradictory** (flag as blocking)

Your probe briefs still target specific UI components. Reference emergent axes when explaining what's blocking: "Navigation pattern is 'exploring' — need to know sidebar vs top-bar before I can build the nav component."

---

### Types (`src/lib/context/types.ts`)

Add:
```typescript
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
  scout_assignments: Array<{ scout: string; probe_axis: string; reason: string }>;
  persona_anima_divergence: string | null;
}
```

The `TasteAxis` type is replaced by `EmergentAxis`. Key difference: `EmergentAxis` is oracle output (discovered), not seeded input.

---

### Context (`src/lib/server/context.ts`)

Store the latest `TasteSynthesis` on the context so scouts and builder can read it:
```typescript
synthesis: TasteSynthesis | null = null;
```

Updated by oracle every 4 swipes. Scouts read `context.synthesis?.axes` + `context.synthesis?.scout_assignments`.

---

### Panels (`src/lib/components/AnimaPanel.svelte`)

Show emergent axes, not confidence bars:
- Each axis: label + poles + confidence badge (exploring/leaning/resolved)
- Axes appear and evolve as oracle discovers them
- Persona-anima divergence highlighted when detected
- Edge case flags shown when active

---

## What Didn't Change

- Evidence format (`SwipeEvidence`) — unchanged
- Evidence serialization — unchanged
- Builder probe brief format — unchanged
- Queue buffering (3-5) — unchanged
- Concreteness floor logic — unchanged
- Cold start (3 scouts from intent alone) — unchanged
- Anti-patterns — unchanged
