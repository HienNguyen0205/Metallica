import { test, expect } from "@playwright/test";
import { streamTts, type TtsStream } from "@/lib/api/ttsClient";
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

test("truncated second prefix is malformed", async () => {
  const header = new TextEncoder().encode(JSON.stringify({ sampleRate: 24000, channels: 1 }));
  const full = frames([header]);
  const truncated = new Uint8Array([...full, 0x04, 0x00]);
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(streamOf(truncated), { status: 200 });
  const s = await streamTts("x", "en-US");
  await expect((async () => { for await (const c of s.chunks) void c; })()).rejects.toMatchObject({
    name: "TtsError",
    kind: "malformed",
  });
});

test("high-bit frame length is malformed, not a RangeError", async () => {
  const header = new TextEncoder().encode(JSON.stringify({ sampleRate: 24000, channels: 1 }));
  const full = frames([header]);
  const bad = new Uint8Array([...full, 0xff, 0xff, 0xff, 0xff]);
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(streamOf(bad), { status: 200 });
  const s = await streamTts("x", "en-US");
  await expect((async () => { for await (const c of s.chunks) void c; })()).rejects.toMatchObject({
    name: "TtsError",
    kind: "malformed",
  });
});

test("aborted header read rejects with AbortError", async () => {
  const header = new TextEncoder().encode(JSON.stringify({ sampleRate: 24000, channels: 1 }));
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(streamOf(frames([header])), { status: 200 });
  const controller = new AbortController();
  controller.abort();
  await expect(streamTts("x", "en-US", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
});

test("explicit null totalSamples becomes null", async () => {
  const header = new TextEncoder().encode(
    JSON.stringify({ sampleRate: 24000, channels: 1, totalSamples: null }),
  );
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(streamOf(frames([header])), { status: 200 });
  const s = await streamTts("x", "en-US");
  expect(s.header.totalSamples).toBeNull();
});

import { TtsPlayer } from "@/lib/ttsPlayer";

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
    connect: () => {},
    disconnect: () => {},
  };
  const node = { port, connect: () => {}, disconnect: () => {} };
  const context = {
    state: "running",
    resume: async () => {},
    sampleRate: 24000,
    audioWorklet: { addModule: async () => {} },
    createAnalyser: () => analyser,
    destination: {},
  };
  return {
    createContext: () => context,
    createNode: () => node,
    workletUrl: "/fake.js",
  };
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

test("resolves on unknown total once the queue drains", async () => {
  const record = { posted: 0, consumed: 0 };
  const player = new TtsPlayer(fakeDeps(record) as never);
  const stream: TtsStream = {
    header: { sampleRate: 24000, channels: 1, totalSamples: null },
    chunks: gen([pcmChunk([10, 20, 30]), pcmChunk([40])]),
  };
  await player.play(stream);
  expect(record.posted).toBe(4);
  expect(record.consumed).toBe(4);
  expect(player.framesFlowed).toBe(4);
  expect(player.progress()).toBeNull();
  expect(player.active).toBe(true);
  player.stop();
  expect(player.active).toBe(false);
  expect(player.levels(4)).toBeNull();
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function gatedStream(first: Uint8Array): {
  chunks: AsyncGenerator<Uint8Array, void, void>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  async function* chunks(): AsyncGenerator<Uint8Array, void, void> {
    yield first;
    await gate;
  }
  return { chunks: chunks(), release };
}

type MsgHandler = (e: { data: unknown }) => void;

interface ManualPort {
  postMessage: (msg: unknown) => void;
  addEventListener: (t: string, fn: MsgHandler) => void;
  close: () => void;
  handlers: MsgHandler[];
}

function emit(port: ManualPort, data: unknown): void {
  for (const fn of port.handlers) fn({ data });
}

/** Fake ports with inspectable handlers; ready mode "once" replies ready only to the first feed. */
function manualDeps(mode: "always" | "once" = "always"): {
  deps: {
    createContext: () => unknown;
    createNode: () => unknown;
    workletUrl: string;
  };
  ports: ManualPort[];
  record: { posted: number; consumed: number };
} {
  const record = { posted: 0, consumed: 0 };
  const ports: ManualPort[] = [];
  let feeds = 0;
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 4,
    getByteFrequencyData: (arr: Uint8Array) => {
      arr.fill(200);
    },
    connect: () => {},
    disconnect: () => {},
  };
  const context = {
    state: "running",
    resume: async () => {},
    sampleRate: 24000,
    audioWorklet: { addModule: async () => {} },
    createAnalyser: () => analyser,
    destination: {},
  };
  const deps = {
    createContext: () => context,
    createNode: () => {
      const port: ManualPort = {
        handlers: [],
        postMessage: (msg: unknown) => {
          const m = msg as { type: string; samples?: Float32Array };
          if (m.type !== "feed") return;
          const n = m.samples?.length ?? 0;
          feeds++;
          record.posted += n;
          const thisFeed = feeds;
          queueMicrotask(() => {
            record.consumed += n;
            for (const fn of port.handlers) fn({ data: { type: "consumed", count: n } });
            if (mode === "always" || thisFeed === 1) {
              for (const fn of port.handlers) fn({ data: { type: "ready" } });
            }
          });
        },
        addEventListener: (t: string, fn: MsgHandler) => {
          if (t === "message") port.handlers.push(fn);
        },
        close: () => {},
      };
      ports.push(port);
      return { port, connect: () => {}, disconnect: () => {} };
    },
    workletUrl: "/fake.js",
  };
  return { deps, ports, record };
}

test("abort after partial playback preserves framesFlowed", async () => {
  const record = { posted: 0, consumed: 0 };
  const player = new TtsPlayer(fakeDeps(record) as never);
  const g = gatedStream(pcmChunk([5, 6, 7]));
  const p = player.play({
    header: { sampleRate: 24000, channels: 1, totalSamples: null },
    chunks: g.chunks,
  });
  await waitFor(() => player.framesFlowed === 3);
  player.stop();
  g.release();
  await expect(p).rejects.toMatchObject({ name: "AbortError" });
  expect(player.framesFlowed).toBe(3);
  expect(player.active).toBe(false);
  expect(player.levels(2)).toBeNull();
});

test("corrupt chunk tears down the graph but keeps framesFlowed", async () => {
  const record = { posted: 0, consumed: 0 };
  const player = new TtsPlayer(fakeDeps(record) as never);
  const stream: TtsStream = {
    header: { sampleRate: 24000, channels: 1, totalSamples: 100 },
    chunks: gen([pcmChunk([1, 2]), new Uint8Array([0x01])]),
  };
  await expect(player.play(stream)).rejects.toThrow(/malformed/);
  expect(player.active).toBe(false);
  expect(player.levels(4)).toBeNull();
  expect(player.framesFlowed).toBe(2);
  expect(player.progress()).toBeNull();
});

test("stale-port consumed is ignored by the new play", async () => {
  const { deps, ports } = manualDeps("always");
  const player = new TtsPlayer(deps as never);
  const g1 = gatedStream(pcmChunk([1, 2]));
  const p1 = player.play({
    header: { sampleRate: 24000, channels: 1, totalSamples: 100 },
    chunks: g1.chunks,
  });
  await waitFor(() => player.framesFlowed === 2 && ports.length >= 1);
  const p2 = player.play({
    header: { sampleRate: 24000, channels: 1, totalSamples: 10 },
    chunks: gen([pcmChunk([7, 8])]),
  });
  await waitFor(() => ports.length >= 2);
  emit(ports[0]!, { type: "consumed", count: 1000 });
  emit(ports[0]!, { type: "ready" });
  g1.release();
  await expect(p1).rejects.toMatchObject({ name: "AbortError" });
  await p2;
  expect(player.framesFlowed).toBe(2);
  expect(player.progress()).toBeCloseTo(0.2, 5);
});

test("truncated known-total stream resolves with progress below 1", async () => {
  const record = { posted: 0, consumed: 0 };
  const player = new TtsPlayer(fakeDeps(record) as never);
  const stream: TtsStream = {
    header: { sampleRate: 24000, channels: 1, totalSamples: 100 },
    chunks: gen([pcmChunk([1, 2, 3, 4])]),
  };
  await player.play(stream);
  expect(record.posted).toBe(4);
  expect(player.framesFlowed).toBe(4);
  expect(player.progress()).toBeCloseTo(0.04, 5);
});

test("backpressure wait survives a ready that arrived with no waiter", async () => {
  const { deps, record } = manualDeps("once");
  const player = new TtsPlayer(deps as never);
  const big = Array.from({ length: 9000 }, (_, i) => i % 1000);
  const stream: TtsStream = {
    header: { sampleRate: 24000, channels: 1, totalSamples: null },
    chunks: gen([pcmChunk(Array.from({ length: 100 }, () => 1)), pcmChunk(big)]),
  };
  await player.play(stream);
  expect(record.posted).toBe(9100);
  expect(record.consumed).toBe(9100);
  expect(player.framesFlowed).toBe(9100);
});
