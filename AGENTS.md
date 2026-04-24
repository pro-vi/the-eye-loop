# The Eye Loop — Agent Bootstrap

This file is intentionally thin. It points to the real contracts instead of
duplicating them.

## Read Order

1. `specs/2-v0-spec.md` — today's shipping contract. Start here.
2. `specs/1-prompts.md` — scout/builder/oracle prompts, evidence serialization,
   output shapes.
3. `specs/0-spec.md` — full system design, upgraded contracts, traceability.
4. `specs/hackathon-guide.md` — rules, judging, deadline.
5. `research/*.md` — topic references when you need theory or rationale.
6. `.research/*.md` — verified runtime / SDK / prompt / library findings.

## Doc Roles

- `specs/2-v0-spec.md`: smallest version that must work live.
- `specs/1-prompts.md`: source of truth for prompt patterns and evidence
  serialization format.
- `specs/0-spec.md`: source of truth for architecture, data model,
  observation model, BALD/fracting contract.
- `research/active-preference-learning.md`: BALD, frontier score, spawning
  logic.
- `research/observation-model.md`: RT, confidence, JND, exposure drift.
- `research/fracting.md`: child-axis discovery, branch gating, compaction.
- `research/negative-selection.md`: anti-patterns, repulsion model.
- `research/generative-ui.md`: dispersion, structured UI variation.
- `research/iec-fatigue.md`: swipe budget, stage/depth limits.
- `research/prior-systems.md`: prior art and product framing.

## Precedence

- For what to ship today: `specs/2-v0-spec.md`
- For prompt shapes and agent outputs: `specs/1-prompts.md`
- For full architecture and data model: `specs/0-spec.md`
- For formulas, warnings, and rationale: `research/*.md`
- For SDK/runtime verification: `.research/*.md`

If theory and V0 conflict, do not silently raise scope. Prefer the V0 cut line
unless explicitly asked to implement the higher-ambition version.

## Non-Negotiables

- Hackathon mode: ship the demo path first.
- No unnecessary dependencies.
- Svelte 5 runes only.
- Vercel AI SDK 6 + Anthropic Claude (Haiku 4.5 fast, Sonnet 4.6 quality) via `generateText`, reached through the Claude Code OAuth header path (`src/lib/server/ai.ts`, `CLAUDE_CODE_OAUTH_TOKEN`).
- `EyeLoopContext` is the shared server-side state surface.
- Scouts are manual async loops per swipe, not one long autonomous loop.
- Evidence goes into prompts via `context.toEvidencePrompt()`. No axes, no YAML distributions.
- Anti-patterns from rejects are hard constraints.
- No auth, database, caching, or tests unless asked.
- Do not commit secrets; use env vars.
- Read an existing file before changing it.

## Implementation Default

- Build the V0 loop first:
  `intent -> first facades -> swipe -> posterior update -> next facades ->
  visible draft`
- Keep theory-backed fields in types if cheap, but do not block on full
  fracting/BALD.
- Evidence-based Akinator pattern (specs/4-akinator.md). No axis management code.
  LLMs navigate taste hyperspace implicitly from raw evidence.
- When choosing where to spend time, optimize in this order:
  1. swipe responsiveness
  2. visible Anima updates
  3. coherent next-facade adaptation
  4. evolving draft pane

## Verified Reference Notes

- `.research/synthesis-sdk-verified-2026-03-21.md` — current AI SDK/model
  surface.
- `.research/synthesis-runtime-2026-03-21.md` — runtime and deployment notes.
- `.research/synthesis-prompt-patterns-2026-03-21.md` — prompt-system
  findings.
- `.research/synthesis-external-libs-2026-03-21.md` — package/model/library
  decisions.
