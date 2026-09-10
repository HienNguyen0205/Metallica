import { test, expect } from "@playwright/test";
import { runQuery } from "@/lib/agentStream";
import type { FridayStore } from "@/lib/store";

/**
 * The turn-start reset for the LEARNED line.
 *
 * `memories` was cleared only by `store.reset()`, which nothing under `src/`
 * ever calls — so a fact learned once stayed on the HUD forever, through every
 * later turn and at idle. An alert that is always on is not an alert.
 *
 * `runQuery` takes a plain `Pick<FridayStore, ...>`, so a recorder satisfies it
 * without a store or a DOM. An already-aborted signal makes `streamQuery` bail
 * on the first `fetch` and `runQuery` return before the offline fallback, which
 * keeps this to the turn-start block and off the network entirely.
 */
function recorder() {
  const calls: string[] = [];
  const note = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    transition: note("transition"),
    endTurn: note("endTurn"),
    setAnswer: note("setAnswer"),
    setPendingConfirm: note("setPendingConfirm"),
    addVisualization: note("addVisualization"),
    clearVisualizations: note("clearVisualizations"),
    setToolActivity: note("setToolActivity"),
    setDeniedTool: note("setDeniedTool"),
    setSessionError: note("setSessionError"),
    setLiveMode: note("setLiveMode"),
    addMemory: note("addMemory"),
    clearMemories: note("clearMemories"),
  };
}

test("a new turn clears the learned-memory line", async () => {
  const store = recorder();
  await runQuery(store as unknown as FridayStore, "q", { signal: AbortSignal.abort() });

  expect(store.calls, "memories survive every turn if nothing clears them").toContain(
    "clearMemories",
  );
  // It belongs with the other turn-start resets, not somewhere after the
  // stream has already started painting the HUD.
  expect(store.calls.indexOf("clearMemories")).toBeLessThan(store.calls.indexOf("setLiveMode"));
});

test("aborting during the offline fallback stops the local run early", async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const store = recorder();
  const controller = new AbortController();
  const started = Date.now();
  const p = runQuery(store as unknown as FridayStore, "cpu load trend", {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await p;
  const elapsed = Date.now() - started;
  // Turn-start reset calls setAnswer(null) once; the offline answer must never follow.
  expect(store.calls.filter((c) => c === "setAnswer")).toHaveLength(1);
  expect(store.calls).not.toContain("addVisualization");
  // Full offline run takes FLOW_TIMING waits (~4.2s) + answerHold (3.6s);
  // an aborted run must return well before that.
  expect(elapsed).toBeLessThan(3000);
});

test("duplicate enveloped events do not double-apply", async () => {
  const envelope = (innerEvent: string, payload: unknown, sequence: number) =>
    JSON.stringify({
      version: 1,
      run_id: "run_dup",
      session_id: "sess_1",
      turn_id: "turn_1",
      sequence,
      timestamp: "2026-09-10T02:00:00Z",
      event: innerEvent,
      payload,
    });
  const sse =
    [
      `event: viz\ndata: ${envelope("viz", { type: "bar_3d", title: "X" }, 1)}`,
      `event: viz\ndata: ${envelope("viz", { type: "bar_3d", title: "X" }, 1)}`,
      `event: done\ndata: ${envelope("done", {}, 2)}`,
    ].join("\n\n") + "\n\n";
  const prevFetch = (globalThis as unknown as { fetch: unknown }).fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const store = recorder();
    await runQuery(store as unknown as FridayStore, "q");
    expect(store.calls.filter((c) => c === "addVisualization")).toHaveLength(1);
    expect(store.calls).toContain("endTurn");
  } finally {
    (globalThis as unknown as { fetch: unknown }).fetch = prevFetch;
  }
});
