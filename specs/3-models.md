# Model Architecture — The Eye Loop

Landed runtime: **Anthropic Claude**, two-tier. Fast tier for scouts/builder-incremental/oracle; quality tier reserved for builder reveal. Images are cut — scouts emit `word` or `mockup` facades only. Source of truth: `src/lib/server/ai.ts`.

---

## Model Roster (landed)

| Tier | Model ID | Display Name | Role |
|------|----------|-------------|------|
| Fast | `claude-haiku-4-5-20251001` | Haiku 4.5 | Scouts (word + HTML mockup), Oracle synthesis, Builder scaffold/rebuild |
| Quality | `claude-sonnet-4-6` | Sonnet 4.6 | Builder reveal |

Exported as `FAST_MODEL` and `QUALITY_MODEL` from `src/lib/server/ai.ts`. Call sites live in `src/lib/server/agents/{scout,builder,oracle}.ts`.

## Tier Responsibilities

### Fast (Haiku 4.5)

Every swipe-cycle path. Must feel responsive.

- **Scout word facade** — single evocative word or 2-3 word phrase via `Output.object()` + Zod schema (`ScoutOutputSchema` in `scout.ts`)
- **Scout HTML mockup** — free-form HTML+CSS generation when the scout metadata returns `format: 'mockup'`, parsed out of the text response
- **Oracle synthesis** — every 4 swipes, emits `TasteSynthesis` (emergent axes + scout assignments + divergence)
- **Builder scaffold** — initial draft on session-created, maintains `PrototypeDraft`
- **Builder incremental rebuild** — on swipe-result, integrates accepted/rejected patterns

### Quality (Sonnet 4.6)

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

export const FAST_MODEL = anthropic('claude-haiku-4-5-20251001');
export const QUALITY_MODEL = anthropic('claude-sonnet-4-6');
```

Missing/invalid token surfaces as `401 Invalid bearer token` at the first provider call and is classified as `provider_auth_failure` on the bus (`src/lib/server/bus.ts:classifyErrorCode`).

---

## Temperature Discipline

Matches landed call sites in `src/lib/server/agents/{scout,builder,oracle}.ts`:

| Call site | Temperature | Why |
|-----------|------------|-----|
| Scout probe generation | `1.0` | Creative — diverse taste probes |
| Scout HTML mockup | default | Inherits from `FAST_MODEL`, free-form HTML |
| Builder scaffold / rebuild / reveal | `0` | Analytical — integrate evidence deterministically |
| Oracle synthesis / cold-start | `0` | Analytical — emergent-axis inference |

## Fallback plan (landed runtime)

If Haiku 4.5 is flaky or rate-limited, swap `FAST_MODEL` in `src/lib/server/ai.ts` to another Claude SKU. One edit, propagates to every agent. Typical fallbacks:

| From | To | Trade-off |
|------|-----|-----------|
| `claude-haiku-4-5-20251001` | `claude-sonnet-4-6` | Higher quality, higher latency, higher cost |
| `claude-sonnet-4-6` (reveal) | `claude-haiku-4-5-20251001` | Drops reveal coherence for speed |

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
