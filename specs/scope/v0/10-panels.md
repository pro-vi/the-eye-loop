# 10 — AnimaPanel + AgentStatus Components

## Summary
Two display-only panel components fed by SSE events. AnimaPanel shows the evolving taste model as a flat axis list with confidence bars. AgentStatus shows named agents with live status badges. Both in `src/lib/components/`.

## Design
Both components are purely presentational — they receive props and render. No internal data fetching. Parent page manages SSE connection and passes updated data down. Svelte 5 runes for all reactivity. Tailwind for styling.

## Scope
### Files
- src/lib/components/AnimaPanel.svelte
- src/lib/components/AgentStatus.svelte

### Subtasks

## AnimaPanel component
`src/lib/components/AnimaPanel.svelte` (~100-120 LOC).

Props: `axes: TasteAxis[]` (from V0 data contract).

Renders a vertical list of axis rows. Each row contains:
- **Label:** axis label text (e.g., "mood"), left-aligned, `text-sm font-medium`
- **Binary options:** both pole labels shown (e.g., "calm" on left, "energetic" on right), `text-xs text-gray-400`
- **Confidence bar:** outer `div` with `bg-gray-700 rounded-full h-2 w-full`, inner `div` with width set to `{axis.confidence * 100}%` via inline style. Color derived from confidence:
  - `confidence > 0.75` (resolved): `bg-green-500`
  - `0.3 <= confidence <= 0.75` (exploring): `bg-amber-500`
  - `confidence < 0.3` (unprobed): `bg-gray-500`
- **Leaning indicator:** if `axis.leaning` is set, show it as small text below the bar: `text-xs` with an arrow pointing toward the preferred pole

Use `$derived` to compute bar color from confidence thresholds. Use `$props` for the axes input. Wrap in a container with heading "Taste Profile" or "Anima".

## AgentStatus component
`src/lib/components/AgentStatus.svelte` (~80-100 LOC).

Props: `agents: AgentState[]` (from V0 data contract).

Renders a vertical list of agent entries. Each entry contains:
- **Name:** agent name (e.g., "Scout #1", "Builder"), `text-sm font-semibold`
- **Status badge:** small colored indicator with icon/text:
  - `thinking`: amber background, animated spinner (CSS `animate-spin` on a small circle or icon), "Thinking..." text
  - `waiting`: blue background, pause icon or text, "Waiting" text
  - `idle`: green background, checkmark or dot, "Idle" text
  - `queued`: gray background, hourglass or text, "Queued" text
- **Focus text:** `axis.focus` shown as `text-xs text-gray-400 italic` below the name (e.g., "Probing color temperature")

Use `$derived` to map status to badge color and icon. Use `$props` for the agents input. Wrap in a container with heading "Agents".

### Acceptance criteria
- [ ] AnimaPanel renders all provided axes as rows
- [ ] Confidence bar width is proportional to `axis.confidence` (0-1 mapped to 0-100%)
- [ ] Bar color is green when `confidence > 0.75`
- [ ] Bar color is amber when `confidence` is between 0.3 and 0.75
- [ ] Bar color is gray when `confidence < 0.3`
- [ ] Both binary option labels (poles) are visible per axis
- [ ] Leaning text updates and displays correctly after a swipe changes `axis.leaning`
- [ ] AgentStatus renders all provided agents by name
- [ ] Status badge shows correct color per status value (thinking=amber, waiting=blue, idle=green, queued=gray)
- [ ] Thinking status badge has an animated spinner (CSS animation, not JS interval)
- [ ] Focus text displays below agent name when present
- [ ] Both components use `$props` for inputs and `$derived` for computed values
- [ ] No `on:click` syntax — all event handlers use `onclick` (Svelte 5)
- [ ] No internal data fetching — purely prop-driven

### Dependencies
Depends on 04-endpoints (SSE delivers `anima-updated` and `agent-status` events that the parent page parses and passes as props).

### Estimate
~180-220 LOC total across both components.
