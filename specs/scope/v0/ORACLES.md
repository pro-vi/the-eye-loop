# V0 Oracle & Skill Guide

> **Akinator pivot active.** For scout prompts, builder prompts, evidence
> format, and Anima panel: follow `specs/4-akinator.md`, NOT `specs/1-prompts.md`
> or the axis-based patterns in scope tickets. TasteAxis is dropped — use
> SwipeEvidence. See CLAUDE.md for full pivot context.

Every tab (CC+Codex pair) runs these checks. Human orchestrates; no Ralph loop.

---

## Oracles (run after every ticket)

```bash
pnpm check          # svelte-check + TypeScript strict
pnpm build          # full build — catches import/export issues
pnpm dev &          # dev server starts without crash (kill after 5s)
```

**Pass = all three exit 0.** If any fails, fix before moving to next ticket.

No test runner in V0. No lint. The oracles are: types compile, build succeeds, server boots.

---

## E2E Verification (agent-browser, no Playwright)

After tickets that change user-facing behavior, verify with `/e2e-test` using agent-browser only.

### Checkpoints (when to run /e2e-test)

| After ticket | What to verify |
|-------------|----------------|
| 04 (endpoints) | `curl POST /api/session` returns axes. `curl GET /api/stream` returns SSE headers. |
| 05 (scout-words) | Session creates → facades appear in SSE stream within 5s |
| 09 (swipe-feed) | Cards render. Swipe right → accept POST fires. Swipe left → reject. |
| 12 (main-page) | Full flow: enter intent → swipe 3 words → Anima panel updates → draft panel shows content |

These are the only 4 checkpoints. Don't run /e2e-test on every ticket — it's slow and most tickets are server-only.

---

## Skills Each Tab Should Know

### Always available (invoke when relevant)

| Skill | When to invoke | What it does |
|-------|---------------|--------------|
| `/svelte` | Writing/editing .svelte files | Checks against Svelte MCP, validates runes usage, catches Svelte 5 mistakes |
| `/vercel-ai-sdk` | Any `generateText`, `Output.object`, `google()` call | Type patterns, provider options, gotchas (responseModalities, no z.union) |
| `/casting` | Before writing `as any`, `as unknown`, `!` assertion | Finds the correct type derivation. Never suppress the compiler. |

### At ticket completion (before moving on)

Run the three oracles. If all pass, commit and move to next ticket.

### NOT used in V0

| Skill | Why skipped |
|-------|-------------|
| `/gate` | Quick fidelity — Codex reviews are sufficient |
| `/code-review` | Codex is doing this per-tab already |
| `/second-opinion` | Only if stuck >15 min on a single issue |
| `/frontend` | Styling pass is ticket 12 / polish phase, not per-ticket |

---

## Per-Ticket Oracle Details

### L0 — Scaffold + Plumbing

**01-scaffold**
```
Oracle: pnpm check && pnpm build && pnpm dev (boots without error)
Skills: none needed — boilerplate
Verify: Vercel deploy succeeds (push + check deploy URL)
```

**02-types**
```
Oracle: pnpm check (types compile, no errors)
Skills: /casting if any type feels wrong
Verify: import { TasteAxis, Facade, ... } from '$lib/context/types' resolves
```

**03-context**
```
Oracle: pnpm check && pnpm build
Skills: /vercel-ai-sdk (for toAnimaYAML pattern if unsure)
Verify: import { context } from '$lib/server/context' resolves in +server.ts files
```

**04-endpoints**
```
Oracle: pnpm check && pnpm build && pnpm dev
Skills: /vercel-ai-sdk (generateText + Output.object for session seed)
Verify: /e2e-test checkpoint — curl the three endpoints
```

### L1 — Agent Loops

**05-scout-words**
```
Oracle: pnpm check && pnpm build && pnpm dev
Skills: /vercel-ai-sdk (generateText, Output.object, temperature), /casting (Zod schema types)
Verify: /e2e-test checkpoint — session creates, SSE shows facade-ready events
```

**06-builder**
```
Oracle: pnpm check && pnpm build
Skills: /vercel-ai-sdk (generateText with temperature:0, Output.object for DraftUpdate)
Verify: After a swipe, draft-updated event appears on SSE stream
```

**07-oracle**
```
Oracle: pnpm check && pnpm build
Skills: none — pure code, no AI SDK
Verify: Queue stays 3-5 during manual swipe testing. Stage advances at correct counts.
```

**08-scout-stages**
```
Oracle: pnpm check && pnpm build && pnpm dev
Skills: /vercel-ai-sdk (responseModalities: ['TEXT', 'IMAGE'] — CRITICAL)
Verify: After swipe 5, image facades appear with base64 data URLs. After swipe 9, HTML facades appear.
```

### L2 — UI

**09-swipe-feed**
```
Oracle: pnpm check && pnpm build
Skills: /svelte (runes, event handlers — onclick not on:click, $state, $props)
Verify: /e2e-test checkpoint — cards render, swipe gestures work, latencyMs captured
```

**10-panels**
```
Oracle: pnpm check && pnpm build
Skills: /svelte (reactive updates from SSE-driven $state)
Verify: AnimaPanel shows bars that change width after swipe. AgentStatus shows thinking/waiting states.
```

**11-draft-reveal**
```
Oracle: pnpm check && pnpm build
Skills: /svelte (iframe srcdoc binding, conditional rendering)
Verify: Draft iframe shows HTML. Reveal mode expands full-width.
```

**12-main-page**
```
Oracle: pnpm check && pnpm build && pnpm dev
Skills: /svelte (EventSource in $effect, state machine), /frontend (final styling pass)
Verify: /e2e-test checkpoint — full demo flow works end-to-end
```

---

## Failure Protocol

**Oracle fails (pnpm check / build):**
→ Read error. Fix. Re-run. Don't move on until green.

**E2E checkpoint fails (/e2e-test with agent-browser):**
→ Check SSE connection, check endpoint responses, check console errors.
→ Most common: missing event emission, wrong event name, facade not in queue.

**Stuck >15 min on one issue:**
→ Invoke `/second-opinion` with the specific error.
→ Or ask tab 3 (this orchestrator tab) for help.

**Gemini returns unexpected output:**
→ Check: did you pass `responseModalities` for images?
→ Check: did you use `z.union()` anywhere? (Gemini rejects it)
→ Check: is the schema flat? No nested optionals.

---

## Demo Contract Oracle (final gate)

Before recording the demo video, all five must be manually verified:

- [ ] User enters intent → first facades appear within 5s
- [ ] Every swipe visibly updates the Anima panel
- [ ] Next facades clearly respond to previous choices (different axis or refined hypothesis)
- [ ] UI shows named agents with changing statuses
- [ ] Prototype draft pane shows evolving HTML before reveal

This is the only human-evaluated gate. Everything else is exit codes.
