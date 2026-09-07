/**
 * Shared audio bus — one duplex source for the visuals, two inputs.
 *
 * Mic side is real: `getUserMedia` → `AnalyserNode`, read as 0..1 levels per
 * bar. TTS side cannot be real — no browser exposes `speechSynthesis` output
 * to WebAudio — so SPEAKING uses a pseudo-envelope driven by utterance
 * progress (see `utteranceEnvelope`), with this module owning the seam for a
 * future provider-TTS that returns playable audio.
 *
 * Everything browser-only is guarded: importing this on the server or calling
 * `attachMic` where there is no capture rejects with `unsupported` instead of
 * throwing, so the ring falls back to its synthesised motion.
 */

export type SupportedLang = "vi-VN" | "en-US";

/** Stored choice wins, then the browser locale, then en-US. Pure, tested. */
export function resolveLang(navigatorLang: string | undefined, stored: string | null): SupportedLang {
  if (stored === "vi-VN" || stored === "en-US") return stored;
  if (navigatorLang?.toLowerCase().startsWith("vi")) return "vi-VN";
  return "en-US";
}

/**
 * Map FFT magnitude bins (0..255) onto `bars` levels (0..1).
 * Quadratic spacing spends resolution on low frequencies, where speech lives.
 * Pure, tested — the canvas never touches the analyser directly.
 */
export function binsToLevels(freq: ArrayLike<number>, bars: number): number[] {
  const n = freq.length;
  if (n === 0) return new Array(bars).fill(0);
  const out: number[] = new Array(bars);
  for (let i = 0; i < bars; i++) {
    const t = bars === 1 ? 0 : i / (bars - 1);
    const idx = Math.min(n - 1, Math.floor(t * t * (n - 1)));
    out[i] = Math.max(0, Math.min(1, (freq[idx] ?? 0) / 255));
  }
  return out;
}

/** Pseudo speech envelope 0.35..1 from utterance progress 0..1. Pure. */
export function utteranceEnvelope(progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  return 0.35 + 0.65 * (Math.sin(p * Math.PI * 3) * 0.5 + 0.5) * Math.sin(p * Math.PI);
}

let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let stream: MediaStream | null = null;
let freqCache: Uint8Array<ArrayBuffer> | null = null;
/** Invalidates a pending attachMic when detach runs mid-await. */
let micGeneration = 0;

function audioCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function hasCapture(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    audioCtor() !== null
  );
}

export function isMicAttached(): boolean {
  return stream !== null && analyser !== null;
}

/**
 * Opens the microphone into a shared AnalyserNode. Resolves once the stream
 * is live; rejects `unsupported` (no capture here) or `mic-denied`.
 * Idempotent — a second call while attached resolves immediately.
 */
export async function attachMic(): Promise<void> {
  if (isMicAttached()) return;
  if (!hasCapture()) throw new Error("unsupported");
  const Ctor = audioCtor();
  if (!Ctor) throw new Error("unsupported");
  const myGeneration = ++micGeneration;

  let next: MediaStream;
  try {
    next = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new Error("mic-denied");
  }
  // Detached while awaiting the device — drop the orphan stream, publish nothing.
  if (myGeneration !== micGeneration) {
    next.getTracks().forEach((t) => t.stop());
    return;
  }

  try {
    context ??= new Ctor();
    if (context.state === "suspended") await context.resume();
    // Re-check after the second await: detach may have landed during resume.
    if (myGeneration !== micGeneration) {
      next.getTracks().forEach((t) => t.stop());
      return;
    }
    const nextSource = context.createMediaStreamSource(next);
    const nextAnalyser = context.createAnalyser();
    nextAnalyser.fftSize = 256;
    nextAnalyser.smoothingTimeConstant = 0.75;
    nextSource.connect(nextAnalyser);
    source = nextSource;
    analyser = nextAnalyser;
    freqCache = new Uint8Array(nextAnalyser.frequencyBinCount);
    stream = next;
  } catch (err) {
    next.getTracks().forEach((t) => t.stop());
    throw err;
  }
}

/** Stops the mic tracks and drops the analyser. Always safe to call. */
export function detachMic(): void {
  // Invalidate any attach still awaiting getUserMedia/resume.
  micGeneration++;
  try {
    source?.disconnect();
  } catch {
    /* already disconnected */
  }
  try {
    analyser?.disconnect();
  } catch {
    /* already disconnected */
  }
  source = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  analyser = null;
  freqCache = null;
  // Suspend the shared context so idle tabs don't burn CPU; re-attached on demand.
  if (context && context.state === "running") {
    void context.suspend().catch(() => {});
  }
}

/** Current mic levels for `bars` bars, or null when no mic is attached. */
export function readMicLevels(bars: number): number[] | null {
  if (!analyser || !freqCache) return null;
  analyser.getByteFrequencyData(freqCache);
  return binsToLevels(freqCache, bars);
}

/** Shared context for secondary analysers (TTS). Null when unsupported. */
export function getSharedAudioContext(): AudioContext | null {
  const Ctor = audioCtor();
  if (!Ctor || !hasCapture()) return null;
  context ??= new Ctor();
  return context;
}
