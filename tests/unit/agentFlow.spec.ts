import { test, expect } from "@playwright/test";
import { runQuery } from "@/lib/agentStream";
import { useFridayStore } from "@/lib/store";

/**
 * `runQuery` fetches from the orchestrator directly, so the unit project can
 * drive all three transport branches by stubbing `globalThis.fetch` — no
 * browser, no server, and crucially no collision with a real backend.
 */

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  useFridayStore.getState().reset();
});

function sseResponse(frames: string, init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(frames));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

const HAPPY_STREAM =
  'event: state\ndata: {"state":"thinking"}\n\n' +
  'event: viz\ndata: {"type":"radial_gauge","title":"SYS","data":{"metrics":[{"label":"CPU","value":50}]}}\n\n' +
  'event: answer\ndata: {"text":"All nominal"}\n\n' +
  "event: done\ndata: {}\n\n";

test("a live stream dispatches state, viz and answer, then lands idle", async () => {
  globalThis.fetch = (async () => sseResponse(HAPPY_STREAM)) as typeof fetch;
  const store = useFridayStore.getState();

  await runQuery(store, "system status");

  const s = useFridayStore.getState();
  expect(s.answer).toBe("All nominal");
  expect(s.visualizations).toHaveLength(1);
  expect(s.visualizations[0]?.spec.type).toBe("radial_gauge");
  expect(s.state).toBe("idle");
  expect(s.liveMode).toBe("idle");
  expect(s.sessionError).toBeNull();
});

test("a 429 refusal never falls back to the canned planner", async () => {
  globalThis.fetch = (async () =>
    new Response("limited", { status: 429, headers: { "retry-after": "120" } })) as typeof fetch;
  const store = useFridayStore.getState();

  await runQuery(store, "system status");

  const s = useFridayStore.getState();
  // THE invariant this class exists for: a refusal must not be answered with
  // fabricated numbers — the scene stays empty and the error is surfaced.
  expect(s.visualizations).toHaveLength(0);
  expect(s.answer).toBeNull();
  expect(s.sessionError).toContain("rate limited");
  expect(s.sessionError).toContain("2 min");
  expect(s.state).toBe("idle");
});

test("an unreachable orchestrator falls back to the offline planner", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const store = useFridayStore.getState();

  await runQuery(store, "how is system health");

  const s = useFridayStore.getState();
  expect(s.visualizations).toHaveLength(1);
  // offline planner answers with health_core for that phrasing
  expect(s.visualizations[0]?.spec.type).toBe("health_core");
  expect(s.answer).toBeTruthy();
  expect(s.state).toBe("idle");
});

test("an interrupted stream after events surfaces the error without fallback", async () => {
  globalThis.fetch = (async () => sseResponse(HAPPY_STREAM.slice(0, 60))) as typeof fetch;
  const store = useFridayStore.getState();

  await runQuery(store, "system status");

  const s = useFridayStore.getState();
  // some events landed, so no canned substitution — the error is shown instead
  expect(s.sessionError).toBeTruthy();
  expect(s.answer).toBeNull();
  expect(s.state).toBe("idle");
});

test("a stream that ends cleanly but never says done reports the early exit", async () => {
  // full state event, no `done` — the pipeline died quietly after thinking
  globalThis.fetch = (async () =>
    sseResponse('event: state\ndata: {"state":"thinking"}\n\n')) as typeof fetch;
  const store = useFridayStore.getState();

  await runQuery(store, "system status");

  const s = useFridayStore.getState();
  expect(s.sessionError).toContain("ended the turn early");
  // and the machine must land idle regardless of where the stream stopped
  expect(s.state).toBe("idle");
});
