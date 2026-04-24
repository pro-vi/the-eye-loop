# Model Architecture — The Eye Loop

Landed runtime: **Anthropic Claude**, role-tiered. Defaults keep a two-tier latency profile — Haiku for scouts/oracle/builder-incremental and Sonnet for reveal — but each role is independently configurable. Images are cut — scouts emit `word` or `mockup` facades only. Source of truth: `src/lib/server/ai.ts`.

---

## Model Roster (landed defaults)

| Binding | Default model ID | Display Name | Role |
|------|----------|-------------|------|
| `SCOUT_MODEL` | `claude-haiku-4-5-20251001` | Haiku 4.5 | Scouts (word + HTML mockup) |
| `ORACLE_MODEL` | `claude-haiku-4-5-20251001` | Haiku 4.5 | Oracle cold-start + synthesis |
| `BUILDER_MODEL` | `claude-haiku-4-5-20251001` | Haiku 4.5 | Builder scaffold + rebuild |
| `REVEAL_MODEL` | `claude-sonnet-4-6` | Sonnet 4.6 | Builder reveal |

Configured by env vars `SCOUT_MODEL_ID`, `ORACLE_MODEL_ID`, `BUILDER_MODEL_ID`, and `REVEAL_MODEL_ID`, then exported from `src/lib/server/ai.ts`. Landed call sites live in the session runtime at `src/lib/server/session/runtime.ts`.

## Tier Responsibilities

### Fast defaults (Haiku 4.5)

Every swipe-cycle path. Must feel responsive.

- **Scout word facade** — single evocative word or 2-3 word phrase via `Output.object()` + Zod schema in the session runtime
- **Scout HTML mockup** — free-form HTML+CSS generation when the scout metadata returns `format: 'mockup'`, parsed out of the text response
- **Oracle synthesis** — every 4 swipes, emits `TasteSynthesis` (emergent axes + scout assignments + divergence)
- **Builder scaffold** — initial draft on session-created, maintains `PrototypeDraft`
- **Builder incremental rebuild** — on swipe-result, integrates accepted/rejected patterns

### Quality default (Sonnet 4.6)

Single call: builder reveal at stage=`reveal`. Exchanges latency for coherence on the final artifact.

## Provider auth

Uses the Claude Code OAuth header path, not the standard Anthropic API key path. `createAnthropic({ apiKey: 'x', headers: { ... } })` is the whole surface.

```env
# .env
CLAUDE_CODE_OAUTH_TOKEN=...   # required; provider call 401s without it
```

```typescript
import { createAnthropic } from '@ai-sdk/anthropic';
import { env } from '$env/dynamic/private';

const anthropic = createAnthropic({
  apiKey: 'x',
  headers: {
    'x-api-key': '',
    Authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN ?? ''}`,
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    'user-agent': 'claude-cli/2.1.2 (external, cli)',
    'x-app': 'cli',
  },
});

export const SCOUT_MODEL = anthropic(env.SCOUT_MODEL_ID ?? 'claude-haiku-4-5-20251001');
export const ORACLE_MODEL = anthropic(env.ORACLE_MODEL_ID ?? 'claude-haiku-4-5-20251001');
export const BUILDER_MODEL = anthropic(env.BUILDER_MODEL_ID ?? 'claude-haiku-4-5-20251001');
export const REVEAL_MODEL = anthropic(env.REVEAL_MODEL_ID ?? 'claude-sonnet-4-6');
```

Missing/invalid token surfaces as `401 Invalid bearer token` at the first provider call and is classified as `provider_auth_failure` by `src/lib/server/provider-errors.ts`.

---

## Temperature Discipline

Matches landed call sites in `src/lib/server/session/runtime.ts`:

| Call site | Temperature | Why |
|-----------|------------|-----|
| Scout probe generation | `1.0` | Creative — diverse taste probes |
| Scout HTML mockup | default | Inherits from `SCOUT_MODEL`, free-form HTML |
| Builder scaffold / rebuild / reveal | `0` | Analytical — integrate evidence deterministically |
| Oracle synthesis / cold-start | `0` | Analytical — emergent-axis inference |

## Fallback plan (landed runtime)

If Haiku 4.5 is flaky or you want to tune latency per role, swap the relevant `*_MODEL_ID` env var without touching the call sites. Typical fallbacks:

| Binding | From | To | Trade-off |
|------|------|-----|-----------|
| `SCOUT_MODEL_ID` / `ORACLE_MODEL_ID` / `BUILDER_MODEL_ID` | `claude-haiku-4-5-20251001` | `claude-sonnet-4-6` | Higher quality, higher latency, higher cost |
| `REVEAL_MODEL_ID` | `claude-sonnet-4-6` | `claude-haiku-4-5-20251001` | Drops reveal coherence for speed |

Provider auth never fails over automatically — every call uses the same `CLAUDE_CODE_OAUTH_TOKEN` via `createAnthropic(...)`.

---

## Appendix: historical Gemini three-tier design

The content below describes the earlier Gemini-era preview runtime (generator = Flash Lite 3.1, renderer = Nano Banana 2, oracle = Pro 3.1) that was superseded by the landed Anthropic two-tier design above. Kept for pattern/benchmark reference only — none of these APIs, models, or code snippets are reachable in the current build.

### Gemini-era roster (superseded)

| Tier | Model ID | Role |
|------|----------|------|
| Generator | `gemini-3.1-flash-lite-preview` | Scout text/HTML, Builder, Compaction |
| Renderer | `gemini-3.1-flash-image-preview` (Nano Banana 2) | Image facade generation |
| Oracle | `gemini-3.1-pro-preview` | Fract detection, stuck detection, quality gate |

### Renderer patterns (Gemini NB2, not in landed runtime)

Patterns validated by nano-banana-2-skill and gemimg projects:

1. Reference images go FIRST in parts array, text prompt LAST — improves style consistency on one-axis sweeps.
2. Style transfer via text prompt alone is unreliable; pass the accepted facade as reference image and instruct only the axis change.
3. Stateless editing is mandatory — multi-turn NB2 fails with `thought_signature` via the AI SDK. Each facade is a fresh `generateText` call with reference image as `type: 'file'` in a single user message.
4. Google Search grounding adds ~7s latency with no quality improvement — skip.
5. Max 3 iterative edits on same reference before rebuilding prompt from scratch — drift accumulates.
6. `Output.object()` + `responseModalities: ['TEXT', 'IMAGE']` compose — NB2 returns both typed metadata and image files in a single call. Without `Output.object()`, raw JSON-in-text parsing is unreliable.
