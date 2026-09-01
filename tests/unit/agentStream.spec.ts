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
