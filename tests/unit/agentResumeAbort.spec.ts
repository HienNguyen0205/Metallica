import { test, expect } from "@playwright/test";
import { runQuery } from "@/lib/agentStream";
import type { FridayStore } from "@/lib/store";

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    transition: () => void calls.push("transition"),
    endTurn: () => void calls.push("endTurn"),
    setAnswer: () => void calls.push("setAnswer"),
    setPendingConfirm: () => void calls.push("setPendingConfirm"),
    addVisualization: () => void calls.push("addVisualization"),
    clearVisualizations: () => void calls.push("clearVisualizations"),
    setToolActivity: () => void calls.push("setToolActivity"),
    setDeniedTool: () => void calls.push("setDeniedTool"),
    setSessionError: () => void calls.push("setSessionError"),
    setLiveMode: () => void calls.push("setLiveMode"),
    addMemory: () => void calls.push("addMemory"),
    clearMemories: () => void calls.push("clearMemories"),
    setCurrentStep: () => void calls.push("setCurrentStep"),
  };
}

test("aborted replay writes nothing after cancel", async () => {
  const envelope = (innerEvent: string, payload: unknown, sequence: number) =>
    JSON.stringify({
      version: 1,
      run_id: "run_abort",
      session_id: "sess_1",
      turn_id: "turn_1",
      sequence,
      timestamp: "2026-09-10T02:00:00Z",
      event: innerEvent,
      payload,
    });
  const firstFrame = `event: state\ndata: ${envelope("state", { state: "thinking" }, 1)}\n\n`;
  const replayBody = JSON.stringify({
    run_id: "run_abort",
    status: "completed",
    terminal: true,
    events: [{ sequence: 2, event: "answer", payload: { text: "RESURRECTED" } }],
  });
  const prevFetch = (globalThis as unknown as { fetch: unknown }).fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
    const u = String(url);
    if (u.includes("/events")) {
      // Slow replay so abort lands before/in dispatch.
      await new Promise((r) => setTimeout(r, 80));
      return new Response(replayBody, { status: 200 });
    }
    // One live frame then a transport error -> hadLiveStream=true + throw -> tryResume.
    // Error at 5ms triggers resume; abort at 20ms lands mid-replay (replay 80ms).
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(firstFrame));
        setTimeout(() => {
          try {
            c.error(new Error("mid-stream boom"));
          } catch {
            /* already closed */
          }
        }, 5);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const store = recorder();
    const controller = new AbortController();
    const p = runQuery(store as unknown as FridayStore, "q", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await p;
    // Turn-start calls setAnswer(null) once; replayed RESURRECTED must never add a second.
    expect(store.calls.filter((c) => c === "setAnswer")).toHaveLength(1);
  } finally {
    (globalThis as unknown as { fetch: unknown }).fetch = prevFetch;
  }
});
