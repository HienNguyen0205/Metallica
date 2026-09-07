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
