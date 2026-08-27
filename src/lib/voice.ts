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

/**
 * Reads text aloud, resolving when the utterance finishes.
 *
 * Raced against a deadline because `onend` is not reliable — a tab backgrounded
 * mid-sentence, or a platform with no installed voice, can leave the promise
 * hanging forever, and this one gates the return to IDLE.
 */
export function speak(text: string): Promise<void> {
  if (!canSpeak() || !text.trim()) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve();
    };

    // ~14 characters a second is slow speech; the extra 2s covers the lead-in
    const deadline = setTimeout(finish, (text.length / 14) * 1000 + 2000);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = finish;
    utterance.onerror = finish;
    // anything still queued belongs to a turn the operator has moved on from
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}
