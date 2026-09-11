import { test, expect } from "@playwright/test";
import { runQuery, cancelActiveRun } from "@/lib/agentStream";
import { useFridayStore } from "@/lib/store";

/**
 * P0.3 — the enveloped-v2 chain end to end:
 * BE v2 frame -> SSE -> unwrapEnvelope -> StreamGuard -> parseFridayEvent ->
 * store -> state machine -> idle. Frames below mirror the backend's
 * `sse_envelope` output field for field (version/run/session/turn/sequence/Z
 * timestamp), so any drift in the real wire form breaks here first.
 */

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  useFridayStore.getState().reset();
});

const RUN = "run_e2e_1";
let seq = 0;
function envelope(event: string, payload: unknown): string {
  seq += 1;
  const body = {
    version: 1,
    run_id: RUN,
    session_id: "sess_1",
    turn_id: "turn_1",
    sequence: seq,
    timestamp: "2026-09-11T02:00:00Z",
    event,
    payload,
  };
  return `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
}

function sseResponse(frames: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(frames));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function happyTranscript(): string {
  seq = 0;
  return (
    envelope("state", { state: "thinking" }) +
    envelope("tool", { tool: "get_system_metrics", risk: "low" }) +
    envelope("step", { step_id: "s1", turn_id: "turn_1", kind: "tool", status: "running", tool: "get_system_metrics" }) +
    envelope("step", { step_id: "s1", turn_id: "turn_1", kind: "tool", status: "completed", summary: "CPU 73%" }) +
    envelope("memory", { id: 7, fact: "CPU hotspot on db-1", provenance: "tool" }) +
    envelope("state", { state: "visualizing" }) +
    envelope("viz", { type: "bar_3d", title: "TOP PROCESSES", data: { series: [{ label: "MEM", points: [10, 5] }] } }) +
    envelope("state", { state: "speaking" }) +
    envelope("answer", { text: "CPU 73 percent." }) +
    envelope("done", {})
  );
}

test("a full enveloped v2 turn lands on the HUD and idles clean", async () => {
  globalThis.fetch = (async () => sseResponse(happyTranscript())) as typeof fetch;
  const store = useFridayStore.getState();

  await runQuery(store, "system status");

  const s = useFridayStore.getState();
  expect(s.answer).toBe("CPU 73 percent.");
  expect(s.visualizations).toHaveLength(1);
  expect(s.visualizations[0]?.spec.type).toBe("bar_3d");
  expect(s.currentStep).toMatchObject({ stepId: "s1", status: "completed", summary: "CPU 73%" });
  expect(s.memories).toHaveLength(1);
  expect(s.memories[0]).toMatchObject({ id: 7, provenance: "tool" });
  expect(s.state).toBe("idle");
  expect(s.liveMode).toBe("idle");
  expect(s.sessionError).toBeNull();
});

test("a rejected envelope surfaces in the store instead of dying silently", async () => {
  seq = 0;
  const bad = `event: state\ndata: ${JSON.stringify({ version: 2, event: "state", payload: { state: "thinking" } })}\n\n`;
  // NOTE: streamQuery breaks at `done`, so a bad frame after it would never
  // arrive — inject it mid-stream instead, before the answer.
  const frames = happyTranscript().split("\n\n").filter(Boolean);
  const injected = [...frames.slice(0, 8), bad.trim(), ...frames.slice(8)].join("\n\n") + "\n\n";
  globalThis.fetch = (async () => sseResponse(injected)) as typeof fetch;
  const store = useFridayStore.getState();

  await runQuery(store, "system status");

  const s = useFridayStore.getState();
  // the turn still completes — one bad frame is skipped, not fatal ...
  expect(s.answer).toBe("CPU 73 percent.");
  expect(s.state).toBe("idle");
  // ... but the contract violation is visible, not console-only
  expect(s.sessionError).toContain("protocol error");
});

test("cancelActiveRun stops the server run mid-turn and is a no-op after done", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/cancel")) return new Response("{}", { status: 200 });
    // an endless enveloped stream: thinking, then silence (no done)
    seq = 0;
    const head =
      `event: state\ndata: ${JSON.stringify({ version: 1, run_id: "run_cancel_1", session_id: "s", turn_id: "turn_1", sequence: 1, timestamp: "2026-09-11T02:00:00Z", event: "state", payload: { state: "thinking" } })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(head));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const done = runQuery(useFridayStore.getState(), "q", { signal: controller.signal });
    // let the thinking frame land so the run id is tracked
    for (let i = 0; i < 200 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    const cancelled = await cancelActiveRun();
    expect(cancelled).toBe("run_cancel_1");
    expect(calls).toContainEqual({ url: expect.stringContaining("/runs/run_cancel_1/cancel"), method: "POST" });
    // second call finds nothing to cancel
    expect(await cancelActiveRun()).toBeNull();
    controller.abort();
    await done;
  } finally {
    globalThis.fetch = prevFetch;
  }
});
