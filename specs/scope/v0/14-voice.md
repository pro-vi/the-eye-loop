# 14 — Voice Mode: Hands-Free Taste Discovery

## Summary

Voice-optional interaction layer. The system SPEAKS each facade's hypothesis via ElevenLabs TTS. The user RESPONDS verbally ("yes", "no", hesitates). The hesitation gap IS the latency signal. Swipe always works underneath — voice is additive, not replacement. Toggle on/off via mic button.

Uses hackathon sponsor credits (ElevenLabs Creator tier, 1-month free).

---

## The Demo Moment

The presenter walks up, types an intent, taps the mic icon. The system starts speaking:

> "What about a dense, dashboard-style layout?"

The presenter says "no" while facing the audience. The Anima updates. The system speaks again:

> "How about something minimal — just the key metrics, lots of breathing room?"

"Yes."

> "Warm tones, like sunset, or cool and clinical?"

"Warm. Definitely warm."

The prototype assembles in the background. The presenter never looks at the screen. Judges hear the conversation across the room.

**This is the only demo in the room where you talk to it.**

---

## Architecture

```
                    ┌──────────────┐
                    │   Browser    │
                    │              │
  ElevenLabs TTS ──►  <audio>     │  speaks hypothesis
                    │              │
  SpeechRecognition◄──  mic       │  captures yes/no/hesitation
                    │              │
                    │  latencyMs = │  time from TTS end
                    │  speech start│  to recognition result
                    └──────┬───────┘
                           │ POST /api/swipe
                           │ (same endpoint, same payload)
                           ▼
                    ┌──────────────┐
                    │   Server     │  unchanged — voice is
                    │              │  a client-side input
                    │  (no changes)│  method, not a new
                    └──────────────┘  server feature
```

**Zero server changes.** Voice mode lives entirely in the client. It produces the same `{ facadeId, decision, latencyMs }` POST that swipe does. The server can't tell the difference.

---

## Components

### 14a — ElevenLabs TTS (speak hypotheses)

**Package:** `@elevenlabs/client` (browser SDK)

**Flow:**
1. New facade arrives via SSE (`facade-ready`)
2. If voice mode is ON: call ElevenLabs TTS with the facade's hypothesis text
3. Play audio through browser `<audio>` element
4. Record `ttsEndTime = performance.now()` when audio playback ends
5. Facade card still renders visually (for reference, not for swiping)

**Implementation:**

```typescript
import { ElevenLabsClient } from '@elevenlabs/client';

const XI_API_KEY = '...'; // from env or hardcoded for hackathon (client-side, not secret — uses public API key)

const tts = new ElevenLabsClient({ apiKey: XI_API_KEY });

async function speakHypothesis(text: string): Promise<void> {
  const audio = await tts.textToSpeech.convert('JBFqnCBsd6RMkjVDRZzb', {
    text,
    model_id: 'eleven_turbo_v2_5',  // fastest model, ~300ms TTFB
  });

  // Convert to blob URL and play
  const blob = new Blob([audio], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const player = new Audio(url);

  return new Promise((resolve) => {
    player.onended = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    player.play();
  });
}
```

**Voice selection:** Use a calm, measured voice for the system persona. ElevenLabs pre-made voices:
- `JBFqnCBsd6RMkjVDRZzb` — "Rachel" (neutral, professional)
- Or generate a custom voice from a 30-second sample if time permits

**Model:** `eleven_turbo_v2_5` — fastest available, ~300ms TTFB for streaming. For a hackathon, non-streaming `convert()` is simpler (~500ms total for short phrases).

### 14b — Web Speech API (listen for response)

**No package needed.** Built into Chrome/Edge. Zero dependencies.

**Flow:**
1. After TTS finishes playing, start SpeechRecognition
2. Record `listeningStartTime = performance.now()`
3. User says something — recognition fires `onresult`
4. Parse the transcript into a decision:
   - "yes" / "yeah" / "that" / "love it" / "accept" → `accept`
   - "no" / "nah" / "pass" / "next" / "reject" → `reject`
   - silence (3s timeout) → treat as `reject` with `slow` latency (hesitation = near boundary)
5. `latencyMs = performance.now() - listeningStartTime`
6. POST to `/api/swipe` with `{ facadeId, decision, latencyMs }`

**Implementation:**

```typescript
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function listenForDecision(timeoutMs = 5000): Promise<{ decision: 'accept' | 'reject'; latencyMs: number }> {
  return new Promise((resolve) => {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;  // single utterance
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    const startTime = performance.now();
    let settled = false;

    const settle = (decision: 'accept' | 'reject') => {
      if (settled) return;
      settled = true;
      recognition.stop();
      clearTimeout(timer);
      resolve({ decision, latencyMs: performance.now() - startTime });
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript.toLowerCase().trim();
      const isAccept = /^(yes|yeah|yep|yup|sure|ok|love|like|that|accept|good|nice|cool|want)/.test(transcript);
      settle(isAccept ? 'accept' : 'reject');
    };

    recognition.onerror = () => settle('reject');  // mic error = skip
    recognition.onend = () => { if (!settled) settle('reject'); };  // no speech detected

    const timer = setTimeout(() => settle('reject'), timeoutMs);  // silence = hesitant reject

    recognition.start();
  });
}
```

**Keyword mapping:**

| Words | Decision | Signal |
|-------|----------|--------|
| yes, yeah, yep, sure, ok, love, like, want, that, cool, nice, good | `accept` | Positive |
| no, nah, nope, pass, next, reject, hate, ugly, wrong, bad | `reject` | Negative |
| (silence > 3s) | `reject` | Hesitant — slow latency = near boundary |
| (unintelligible) | `reject` | Uncertain — treat as weak reject |

The keyword list doesn't need to be exhaustive. The SpeechRecognition API gives us the raw transcript — we just check if the first word is positive or negative. Ambiguous defaults to reject (safer — shows the user something new).

### 14c — Voice Mode Toggle + Coordination

**UI:** Mic button in the swipe feed header. Toggles `voiceMode` state.

```svelte
<button
  onclick={() => voiceMode = !voiceMode}
  class="rounded-full p-2 {voiceMode ? 'bg-green-500' : 'bg-zinc-700'}"
  aria-label={voiceMode ? 'Disable voice mode' : 'Enable voice mode'}
>
  {voiceMode ? '🎙️' : '🔇'}
</button>
```

**Coordination flow (voice ON):**

```
facade-ready SSE event
  │
  ├─ render card visually (always)
  │
  ├─ if voiceMode:
  │   ├─ speakHypothesis(facade.hypothesis)
  │   ├─ wait for TTS to finish playing
  │   ├─ listenForDecision(5000)
  │   ├─ POST /api/swipe with result
  │   └─ next facade auto-advances (no manual swipe needed)
  │
  └─ if !voiceMode:
      └─ wait for swipe gesture (existing behavior)
```

**When voice is ON, the swipe feed auto-advances.** The user doesn't need to touch anything. The system speaks → listens → decides → next. The cards still render and animate (swipe-right for accept, swipe-left for reject) but the gesture is triggered by voice, not touch.

**Swipe gesture still works in voice mode** — if the user swipes before speaking, the swipe takes priority and cancels the voice listener.

---

## Latency Model (Voice vs Swipe)

| Mode | Latency captures | What it means |
|------|-----------------|---------------|
| Swipe | Card appear → swipe gesture | Visual reaction time |
| Voice | TTS end → speech recognition result | Verbal reaction time |
| Voice (silence) | TTS end → 3s timeout | Hesitation = near boundary |

Both produce the same `latencyMs` field. The server doesn't know or care which input method was used. The observation model (fast/slow bucket) works identically.

**Voice latency is actually BETTER signal than swipe latency.** The user's voice reveals more:
- Instant "yes!" = strong accept, low boundary proximity
- "hmm... yeah" = hesitant accept, near boundary
- Long pause then "no" = considered reject, near boundary
- Instant "no" = strong reject, far from boundary

The latency + the hesitation pattern in speech maps more naturally to the DDM model than a binary swipe gesture.

---

## API Key Handling

ElevenLabs API key must be accessible client-side (TTS runs in browser). Two options:

**Option A (hackathon speed):** Proxy through server endpoint.
```
POST /api/tts { text: string }
→ server calls ElevenLabs with server-side API key
→ returns audio bytes
```
Adds ~100ms latency but keeps the key server-side.

**Option B (fastest):** Expose a restricted ElevenLabs API key via `PUBLIC_` env var. ElevenLabs keys can be scoped to TTS-only with usage caps. For a demo, this is fine.

**Recommended:** Option A. ~15 lines of server code. Key stays safe.

---

## Files

| File | Action | ~LOC |
|------|--------|------|
| `src/routes/api/tts/+server.ts` | Create | ~30 (proxy endpoint) |
| `src/lib/components/VoiceMode.svelte` | Create | ~80 (TTS + recognition + toggle) |
| `src/lib/components/SwipeFeed.svelte` | Edit | +15 (voice mode integration) |
| `src/routes/+page.svelte` | Edit | +5 (voice mode state + toggle) |
| `package.json` | Edit | +1 dep (`elevenlabs`) |

---

## Dependencies

```bash
pnpm add elevenlabs
```

```
ELEVENLABS_API_KEY=   # from hackathon sponsor credits
```

---

## Failure Plan

| Failure | Mitigation |
|---------|-----------|
| Noisy room, recognition fails | Swipe always works. Voice is additive. |
| ElevenLabs API down | Disable voice toggle. Show toast "Voice unavailable." |
| Browser doesn't support SpeechRecognition | Detect on mount. Hide mic button if unsupported. |
| TTS latency too high (> 2s) | Use `eleven_turbo_v2_5`. If still slow, speak only the label, not full hypothesis. |
| User speaks before TTS finishes | Cancel TTS playback, accept the early response. Latency = time from card render. |
| Demo presenter forgets to enable | Default OFF. One tap to enable. Can be pre-enabled before demo. |

---

## Acceptance Criteria

- [ ] Mic toggle button visible in swipe feed header
- [ ] When voice ON: system speaks each facade's hypothesis via ElevenLabs
- [ ] When voice ON: "yes" / "no" spoken words produce accept / reject decisions
- [ ] When voice ON: silence > 3s produces a reject with slow latency
- [ ] Latency measured from TTS playback end to recognition result
- [ ] Swipe gesture still works in voice mode (takes priority over voice)
- [ ] POST to `/api/swipe` is identical regardless of input method
- [ ] ElevenLabs API key stays server-side (proxy endpoint)
- [ ] If SpeechRecognition unavailable, mic button is hidden
- [ ] Voice mode can be toggled mid-session without breaking state

---

## Anchors

**Hackathon sponsor:** ElevenLabs Creator tier ($22/person, free for participants). Using a sponsor's product signals engagement.

**Multi-modal (Statement Two):** The hackathon has three problem statements. We're building Statement Three (AI Applications). Voice adds a Statement Two dimension (multi-modal agents) without changing our core submission. Judges may note the crossover.

**Research anchor:** `research/observation-model.md` — RT reflects decision difficulty under drift-diffusion. Voice hesitation ("hmm... yeah") is a richer signal than binary swipe timing. The pause duration, the hedging words, the vocal confidence — all encoded in the latency gap between TTS end and recognition result.

**Research anchor:** `research/iec-fatigue.md` — "Reserve human attention for directional commits and boundary decisions." Voice frees the user's hands and eyes. They can look at the Anima panel or the prototype draft while responding verbally. Less cognitive load per swipe = more swipes before fatigue.

**Demo contract #1:** "User enters intent and gets first facades quickly." Voice mode makes this visceral — the system immediately starts talking to you.

**Demo contract #4:** "UI shows named agents working." When the system speaks, it IS a named agent (the scout) presenting its probe. The voice gives the agent a physical presence.

---

## Timing

~45 min total:
- 14a TTS proxy + playback: ~15 min
- 14b SpeechRecognition: ~15 min
- 14c Toggle + coordination: ~15 min

Can cut to just 14a (narration only, no voice input) in ~15 min if time is tight. TTS narration alone is still a demo differentiator.
