import { binsToLevels, getSharedAudioContext } from "@/lib/audioBus";
import type { TtsStream } from "@/lib/api/ttsClient";

export interface TtsPlayerDeps {
  createContext?: () => AudioContext | null;
  createNode?: (ctx: AudioContext) => AudioWorkletNode;
  workletUrl?: string;
  analyserFftSize?: number;
}

type TtsWorkletMsg = { type: "ready" } | { type: "consumed"; count: number };

interface WorkletPort {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: { data: TtsWorkletMsg }) => void): void;
  close(): void;
  start?: () => void;
}

/** Samples allowed in flight before the pump waits for a `ready` message. */
const MAX_PENDING = 8 * 1024;

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class TtsPlayer {
  private generation = 0;
  private played = 0;
  private total: number | null = null;
  private analyser: AnalyserNode | null = null;
  private port: WorkletPort | null = null;
  private node: AudioWorkletNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private frames = 0;
  /** Resolves the backpressure wait; woken by `ready`, `consumed`, or `stop()`. */
  private readyResolve: (() => void) | null = null;
  private readonly workletUrl: string;
  private readonly analyserFftSize: number;
  private readonly createContext?: () => AudioContext | null;
  private readonly createNode?: (ctx: AudioContext) => AudioWorkletNode;

  constructor(deps: TtsPlayerDeps = {}) {
    this.workletUrl = deps.workletUrl ?? "/audio/tts-worklet.js";
    this.analyserFftSize = deps.analyserFftSize ?? 256;
    if (deps.createContext) this.createContext = deps.createContext;
    if (deps.createNode) this.createNode = deps.createNode;
  }

  get active(): boolean {
    return this.analyser !== null;
  }

  /** PCM frames delivered to the worklet so far (drives the phase-1/2 rule). */
  get framesFlowed(): number {
    return this.frames;
  }

  async play(stream: TtsStream, opts?: { signal?: AbortSignal }): Promise<void> {
    const signal = opts?.signal;
    if (signal?.aborted) throw abortError();
    const my = ++this.generation;
    // A new play owns the player: drop any previous graph and reset the
    // counters up front, so even an early failure (unsupported context,
    // pre-first-chunk abort) leaves frames reflecting THIS attempt (0 fed).
    // A superseded in-flight play exits at its next check without touching
    // counters (generation guard in the handler + aborted-first ordering).
    this.teardown();
    this.wakeReady();
    const total: number | null = stream.header.totalSamples;
    this.total = total;
    this.played = 0;
    this.frames = 0;
    const aborted = (): boolean => my !== this.generation || signal?.aborted === true;

    const create = this.createContext ?? getSharedAudioContext;
    const ctx = create();
    if (!ctx) throw new Error("unsupported");
    if (ctx.state === "suspended") await ctx.resume();
    if (aborted()) throw abortError();
    await ctx.audioWorklet.addModule(this.workletUrl);
    if (aborted()) throw abortError();

    const node = this.createNode?.(ctx) ?? new AudioWorkletNode(ctx, "tts-player");
    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.analyserFftSize;
    node.connect(analyser);
    analyser.connect(ctx.destination);
    this.node = node;
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    const port = node.port as unknown as WorkletPort;
    this.port = port;
    // addEventListener (unlike onmessage) needs an explicit start on a MessagePort.
    if (typeof port.start === "function") port.start();
    let pending = 0;
    port.addEventListener("message", (e) => {
      // A superseded port must not pollute the new play's counters.
      if (this.generation !== my) return;
      if (e.data.type === "consumed") {
        this.played += e.data.count;
        pending = Math.max(0, pending - e.data.count);
      }
      // Wake the backpressure wait on either message; the waiter re-checks
      // pending, so a dropped, duplicate, or spurious wakeup is always safe.
      const wake = this.readyResolve;
      this.readyResolve = null;
      wake?.();
    });
    const onAbort = (): void => {
      this.stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const chunk of stream.chunks) {
        if (aborted()) throw abortError();
        if (chunk.byteLength % 2 !== 0) throw new Error("malformed pcm chunk");
        const n = chunk.byteLength / 2;
        if (n === 0) continue;
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const float = new Float32Array(n);
        for (let i = 0; i < n; i++) float[i] = view.getInt16(i * 2, true) / 32768;
        pending += n;
        this.frames += n;
        port.postMessage({ type: "feed", samples: float }, [float.buffer as ArrayBuffer]);
        // Backpressure: park while over budget. The waiter is woken by every
        // current-generation worklet message and re-checks pending, so a
        // ready that arrived with no waiter parked can never stall the pump.
        // No clearing of readyResolve after the wait: a superseding play owns
        // it now, and invoking a settled resolve is a harmless no-op.
        while (pending > MAX_PENDING) {
          if (aborted()) throw abortError();
          await new Promise<void>((resolve) => {
            this.readyResolve = resolve;
          });
        }
      }
      // Drain: the utterance ends once everything fed is consumed — a
      // truncated known-total stream (played < total) still terminates via
      // pending === 0, with progress() reporting < 1.
      for (;;) {
        if (aborted()) throw abortError();
        // Same-tick check-then-read: every mutation of played (new-play
        // reset, current-generation handler) is preceded by or guarded with
        // the generation check above, and total is an immutable local.
        const played = this.played;
        if (pending === 0) return;
        if (total !== null && played >= total) return;
        await sleep(25);
      }
    } catch (err) {
      // A failed play must not leave a live graph behind (levels() would keep
      // serving data after a rejection) — but a superseded play must not tear
      // down its successor's graph. Counters survive for the phase rule.
      if (this.generation === my) this.teardown();
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  levels(bars: number): number[] | null {
    if (!this.analyser || !this.freq) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return binsToLevels(this.freq, bars);
  }

  progress(): number | null {
    if (!this.active || this.total === null) return null;
    return Math.max(0, Math.min(1, this.played / Math.max(1, this.total)));
  }

  stop(): void {
    this.generation++;
    this.teardown();
    this.wakeReady();
    // Preserve frames/played across abort: Task 3 reads framesFlowed after a
    // rejection to tell partial playback (phase 2, quiet) from zero frames
    // (phase 1, synthesis fallback). They reset on the next play() start.
    // The graph is gone, so levels()/progress() already report null via active.
    this.total = null;
  }

  /** Wake a play parked in the backpressure wait so it can observe abort. */
  private wakeReady(): void {
    const wake = this.readyResolve;
    this.readyResolve = null;
    wake?.();
  }

  private teardown(): void {
    try {
      this.port?.close();
    } catch {
      /* already closed */
    }
    try {
      this.node?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.analyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.port = null;
    this.node = null;
    this.analyser = null;
    this.freq = null;
  }
}
