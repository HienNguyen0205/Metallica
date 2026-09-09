/**
 * §12/§13 — voice, on the browser's own engines.
 *
 * No Whisper, no Deepgram, no ElevenLabs: Chrome and Edge ship both halves of
 * this already, which means no key, no cost, no extra backend hop and no
 * provider account. The trade is real and worth stating — `SpeechRecognition`
 * exists only in Chromium browsers, and its implementation streams the audio to
 * Google's servers. That is the same boundary the answers already cross on the
 * way to Gemini, so it adds no new one, but it is not local processing.
 *
 * Swapping in a hosted STT later means replacing `startListening` and nothing
 * else; the callers only ever see a transcript string.
 */

import { streamTts } from "@/lib/api/ttsClient";
import { OrchestratorRefused } from "@/lib/api/fridayClient";
import { TtsPlayer } from "@/lib/ttsPlayer";
import { FRIDAY_LANG_KEY } from "@/lib/store";
import type { SupportedLang } from "@/lib/audioBus";

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  0: RecognitionAlternative;
  isFinal: boolean;
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [i: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function canListen(): boolean {
  return recognitionCtor() !== null;
}

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Opens the microphone and reports transcripts.
 *
 * Returns a stop function. Interim results are reported too so the input line
 * can show words as they are recognised — waiting for the final transcript
 * leaves the operator staring at a dot wondering whether it heard them.
 */
export function startListening({
  onInterim,
  onFinal,
  onEnd,
  lang = "en-US",
}: {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd?: (error?: string) => void;
  lang?: string;
}): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onEnd?.("unsupported");
    return () => {};
  }

  const recognition = new Ctor();
  recognition.lang = lang;
  // One utterance per press. Continuous mode keeps the mic open indefinitely,
  // which is a worse default for something that fires a request per phrase.
  recognition.continuous = false;
  recognition.interimResults = true;

  let settled = false;
  let error: string | undefined;

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (!text) continue;
      if (result.isFinal) {
        settled = true;
        onFinal(text);
      } else {
        onInterim?.(text);
      }
    }
  };

  recognition.onerror = (e) => {
    // "no-speech" and "aborted" are ordinary outcomes, not failures worth
    // surfacing — the operator pressed the button and said nothing, or pressed
    // it again to cancel.
    if (e.error !== "no-speech" && e.error !== "aborted") error = e.error;
  };

  recognition.onend = () => onEnd?.(settled ? undefined : error);

  recognition.start();

  return () => recognition.abort();
}

let ttsPlayer: TtsPlayer | null = null;

/** Test-only seam: production code never calls this. */
export function __setTtsPlayerForTests(p: TtsPlayer | null): void {
  ttsPlayer = p;
}

function player(): TtsPlayer {
  ttsPlayer ??= new TtsPlayer();
  return ttsPlayer;
}

/** Current TTS analyser levels for `bars` bars, or null when inactive. */
export function ttsLevels(bars: number): number[] | null {
  return ttsPlayer?.levels(bars) ?? null;
}

function currentLang(): SupportedLang {
  try {
    const stored = localStorage.getItem(FRIDAY_LANG_KEY);
    if (stored === "vi-VN" || stored === "en-US") return stored;
    if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("vi")) {
      return "vi-VN";
    }
  } catch {
    /* private mode — en-US default stands */
  }
  return "en-US";
}

/**
 * Reads text aloud, resolving when the utterance finishes.
 *
 * Raced against a deadline because `onend` is not reliable — a tab backgrounded
 * mid-sentence, or a platform with no installed voice, can leave the promise
 * hanging forever, and this one gates the return to IDLE.
 */
let speakStart = 0;
let speakEstimate = 0;

/** 0..1 progress of the current utterance, or null when not speaking. */
export function speakProgress(): number | null {
  const tp = ttsPlayer?.progress() ?? null;
  if (tp !== null) return tp;
  if (!speakStart || !speakEstimate) return null;
  return Math.max(0, Math.min(1, (Date.now() - speakStart) / speakEstimate));
}

/**
 * Aborts the in-flight utterance, if any. Without this, barge-in and cancel
 * stop only the audible graph while the /tts fetch keeps running — and a
 * stream that resolves after stop() starts fresh audio post-stop.
 */
let speakController: AbortController | null = null;

export function speak(text: string, opts?: { signal?: AbortSignal }): Promise<void> {
  if (!text.trim()) return Promise.resolve();
  speakController?.abort();
  const ctrl = new AbortController();
  speakController = ctrl;
  const external = opts?.signal;
  const onExternalAbort = () => ctrl.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  const signal = ctrl.signal;
  return speakViaTts(text, signal)
    .catch((err) => {
      // An aborted utterance is intentional silence — never synth-fallback it
      // into a second voice, and never report it as a failure.
      if ((err as Error)?.name === "AbortError" || signal.aborted) throw err;
      // A refusal (403/429) is not an outage — speaking the answer anyway via
      // synthesis would hide a real rate-limit/origin denial behind audio.
      if (err instanceof OrchestratorRefused) throw err;
      // Two-phase rule: frames already flowed means mid-playback (phase 2) —
      // stay quiet rather than stacking a second voice. Pre-flow failures
      // (phase 1) fall back to synthesis.
      if (player().framesFlowed > 0) return;
      return speakViaSynthesis(text);
    })
    .finally(() => {
      external?.removeEventListener("abort", onExternalAbort);
      if (speakController === ctrl) speakController = null;
    });
}

async function speakViaTts(text: string, signal: AbortSignal): Promise<void> {
  const stream = await streamTts(text, currentLang(), { signal });
  await player().play(stream, { signal });
}

function speakViaSynthesis(text: string): Promise<void> {
  if (!canSpeak()) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      speakStart = 0;
      speakEstimate = 0;
      resolve();
    };

    // ~14 characters a second is slow speech; the extra 2s covers the lead-in
    speakEstimate = (text.length / 14) * 1000 + 2000;
    speakStart = Date.now();
    const deadline = setTimeout(finish, speakEstimate);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = finish;
    utterance.onerror = finish;
    // anything still queued belongs to a turn the operator has moved on from
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

export function stopSpeaking(): void {
  speakController?.abort();
  speakController = null;
  ttsPlayer?.stop();
  speakStart = 0;
  speakEstimate = 0;
  if (canSpeak()) window.speechSynthesis.cancel();
}
