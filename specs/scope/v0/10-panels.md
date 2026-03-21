# 10 — AnimaPanel + AgentStatus Components

## Summary
Two display-only panel components fed by SSE events. AnimaPanel shows evidence tags and oracle synthesis as emergent axes with confidence badges (unprobed/exploring/leaning/resolved), edge case flags, and persona-anima divergence — not flat text lists, not confidence bars. AgentStatus shows named agents with live status badges. Both in `src/lib/components/`.

## Design
Both components are purely presentational — they receive props and render. No internal data fetching. Parent page manages SSE connection and passes updated data down. Svelte 5 runes for all reactivity. Tailwind + CSS custom properties for styling.

## Scope
### Files
- src/lib/components/AnimaPanel.svelte (~110 LOC)
- src/lib/components/AgentStatus.svelte (~77 LOC)

### Subtasks

## AnimaPanel component
`src/lib/components/AnimaPanel.svelte`.

Props:
- `evidence: SwipeEvidence[]`
- `synthesis: TasteSynthesis | null`
- `antiPatterns: string[]`

Derived state:
- `accepts` — evidence filtered to `decision === 'accept'`
- `rejects` — evidence filtered to `decision === 'reject'`

Renders three sections:

1. **Evidence tags** — a flex-wrap row of small pills, one per `SwipeEvidence`. Each pill shows:
   - `+` for accept, `−` for reject
   - `?` suffix if `latencySignal === 'slow'` (hesitant)
   - The `content` text
   - Green background tint for accepts, red for rejects
   - Below the tags: summary counts ("N accepted", "N rejected")
   - Empty state: "No evidence yet. Start swiping."

2. **Emergent axes** (rendered only when `synthesis` is non-null) — vertical stack of axis rows. Each axis row shows:
   - **Label** — the discovered taste dimension name
   - **Poles** — poleA and poleB at opposite ends
   - **Confidence badge** — colored pill showing confidence level:
     - `unprobed`: gray
     - `exploring`: amber
     - `leaning`: blue (with `leaning_toward` pole highlighted)
     - `resolved`: green (with resolved pole highlighted)
   - **Evidence basis** — small text showing what evidence supports this axis
   - Axes appear and evolve as the oracle discovers them — visually alive.

3. **Edge case flags** (rendered when `synthesis.edge_case_flags.length > 0`) — amber-labeled pills showing each flag (e.g., "user accepts everything", "axis X contradictory").

4. **Persona-anima divergence** (rendered when `synthesis.persona_anima_divergence` is truthy) — red-labeled section with single paragraph highlighting where revealed taste diverges from stated intent.

5. **Anti-patterns** (rendered only when `antiPatterns.length > 0`) — red-labeled section with flex-wrap pills showing each anti-pattern string.

Heading: "Anima". No confidence bars. No flat known/unknown/contradictions text lists.

## AgentStatus component
`src/lib/components/AgentStatus.svelte` (~77 LOC).

Props: `agents: AgentState[]`.

Renders a vertical list of agent entries. Each entry contains:
- **Status dot:** small colored circle (2.5 unit), pulsing animation when `status === 'thinking'`
- **Name:** agent name (e.g., "Iris", "Meridian", "Oracle"), `text-sm font-semibold`
- **Status badge:** colored pill with label text:
  - `thinking`: amber (`#f59e0b`), "Thinking..."
  - `waiting`: blue (`#3b82f6`), "Waiting"
  - `idle`: green (`var(--color-accept)`), "Idle"
  - `queued`: gray (`var(--color-outline)`), "Queued"
- **Focus text:** `agent.focus` shown as `text-xs italic` below the name (e.g., `"generating probe"`, `"queue full"`)
- **Role badge:** right-aligned pill showing `agent.role` (scout/builder/oracle)

Status-to-config mapping uses a `Record<AgentState['status'], { color, label }>` lookup. Empty state: "No agents active."

Heading: "Agents".

### Acceptance criteria
- [ ] AnimaPanel renders evidence tags as accept/reject pills with content text
- [ ] Hesitant swipes (`latencySignal === 'slow'`) show a `?` indicator
- [ ] Accept/reject counts are displayed below the evidence tags
- [ ] Emergent axes render when `synthesis` is non-null — each axis shows label, poles, confidence badge, and evidence basis
- [ ] Confidence badges use distinct colors: unprobed=gray, exploring=amber, leaning=blue, resolved=green
- [ ] Leaning/resolved axes highlight the `leaning_toward` pole
- [ ] Edge case flags render as amber pills when `synthesis.edge_case_flags` is non-empty
- [ ] Persona-anima divergence renders as red-labeled paragraph when truthy
- [ ] No flat known/unknown/contradictions text lists, no confidence bars
- [ ] Anti-patterns render as red-tinted pills when present
- [ ] AgentStatus renders all provided agents by name
- [ ] Status dot color matches status value (thinking=amber, waiting=blue, idle=green, queued=gray)
- [ ] Thinking status dot has `animate-pulse` CSS animation
- [ ] Focus text displays below agent name when present
- [ ] Role badge shows agent role (scout/builder/oracle)
- [ ] Both components use `$props` for inputs and `$derived` for computed values
- [ ] No `on:click` syntax — all event handlers use `onclick` (Svelte 5)
- [ ] No internal data fetching — purely prop-driven

### Dependencies
Depends on 04-endpoints (SSE delivers `evidence-updated`, `synthesis-updated`, and `agent-status` events that the parent page parses and passes as props).

### Estimate
~190 LOC total across both components.
