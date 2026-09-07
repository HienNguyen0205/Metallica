# Design: Streamed Provider-TTS for SPEAKING (real AnalyserNode)

Date: 2026-09-07. Status: approved §§1–4 in chat, awaiting spec review.

## Context

`WaveformRing` is driven per state through its `getLevel(bin, time)` seam:

- `listening` — real mic via the shared `audioBus` analyser (`readMicLevels`,
  cached once per frame in `FridayCore.getMicLevel`).
- `speaking` — pseudo-envelope from `voice.speakProgress()` (time-based).
- anything else — synthesised motion by design.

Browser `speechSynthesis` output cannot be routed into WebAudio, so a real
analyser for the spoken voice is impossible while keeping it. This design
replaces the TTS source with streamed provider audio and analyses what
actually plays. Decisions locked in chat: source = orchestrator `/tts` (B),
format = raw PCM chunks (B1), fetch = one logical stream played progressively
(one-shot request, playback starts on first chunk — approach B as approved),
fallback = `speechSynthesis` before the first chunk only (§3 two-phase rule).

## §1 — Contract `POST /tts` (owned by the orchestrator repo)

Request: `{ text: string, lang: "vi-VN" | "en-US", session_id?: string }`.
`session_id` reuses the `friday.session` tab id sent to `/query`.

Response: `200` with an opening header frame then PCM chunk frames
(framing bytes per the Open item below):

- header (JSON, first frame): `{ sampleRate: 24000, channels: 1,
  totalSamples?: number }`. `totalSamples` optional — absent means unknown
  length (progress falls back to the current deadline estimate).
- chunks: int16-LE mono PCM at the header rate. `ttsClient` rejects
  short/overlong frames as malformed (fatal to the stream per §3).

Conventions reused from existing endpoints: `429` → `OrchestratorRefused`
(rate-limit), `403` origin refusal, orchestrator CORS allowlist, no fallback
to canned data on refusal (a refusal surfaces; only unreachable/errors fall
back to `speechSynthesis` per §3).

Bandwidth note: 24 kHz mono 16-bit ≈ 384 kbps — acceptable for short spoken
answers; no MP3/MSE path (browser-dependent, unknown duration, harder stubs).

## §2 — Frontend pipeline

New files:

- `src/lib/api/ttsClient.ts` — `POST /tts`, validates the header frame,
  yields PCM chunks as an async iterator (framing per the Open item below),
  throws typed errors (`TtsUnreachable | TtsRefused | TtsMalformed`). Reuses
  `sessionId()` and the `OrchestratorRefused` convention from
  `fridayClient.ts`.
- `src/lib/ttsPlayer.ts` — owns progressive playback: feeds chunks into a
  ring buffer consumed by an `AudioWorklet`, through a **dedicated**
  `AnalyserNode` (shares the `AudioContext` with the mic bus, separate node
  so the two sources never mix), exposes `levels(bars)` via the existing
  `binsToLevels`, `progress()` (played/total or deadline fallback), and
  `stop()`. All non-trivial logic lives here, not in the worklet.
- `public/audio/tts-worklet.js` — deliberately trivial ring-buffer
  passthrough (kept untestable-by-construction; nothing to unit test inside).

Modified files:

- `src/lib/voice.ts` — `speak()` tries the TTS stream first, falls back to
  `speechSynthesis` on any phase-1 failure; `speakProgress()` prefers TTS
  sample progress when active; `stopSpeaking()` aborts fetch + stops the
  player + cancels synthesis. Public signatures unchanged.
- `src/lib/audioBus.ts` — exposes the shared context for the second analyser
  plus `readTtsLevels()` reusing `binsToLevels`; mic lifecycle untouched.
- `src/components/friday/core/FridayCore.tsx` — `getTtsLevel` mirrors the
  `getMicLevel` per-frame cache for `speaking`; `null` → synth fallback as
  today.
- `src/lib/agentStream.ts`, `src/components/friday/hud/InputBar.tsx` —
  **unchanged**. If they need edits, the seam is wrong; stop and re-classify.

## §3 — Errors & fallback (two-phase rule)

- Phase 1 (before first chunk: unreachable, 403/429, bad header, no
  `AudioContext`): full fallback to `speechSynthesis`; ring uses the
  pseudo-envelope exactly as today.
- Phase 2 (mid-playback: dropped stream, corrupt chunk, worklet error): do
  NOT switch voices mid-sentence. Stop playback, keep the answer on screen,
  return to `idle` normally, `log()` a warning. No red `sessionError` — a
  clipped tail is not worth alarming the operator.
- Cancel (ESC / new query / turn abort): single path — abort fetch, stop the
  player, `stopSpeaking()`. No branching on which source was playing.

## §4 — Testing

- Unit `tests/unit/ttsPlayer.spec.ts` (+ `audioBus` extension): header/chunk
  parsing incl. malformed frames, progress math (known/unknown total),
  phase-1 fallback matrix (throw/403/429/malformed → synthesis), phase-2
  quiet stop (corrupt mid-stream → stop, no fallback, answer kept). Fetch and
  the worklet port are faked; the real worklet file is trivial by design.
- UI: `stubOrchestrator.ts` gains `POST /tts` serving a synthetic PCM sine;
  assert SPEAKING waveform pixels differ from the synth baseline, the
  response-flow ordering is unchanged, and LISTENING levels never leak into
  the TTS analyser (and vice versa).
- Explicitly not tested: voice quality, real-network latency, non-Chromium
  browsers (Chromium-only like STT today; missing APIs degrade silently as
  the mic button already does).

## Open item for the backend owner

Exact chunk framing bytes on the wire (proposal: 4-byte LE length prefix per
frame; header is frame zero as JSON). Frontend `ttsClient` implements
whatever is agreed; malformed frames are fatal to the stream (phase-1/2
rules apply by position).
