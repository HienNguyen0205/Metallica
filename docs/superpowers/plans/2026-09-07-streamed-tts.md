# Streamed Provider-TTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SPEAKING plays streamed PCM from `POST /tts` through an `AudioWorklet` into a dedicated analyser that drives `WaveformRing`, falling back to `speechSynthesis` before the first chunk.

**Architecture:** New `ttsClient` (contract parse) + `ttsPlayer` (progressive playback, analyser tap) with injectable audio deps for tests; `voice.ts` orchestrates TTS-first/synthesis-fallback; `audioBus` shares its `AudioContext`; `FridayCore` reads TTS levels via the same per-frame cache pattern as the mic. Public `speak`/`stopSpeaking`/`speakProgress` signatures unchanged, so `agentStream.ts` and `InputBar.tsx` are untouched.

**Tech Stack:** TypeScript strict, Web Audio (`AudioContext`/`AudioWorklet`/`AnalyserNode`), Playwright Test (unit + UI), no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-streamed-tts-design.md`

## Global Constraints

- TypeScript `strict` — `npm run typecheck` must pass; no `any` without a narrowed guard.
- No new npm dependencies — Web Audio only.
- Chromium-only features degrade silently (missing `AudioContext`/worklet → phase-1 fallback, never a throw to callers).
- TDD red-green for every task — watch each test fail before implementing.
- `npm run lint` clean — no new eslint-disable except the existing PostFX uniform pattern (do not add more).
- `speak(text): Promise<void>`, `stopSpeaking(): void`, `speakProgress(): number | null` signatures unchanged.

---

### Task 1: `ttsClient` — contract parse + typed errors

**Files:**
- Create: `src/lib/api/ttsClient.ts`
- Test: `tests/unit/ttsPlayer.spec.ts` (sections: client)

**Interfaces:**
- Consumes: `sessionId()` pattern from `src/lib/api/fridayClient.ts:21-32` (copy the tab-id logic, do not import the private function); `OrchestratorRefused` from `src/lib/api/fridayClient.ts:40-49` (import it); `SupportedLang` from `src/lib/audioBus.ts:15` (import type).
- Produces (used by Task 2):
  - `export interface TtsHeader { sampleRate: number; channels: 1; totalSamples: number | null }`
  - `export interface TtsStream { header: TtsHeader; chunks: AsyncGenerator<Uint8Array, void, void> }`
  - `export type TtsErrorKind = "unreachable" | "refused" | "malformed"`
  - `export class TtsError extends Error { constructor(readonly kind: TtsErrorKind, message: string) }`
  - `export async function streamTts(text: string, lang: SupportedLang, opts?: { signal?: AbortSignal }): Promise<TtsStream>`

Wire format (must match spec §1): response body is a byte stream of
length-prefixed frames — first frame is a JSON header
`{ sampleRate, channels, totalSamples? }`, following frames are raw int16-LE
PCM. Frame prefix: 4-byte little-endian uint32 length. Header validation:
`sampleRate` finite 8000–48000, `channels === 1`, `totalSamples` absent or
finite non-negative (else `null`). Any short/overlong frame, bad JSON, or bad
header → `TtsError("malformed", ...)`. Fetch throw/AbortError → return
silently on abort (like `streamQuery`), else `TtsError("unreachable", ...)`.
HTTP 403/429 → `OrchestratorRefused` (imported, not wrapped). Other non-OK →
`TtsError("unreachable", "tts <status>")`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, expect } from "@playwright/test";
import { streamTts, TtsError } from "@/lib/api/ttsClient";
import { OrchestratorRefused } from "@/lib/api/fridayClient";

function frames(payloads: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  for (const p of payloads) {
    const len = p.length;
    parts.push(len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff, ...p);
  }
  return new Uint8Array(parts);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

test("parses header then yields PCM chunks", async () => {
  const header = new TextEncoder().encode(JSON.stringify({ sampleRate: 24000, channels: 1, totalSamples: 48 }));
  const pcm = new Uint8Array([1, 0, 2, 0]);
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(streamOf(frames([header, pcm])), { status: 200 });
  const s = await streamTts("hello", "en-US");
  expect(s.header).toEqual({ sampleRate: 24000, channels: 1, totalSamples: 48 });
  const out: Uint8Array[] = [];
  for await (const c of s.chunks) out.push(c);
  expect(out).toHaveLength(1);
  expect(out[0]).toEqual(pcm);
});

test("missing totalSamples becomes null", async () => {
  const header = new TextEncoder().encode(JSON.stringify({ sampleRate: 16000, channels: 1 }));
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(streamOf(frames([header])), { status: 200 });
  const s = await streamTts("hi", "vi-VN");
  expect(s.header.totalSamples).toBeNull();
});

test("bad header is malformed, 429 is refused, network down is unreachable", async () => {
  const put = (fn: unknown) => { (globalThis as unknown as { fetch: unknown }).fetch = fn; };
  put(async () => new Response(streamOf(frames([new TextEncoder().encode("nope")])), { status: 200 }));
  await expect(streamTts("x", "en-US")).rejects.toMatchObject({ name: "TtsError", kind: "malformed" });
  put(async () => new Response(null, { status: 429 }));
  await expect(streamTts("x", "en-US")).rejects.toBeInstanceOf(OrchestratorRefused);
  put(async () => { throw new TypeError("fetch failed"); });
  await expect(streamTts("x", "en-US")).rejects.toMatchObject({ name: "TtsError", kind: "unreachable" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/ttsPlayer.spec.ts`
Expected: FAIL with "Cannot find module '@/lib/api/ttsClient'" (or unresolved import).

- [ ] **Step 3: Write minimal implementation**

```ts
import { OrchestratorRefused } from "@/lib/api/fridayClient";
import type { SupportedLang } from "@/lib/audioBus";

const API = process.env.NEXT_PUBLIC_FRIDAY_API ?? "http://localhost:8000";
const MAX_FRAME = 4 * 1024 * 1024;

export interface TtsHeader { sampleRate: number; channels: 1; totalSamples: number | null }
export interface TtsStream { header: TtsHeader; chunks: AsyncGenerator<Uint8Array, void, void> }
export type TtsErrorKind = "unreachable" | "refused" | "malformed";
export class TtsError extends Error {
  readonly kind: TtsErrorKind;
  constructor(kind: TtsErrorKind, message: string) {
    super(message);
    this.name = "TtsError";
    this.kind = kind;
  }
}

function tabSessionId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    let id = window.sessionStorage.getItem("friday.session");
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem("friday.session", id);
    }
    return id;
  } catch {
    return undefined;
  }
}

async function readExactly(reader: ReadableStreamDefaultReader<Uint8Array>, n: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  const out = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    if (signal?.aborted) return null;
    const { done, value } = await reader.read();
    if (done) return null;
    out.set(value.subarray(0, Math.min(value.length, n - got)), got);
    got += Math.min(value.length, n - got);
    if (value.length > n - got + (value.length - Math.min(value.length, n - got))) {
      throw new TtsError("malformed", "overlong frame");
    }
  }
  return out;
}
```

Full frame loop: read 4-byte LE length (short stream → malformed unless zero
frames preceded by nothing — an empty body is malformed), reject
`len === 0 || len > MAX_FRAME`, then read exactly `len` bytes. First frame
must JSON-parse to a valid header or throw malformed. Abort mid-read returns
`null` and ends the generator silently.

```ts
export async function streamTts(text: string, lang: SupportedLang, opts?: { signal?: AbortSignal }): Promise<TtsStream> {
  const { signal } = opts ?? {};
  let res: Response;
  try {
    res = await fetch(`${API}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, lang, session_id: tabSessionId() }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError" || signal?.aborted) throw new DOMException("aborted", "AbortError");
    throw new TtsError("unreachable", err instanceof Error ? err.message : String(err));
  }
  if (res.status === 403 || res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    throw new OrchestratorRefused(res.status, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  if (!res.ok || !res.body) throw new TtsError("unreachable", `tts ${res.status}`);
  const reader = res.body.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array, void, void> {
    for (;;) {
      const prefix = await readExactly(reader, 4, signal);
      if (!prefix) return;
      const len = prefix[0] | (prefix[1] << 8) | (prefix[2] << 16) | (prefix[3] << 24);
      if (len === 0 || len > MAX_FRAME) throw new TtsError("malformed", `bad frame length ${len}`);
      const body = await readExactly(reader, len, signal);
      if (!body) throw new TtsError("malformed", "truncated frame");
      yield body;
    }
  }
  const gen = chunks();
  const first = await gen.next();
  if (first.done) throw new TtsError("malformed", "empty tts stream");
  let header: TtsHeader;
  try {
    const raw = JSON.parse(new TextDecoder().decode(first.value)) as Record<string, unknown>;
    const sampleRate = Number(raw.sampleRate);
    const total = raw.totalSamples === undefined ? null : Number(raw.totalSamples);
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error("rate");
    if (raw.channels !== 1) throw new Error("channels");
    header = { sampleRate, channels: 1, totalSamples: total !== null && Number.isFinite(total) && (total as number) >= 0 ? (total as number) : null };
  } catch {
    throw new TtsError("malformed", "bad tts header");
  }
  return { header, chunks: gen };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/ttsPlayer.spec.ts`
Expected: the 3 client tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/ttsClient.ts tests/unit/ttsPlayer.spec.ts
git commit -m "feat(tts): streamTts contract parse with typed errors"
```

---

### Task 2: `ttsPlayer` — progressive playback + analyser tap

**Files:**
- Create: `src/lib/ttsPlayer.ts`
- Modify: `src/lib/audioBus.ts` (append `getSharedAudioContext`, reuse in player only — do NOT refactor `attachMic` internals)
- Test: `tests/unit/ttsPlayer.spec.ts` (append player sections)

**Interfaces:**
- Consumes: `TtsStream`, `TtsHeader` from Task 1; `binsToLevels` from `src/lib/audioBus.ts:29-38`.
- Produces (used by Task 3):
  - `export interface TtsPlayerDeps { createContext?: () => AudioContext | null; workletUrl?: string; analyserFftSize?: number }`
  - `export class TtsPlayer { constructor(deps?: TtsPlayerDeps); play(stream: TtsStream, opts?: { signal?: AbortSignal }): Promise<void>; levels(bars: number): number[] | null; progress(): number | null; stop(): void; get active(): boolean; get framesFlowed(): number }`
  - `play` resolves when the stream is fully consumed AND the queued samples drain (utterance finished); known total → waits for it, unknown total → waits for the queue to empty. Rejects on abort (`DOMException AbortError`) or corrupt mid-stream data; never rejects on clean completion.
  - `levels` returns `null` before start/after stop (caller falls back to synth); uses a module-level `Uint8Array` cache sized by the analyser exactly like `readMicLevels`.
  - `progress` returns `playedSamples / totalSamples` clamped 0..1, or `null` when total unknown or not started (caller falls back to the deadline estimate).
  - `audioBus.getSharedAudioContext(): AudioContext | null` — creates/resumes the ONE shared context (same instance `attachMic` uses), returns `null` when unsupported. Append to `audioBus.ts` without touching `attachMic`'s body except replacing its `context ??= new Ctor()` + resume lines with a call to the helper (identical behavior, keeps one creation site).

Playback mechanics: `audioWorklet.addModule(workletUrl ?? "/audio/tts-worklet.js")`, one `AudioWorkletNode`, `MediaStream`-free graph `worklet → analyser → destination`. Chunk pump: Int16 frame → Float32 mono → postMessage (transferable) to the worklet port; backpressure by awaiting a `ready` message when the queue exceeds 8 chunks. `playedSamples` advances on worklet `consumed` messages. Abort: `stop()` sets a generation token (same pattern as `micGeneration`), closes the port, disconnects nodes, resolves `play` as aborted.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, expect } from "@playwright/test";
import { TtsPlayer } from "@/lib/ttsPlayer";
import type { TtsStream } from "@/lib/api/ttsClient";

function pcmChunk(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
}

async function* gen(chunks: Uint8Array[]): AsyncGenerator<Uint8Array, void, void> {
  for (const c of chunks) yield c;
}

function fakeDeps(record: { posted: number; consumed: number }) {
  const listeners = new Map<string, Array<(e: { data: unknown }) => void>>();
  const port = {
    postMessage: (msg: unknown) => {
      const m = msg as { type: string; samples?: Float32Array };
      if (m.type === "feed") {
        record.posted += m.samples?.length ?? 0;
        queueMicrotask(() => {
          record.consumed += m.samples?.length ?? 0;
          for (const fn of listeners.get("message") ?? []) fn({ data: { type: "consumed", count: m.samples?.length ?? 0 } });
          for (const fn of listeners.get("message") ?? []) fn({ data: { type: "ready" } });
        });
      }
    },
    addEventListener: (t: string, fn: (e: { data: unknown }) => void) => {
      listeners.set(t, [...(listeners.get(t) ?? []), fn]);
    },
    close: () => {},
  };
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 4,
    getByteFrequencyData: (arr: Uint8Array) => { arr.fill(200); },
    disconnect: () => {},
  };
  const node = { port, connect: () => {}, disconnect: () => {} };
  const context = {
    state: "running",
    resume: async () => {},
    sampleRate: 24000,
    audioWorklet: { addModule: async () => {} },
    createWorkletNode: () => node,
    createAnalyser: () => analyser,
    destination: {},
  };
  return { createContext: () => context, workletUrl: "/fake.js" };
}

test("plays chunks to completion and reports progress", async () => {
  const record = { posted: 0, consumed: 0 };
  const player = new TtsPlayer(fakeDeps(record) as never);
  const stream: TtsStream = {
    header: { sampleRate: 24000, channels: 1, totalSamples: 4 },
    chunks: gen([pcmChunk([1000, 2000]), pcmChunk([3000, 4000])]),
  };
  expect(player.levels(8)).toBeNull();
  await player.play(stream);
  expect(record.posted).toBe(4);
  expect(player.progress()).toBe(1);
  const lv = player.levels(8);
  expect(lv).toHaveLength(8);
  expect(lv!.every((v) => v > 0.5)).toBe(true);
});

test("stop() aborts play and clears levels", async () => {
  const record = { posted: 0, consumed: 0 };
  const player = new TtsPlayer({
    ...(fakeDeps(record) as object),
    createContext: () => null,
  } as never);
  const stream: TtsStream = {
    header: { sampleRate: 24000, channels: 1, totalSamples: null },
    chunks: gen([pcmChunk([1])]),
  };
  await expect(player.play(stream)).rejects.toThrow(/unsupported/i);
  expect(player.levels(4)).toBeNull();
  expect(player.progress()).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/ttsPlayer.spec.ts`
Expected: FAIL with "Cannot find module '@/lib/ttsPlayer'".

- [ ] **Step 3: Write minimal implementation**

```ts
import { binsToLevels } from "@/lib/audioBus";
import { getSharedAudioContext } from "@/lib/audioBus";
import type { TtsStream } from "@/lib/api/ttsClient";

export interface TtsPlayerDeps {
  createContext?: () => AudioContext | null;
  workletUrl?: string;
  analyserFftSize?: number;
}

interface WorkletPort {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: { data: TtsWorkletMsg }) => void): void;
  close(): void;
}
type TtsWorkletMsg = { type: "ready" } | { type: "consumed"; count: number };

export class TtsPlayer {
  private generation = 0;
  private played = 0;
  private total: number | null = null;
  private analyser: AnalyserNode | null = null;
  private port: WorkletPort | null = null;
  private node: AudioWorkletNode | null = null;
  private freq: Uint8Array | null = null;
  private frames = 0;
  private readonly deps: Required<Pick<TtsPlayerDeps, "workletUrl" | "analyserFftSize">> & Pick<TtsPlayerDeps, "createContext">;

  constructor(deps: TtsPlayerDeps = {}) {
    this.deps = {
      workletUrl: deps.workletUrl ?? "/audio/tts-worklet.js",
      analyserFftSize: deps.analyserFftSize ?? 256,
      ...(deps.createContext ? { createContext: deps.createContext } : {}),
    };
  }

  get active(): boolean {
    return this.analyser !== null;
  }

  /** PCM frames delivered to the worklet so far (drives the phase-1/2 rule). */
  get framesFlowed(): number {
    return this.frames;
  }

  async play(stream: TtsStream, opts?: { signal?: AbortSignal }): Promise<void> {
    const my = ++this.generation;
    const create = this.deps.createContext ?? getSharedAudioContext;
    const ctx = create();
    if (!ctx) throw new Error("unsupported");
    if (ctx.state === "suspended") await ctx.resume();
    if (my !== this.generation || opts?.signal?.aborted) return;
    await ctx.audioWorklet.addModule(this.deps.workletUrl);
    if (my !== this.generation || opts?.signal?.aborted) return;
    const node = new AudioWorkletNode(ctx, "tts-player");
    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.deps.analyserFftSize;
    node.connect(analyser);
    analyser.connect(ctx.destination);
    this.node = node;
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.total = stream.header.totalSamples;
    this.played = 0;
    this.frames = 0;
    const port = node.port as unknown as WorkletPort;
    this.port = port;
    let pending = 0;
    let done = false;
    let readyResolve: (() => void) | null = null;
    port.addEventListener("message", (e) => {
      if (e.data.type === "consumed") {
        this.played += e.data.count;
        pending = Math.max(0, pending - e.data.count);
      }
      if (e.data.type === "ready" && readyResolve) {
        const r = readyResolve;
        readyResolve = null;
        r();
      }
    });
    const onAbort = () => { this.stop(); };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const chunk of stream.chunks) {
        if (my !== this.generation || opts?.signal?.aborted) return;
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const n = Math.floor(chunk.byteLength / 2);
        if (n === 0) continue;
        const float = new Float32Array(n);
        for (let i = 0; i < n; i++) float[i] = view.getInt16(i * 2, true) / 32768;
        pending += n;
        this.frames += n;
        port.postMessage({ type: "feed", samples: float }, [float.buffer]);
        if (pending > 8 * 1024) await new Promise<void>((r) => { readyResolve = r; });
      }
      done = true;
      // Drain: known total → wait for it; unknown total → wait for the queue.
      while (my === this.generation && !opts?.signal?.aborted) {
        if (this.total !== null ? this.played >= this.total : pending === 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      opts?.signal?.removeEventListener("abort", onAbort);
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
    try { this.port?.close(); } catch { /* already closed */ }
    try { this.node?.disconnect(); } catch { /* already disconnected */ }
    try { this.analyser?.disconnect(); } catch { /* already disconnected */ }
    this.port = null;
    this.node = null;
    this.analyser = null;
    this.freq = null;
    this.played = 0;
    this.total = null;
    this.frames = 0;
  }
}
```

`audioBus.ts` append (do not touch `attachMic`'s body):

```ts
/** Shared context for secondary analysers (TTS). Null when unsupported. */
export function getSharedAudioContext(): AudioContext | null {
  const Ctor = audioCtor();
  if (!Ctor || !hasCapture()) return null;
  context ??= new Ctor();
  return context;
}
```

Note: `audioCtor`, `hasCapture`, `context` already exist as module privates in
`audioBus.ts:46-66` — the helper reuses them in place.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/ttsPlayer.spec.ts`
Expected: all 5 tests PASS (3 client + 2 player).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ttsPlayer.ts src/lib/audioBus.ts tests/unit/ttsPlayer.spec.ts
git commit -m "feat(tts): progressive TtsPlayer with analyser tap"
```

---

### Task 3: `voice.ts` — TTS-first speak with synthesis fallback

**Files:**
- Modify: `src/lib/voice.ts`
- Test: `tests/unit/audioBus.spec.ts` (append: speak-prefers-tts + fallback sections — the file already imports `speakProgress` and owns voice-adjacent tests)

**Interfaces:**
- Consumes: `streamTts`, `TtsError` from Task 1; `TtsPlayer` from Task 2.
- Produces (used by Task 4): `export function ttsLevels(bars: number): number[] | null`.

Behavior (spec §3): `speak(text)` tries `streamTts` → `player.play`. Any
throw before the first audio frame reaches the worklet (phase 1: unreachable,
refused, malformed header, unsupported context) → fall back to the existing
`speechSynthesis` path verbatim (cancel queue, utterance, deadline). Once
frames are flowing (phase 2), failures end playback quietly — no synthesis
takeover. `speakProgress()`: TTS sample progress while the player is active,
else the legacy time estimate. `stopSpeaking()`: `player.stop()` + legacy
reset + `speechSynthesis.cancel()`. Module-level `let ttsPlayer: TtsPlayer |
null` lazily created (injectable via `__setTtsPlayerForTests` — test-only
escape hatch, documented as such; production code never calls it).

- [ ] **Step 1: Write the failing tests**

```ts
import { speak, speakProgress, stopSpeaking, ttsLevels, __setTtsPlayerForTests } from "@/lib/voice";

test("speak prefers TTS audio and reports sample progress", async () => {
  const calls: string[] = [];
  const fakePlayer = {
    play: async () => { calls.push("play"); },
    stop: () => { calls.push("stop"); },
    levels: () => [0.9],
    progress: () => 0.5,
    framesFlowed: 128,
    active: true,
  };
  __setTtsPlayerForTests(fakePlayer as never);
  try {
    await speak("hello");
    expect(calls).toEqual(["play"]);
  } finally {
    __setTtsPlayerForTests(null);
  }
});

test("phase-1 failure falls back to synthesis; phase-2 failure stays quiet", async () => {
  const spoken: string[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const prevSpeech = g["speechSynthesis"];
  Object.defineProperty(globalThis, "speechSynthesis", {
    value: { cancel: () => {}, speak: (u: { text: string }) => { spoken.push(u.text); } },
    configurable: true,
    writable: true,
  });
  try {
    // Phase 1: streamTts throws before any frame flows → synthesis fallback.
    const failing = { play: async () => { throw new Error("boom"); }, stop: () => {}, levels: () => null, progress: () => null, framesFlowed: 0, active: false };
    __setTtsPlayerForTests(failing as never);
    const failingFetch = async () => { throw new TypeError("down"); };
    const prevFetch = g["fetch"];
    g["fetch"] = failingFetch;
    try {
      await speak("fallback me");
    } finally {
      g["fetch"] = prevFetch;
    }
    expect(spoken).toEqual(["fallback me"]);
    // Phase 2: frames already flowed → quiet stop, no second voice.
    spoken.length = 0;
    const midFail = {
      framesFlowed: 0,
      play: async () => { midFail.framesFlowed = 512; throw new Error("mid"); },
      stop: () => {},
      levels: () => null,
      progress: () => null,
      active: false,
    };
    __setTtsPlayerForTests(midFail as never);
    await speak("quiet me");
    expect(spoken).toEqual([]);
  } finally {
    if (prevSpeech === undefined) delete g["speechSynthesis"];
    else g["speechSynthesis"] = prevSpeech;
    __setTtsPlayerForTests(null);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/audioBus.spec.ts`
Expected: FAIL with "`ttsLevels` is not exported from '@/lib/voice'".

- [ ] **Step 3: Write minimal implementation**

```ts
import { streamTts } from "@/lib/api/ttsClient";
import { TtsPlayer } from "@/lib/ttsPlayer";

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
```

`speak`: wrap the existing synthesis body unchanged into `speakViaSynthesis(text)`.
New `speak` enforces the two-phase rule via `framesFlowed` (Task 2): only
pre-flow failures fall back; mid-playback failures resolve quietly.

```ts
export function speak(text: string): Promise<void> {
  if (!text.trim()) return Promise.resolve();
  return speakViaTts(text).catch((err) => {
    if (player().framesFlowed > 0) return; // phase 2: stay quiet, no second voice
    return speakViaSynthesis(text);
  });
}

async function speakViaTts(text: string): Promise<void> {
  const lang = currentLang();
  const stream = await streamTts(text, lang);
  await player().play(stream);
}
```

`speakProgress`: `const tp = ttsPlayer?.progress() ?? null; if (tp !== null)
return tp;` then legacy math. `stopSpeaking`: `ttsPlayer?.stop()` first, then
legacy reset + cancel. `currentLang()` reads
`useFridayStore`? No — `voice.ts` must not import the store (cycle risk:
store imports audioBus types only, but keep voice store-free). Read
`localStorage["friday.lang"]` directly with try/catch, default `"en-US"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/audioBus.spec.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/voice.ts tests/unit/audioBus.spec.ts
git commit -m "feat(tts): TTS-first speak with synthesis fallback"
```

---

### Task 4: `FridayCore` wiring + worklet file + UI stub coverage

**Files:**
- Create: `public/audio/tts-worklet.js`
- Modify: `src/components/friday/core/FridayCore.tsx`, `tests/ui/stubOrchestrator.ts`, `tests/ui/friday.spec.ts` (append one TTS test)
- Test: UI (`npm run test:ui -- tests/ui/friday.spec.ts -g "tts"`)

**Interfaces:**
- Consumes: `ttsLevels` from Task 3.

Worklet (`public/audio/tts-worklet.js`, trivial by design — no unit test):

```js
class TtsPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.port.onmessage = (e) => {
      if (e.data.type === "feed") this.queue.push(e.data.samples);
      if (e.data.type === "stop") this.queue.length = 0;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    let consumed = 0;
    for (let i = 0; i < out.length; i++) {
      const chunk = this.queue[0];
      if (!chunk || chunk._i >= chunk.length) {
        if (chunk) this.queue.shift();
        const next = this.queue[0];
        if (!next) { out[i] = 0; continue; }
        next._i = 0;
      }
      const cur = this.queue[0];
      out[i] = cur[cur._i++];
      consumed++;
    }
    if (consumed > 0) this.port.postMessage({ type: "consumed", count: consumed });
    if (this.queue.length < 4) this.port.postMessage({ type: "ready" });
    return true;
  }
}
registerProcessor("tts-player", TtsPlayerProcessor);
```

`FridayCore.tsx`: add a `ttsCache` ref mirroring `micCache`, and
`getTtsLevel(bin, t)` reading `ttsLevels(96)`; the SPEAKING branch becomes
`ttsLevels`-first, envelope-fallback (keep the existing `speakProgress() ===
null → null` synth fallback — now reached only when TTS is inactive AND no
utterance is tracked):

```tsx
const getTtsLevel = (bin: number, t: number): number | null => {
  if (!ttsCache.current || ttsCache.current.t !== t) {
    ttsCache.current = { t, levels: ttsLevels(96) };
  }
  return ttsCache.current.levels?.[bin] ?? null;
};
// SPEAKING branch:
state === "speaking"
  ? (bin: number, t: number) => {
      const real = getTtsLevel(bin, t);
      if (real !== null) return real;
      const p = speakProgress();
      if (p === null) return null;
      return utteranceEnvelope(p);
    }
  : undefined
```

UI stub: `tests/ui/stubOrchestrator.ts` gains `POST /tts` returning a
length-prefixed header (`{sampleRate: 24000, channels: 1, totalSamples: 4800}`)
plus 0.2 s of 440 Hz sine PCM, then the appended `friday.spec.ts` test posts
a voice turn and asserts the SPEAKING waveform pixels differ from a synth-only
baseline capture and the flow order still ends at IDLE.

- [ ] **Step 1: Write the failing UI test** (append to `tests/ui/friday.spec.ts`;
  stub route first so it fails on pixels, not on 404)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:ui -- tests/ui/friday.spec.ts -g "tts drives the waveform"`
Expected: FAIL (no TTS path yet — waveform stays synth).

- [ ] **Step 3: Implement** (worklet file + FridayCore branch + stub route)

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:ui -- tests/ui/friday.spec.ts -g "tts drives the waveform"`
Expected: PASS. Then: `npm run test:unit` full — all green.

- [ ] **Step 5: Commit**

```bash
git add public/audio/tts-worklet.js src/components/friday/core/FridayCore.tsx tests/ui/stubOrchestrator.ts tests/ui/friday.spec.ts
git commit -m "feat(tts): wire real analyser levels into SPEAKING waveform"
```
