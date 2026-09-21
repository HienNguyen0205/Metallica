import { test, expect } from "@playwright/test";
import { buildClientContext } from "@/lib/clientContext";
import { streamQuery } from "@/lib/api/fridayClient";

test("raw browser readings map to the wire shape, in wire units", () => {
  const ctx = buildClientContext({
    cores: 8,
    deviceMemory: 16,
    pressure: "fair",
    battery: { level: 0.973, charging: true },
    storage: { usage: 120_512_000, quota: 4_800_000_000 },
    connection: { effectiveType: "4g", downlink: 0.25, rtt: 150 },
    heapBytes: 42_100_000,
    gpu: { vendor: "intel", architecture: "gen-9" },
    platform: "Windows",
    timezone: "Asia/Saigon",
    languages: ["en-US", "vi"],
    screen: { width: 1536, height: 864, dpr: 1.25 },
  });
  expect(ctx).toEqual({
    cpu_cores: 8,
    device_memory_gb: 16,
    cpu_pressure: "fair",
    battery: { level_pct: 97, charging: true },
    storage: { usage_mb: 120.5, quota_mb: 4800 },
    network: { effective_type: "4g", downlink_mbps: 0.25, rtt_ms: 150 },
    js_heap_mb: 42.1,
    gpu: { vendor: "intel", architecture: "gen-9" },
    platform: "Windows",
    timezone: "Asia/Saigon",
    languages: ["en-US", "vi"],
    screen: { width: 1536, height: 864, dpr: 1.25 },
  });
});

test("missing or junk readings are dropped, never sent as zero", () => {
  expect(buildClientContext({})).toEqual({});
  const ctx = buildClientContext({
    cores: Number.NaN,
    pressure: "melting",
    battery: { level: Number.POSITIVE_INFINITY, charging: false },
    storage: { usage: 10, quota: 0 },
    connection: { effectiveType: "5g" },
    platform: "",
    languages: ["a", "b", "c", "d", "e", "f", "g"],
  });
  // Values the orchestrator would reject are left out rather than failing it.
  expect(ctx).toEqual({ languages: ["a", "b", "c", "d", "e"] });
});

test("long strings are clipped to the orchestrator's bounds", () => {
  const ctx = buildClientContext({ platform: "x".repeat(100), gpu: { vendor: "v".repeat(100) } });
  expect(ctx.platform).toHaveLength(40);
  expect(ctx.gpu?.vendor).toHaveLength(40);
});

test("streamQuery sends the client context with the question", async () => {
  let body: Record<string, unknown> = {};
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response("event: done\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    await streamQuery("my battery?", { onEvent: () => {}, client: { cpu_cores: 8 } });
  } finally {
    globalThis.fetch = prevFetch;
  }
  expect(body.query).toBe("my battery?");
  expect(body.client).toEqual({ cpu_cores: 8 });
});

test("a shared location keeps the browser's precision and accuracy radius", () => {
  expect(buildClientContext({ location: { lat: 10.776889, lon: 106.700806, accuracy: 12.5 } }).location).toEqual({
    lat: 10.776889,
    lon: 106.700806,
    accuracy_m: 12.5,
  });
  expect(buildClientContext({ location: { lat: 95, lon: 0 } }).location).toBeUndefined();
  expect(buildClientContext({ location: { lat: Number.NaN, lon: 1 } }).location).toBeUndefined();
});

test("the UTC offset is sent east-positive, the way the clock tool reads it", () => {
  // getTimezoneOffset() is west-positive: Asia/Saigon reports -420.
  expect(buildClientContext({ tzOffsetMin: -420 }).utc_offset_min).toBe(420);
  expect(buildClientContext({ tzOffsetMin: 9999 }).utc_offset_min).toBeUndefined();
});
