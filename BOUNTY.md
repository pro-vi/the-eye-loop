# Bounty Board — The Eye Loop

Active issues from debug log analysis (2026-03-21 22:37-22:57).

---

## B1: Scout Repetition (HIGH)

**Symptom:** Same labels repeat 2-4 times per session. "High-contrast neon" ×3, "Playful illustrations" ×3, "Floating action buttons" ×3, "Supportive coach" ×4.

**Root cause:** Queue dedup check and staggered starts are specced (`specs/4-akinator.md`) but not implemented in `scout.ts`.

**Fix:**

1. **Queue dedup** — before `context.pushFacade()`, check for axis overlap:
```typescript
const isDuplicate = context.facades.some(f =>
  f.label.toLowerCase() === output.label.toLowerCase() ||
  f.hypothesis.toLowerCase().includes(output.axis_targeted.toLowerCase())
);
if (isDuplicate) continue;
```

2. **Staggered starts** — in `startAllScouts()`:
```typescript
startScout('scout-01', 'Iris');
setTimeout(() => startScout('scout-02', 'Prism'), 500);
setTimeout(() => startScout('scout-03', 'Lumen'), 1000);
```

**File:** `src/lib/server/agents/scout.ts`
**Verify:** Run session, check `debug.jsonl` — zero duplicate labels.

---

## B2: 45% Timeout Rate (HIGH)

**Symptom:** 37 of 82 facades timed out. User can't swipe fast enough, or facades generate faster than user processes them.

**Diagnosis needed:** Is this scout-side (over-producing) or client-side (swipe UI lag)?

Check:
- What's `SWIPE_TIMEOUT_MS` set to? If 30s, that's generous — timeouts mean user literally isn't swiping
- Is the queue exceeding 5? Scouts should pause at `queuePressure === 'full'`
- Are stale facades being counted as timeouts?
- Is the swipe UI blocking on something (image load, SSE reconnect)?

**File:** `src/lib/server/agents/scout.ts` (timeout), `src/lib/components/SwipeFeed.svelte` (client)
**Verify:** Timeout rate < 15% in a 12-swipe session.

---

## B3: Image Facades Missing Actual Images (MEDIUM)

**Symptom:** 9 image-format facades in the log, unclear if any have `imageDataUrl`. Previous analysis showed 0 actual images.

**Diagnosis needed:** Check if the rendering pipeline (ticket 08) is working:
- Does `scout.ts` call NB2 after generating an image probe?
- Is `facade.imageDataUrl` populated?
- Does the client render `<img src={facade.imageDataUrl}>` for image facades?

**File:** `src/lib/server/agents/scout.ts` (rendering branch), `src/lib/components/SwipeFeed.svelte` (img rendering)
**Verify:** Image facade in debug log has `imageDataUrl` with base64 data. Client shows actual image.

---

## B4: Word-Stage Lock-in (MEDIUM)

**Symptom:** Sessions 2-5 produced 48 consecutive word facades (facades 27-74). Floor thresholds say `<5 = word, 5-9 = image, 10+ = mockup` — but with 45% timeouts, real evidence count stays low.

**Root cause:** Floor is based on `context.evidence.length`, which only increments on real swipes (accept/reject). Timeouts and stales don't count. So the scout generates 20 facades but only 5 get swiped → floor stays at `word`.

**Fix options:**
1. Count total facades generated, not just swiped
2. Lower the floor thresholds: `<3 = word, 3-6 = image, 7+ = mockup`
3. Use `context.swipeCount` (which includes all outcomes) instead of `context.evidence.length`

**File:** `src/lib/server/agents/scout.ts` (`getFormatInstruction`), `src/lib/server/agents/oracle.ts` (`checkFloor`)
**Verify:** Image facades appear by swipe 4-5, mockups by swipe 8-9.

---

## B5: Cold-Start Intent Analysis Not Implemented (LOW)

**Symptom:** `cold-start` event appears once in log but sessions 2-5 don't show it. The oracle cold-start LLM call (`specs/4-akinator.md`) is specced but may not be implemented.

**Check:** Is `seedSession()` in `oracle.ts` making the cold-start LLM call, or is it still pure code?

**File:** `src/lib/server/agents/oracle.ts`
**Spec:** `specs/4-akinator.md` "Cold Start — Oracle Intent Analysis" + `specs/ANNOUNCEMENT-cold-start.md`

---

## Done (from this session)

- [x] Scout labels grounded — "app store caption, not art exhibition title" (`ce1dfc1`)
- [x] Builder HTML quality rules from v0/Lovable/Bolt research (`287db23`)
- [x] Scout lenses specced — Iris=visual, Prism=structure, Lumen=narrative
- [x] Image rendering pipeline specced in ticket 08 (`fa718a4`)
- [x] Oracle cold-start specced (`8177c78`)

---

## Debug Log Reference

```
debug.jsonl — 2026-03-21 22:37-22:57
5 sessions, 82 facades, 32 real swipes
Formats: 54w 9i 19m
Outcomes: 18 reject, 14 accept, 37 timeout, 4 stale, 9 aborted
```
