import type { FridayStore } from "@/lib/store";
import { planVisualization, summarize } from "@/lib/vizPlanner";
import { speak, stopSpeaking } from "@/lib/voice";
import {
  streamQuery,
  confirmDecision,
  warnIfMisconfigured,
  OrchestratorRefused,
} from "@/lib/api/fridayClient";
import type { FridayEvent } from "@/lib/agent/events";
import { normalizeVisualization } from "@/lib/visualization/normalization";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FlowStore = Pick<
  FridayStore,
  | "transition"
  | "setAnswer"
  | "setPendingConfirm"
  | "addVisualization"
  | "clearVisualizations"
  | "setToolActivity"
  | "setDeniedTool"
  | "setSessionError"
  | "setLiveMode"
  | "addMemory"
  | "clearMemories"
>;

/**
 * Central event dispatcher — single place where BE events become store mutations.
 * This is the `typed FridayEvent → Zustand` bridge from §4/§5.
 */
function dispatch(store: FlowStore, event: FridayEvent): void {
  switch (event.type) {
    case "state":
      store.transition(event.state);
      break;
    case "tool":
      store.setToolActivity({ tool: event.tool, risk: event.risk });
      // clear previous denied marker when a new tool starts
      store.setDeniedTool(null);
      break;
    case "viz": {
      const spec = normalizeVisualization(event.spec);
      // §8 — multiple viz: materialize immediately, don't remount previous
      store.addVisualization(spec);
      break;
    }
    case "confirm":
      store.setPendingConfirm(event);
      break;
    case "denied":
      store.setDeniedTool(event.tool);
      store.setToolActivity(null);
      break;
    case "answer":
      store.setAnswer(event.text);
      break;
    case "error":
      store.setSessionError(event.message);
      console.warn("[friday]", event.message);
      break;
    case "memory":
      store.addMemory(event);
      break;
    case "done":
      store.setToolActivity(null);
      break;
  }
}

/**
 * §9 — drives the state machine from backend events.
 * Falls back to the local rules planner when the orchestrator is unreachable.
 *
 * `voice` is set when the question arrived through the microphone, and only
 * then is the answer read back. A typed question gets a silent reply — nobody
 * types at a machine expecting it to start talking.
 */
export async function runQuery(
  store: FlowStore,
  query: string,
  { signal, voice = false }: { signal?: AbortSignal; voice?: boolean } = {},
) {
  const { setAnswer, setPendingConfirm } = store;

  setAnswer(null);
  store.clearVisualizations();
  setPendingConfirm(null);
  store.setDeniedTool(null);
  store.clearMemories();
  store.setSessionError(null);
  store.setToolActivity(null);
  store.setLiveMode("connecting");
  stopSpeaking();
  warnIfMisconfigured();

  let spoken: string | null = null;
  let hadLiveStream = false;

  try {
    await streamQuery(query, {
      signal,
      onEvent: (ev) => {
        hadLiveStream = true;
        // first successful event confirms liveness
        store.setLiveMode("live");
        if (ev.type === "answer") spoken = ev.text;
        dispatch(store, ev);
      },
      onError: (msg) => {
        console.warn("[friday]", msg);
      },
    });
    // If stream never yielded anything, treat as unreachable to trigger fallback?
    // But stub tests rely on empty-data path not happening; so only fallback on throw.
    if (!hadLiveStream) throw new Error("empty stream");
  } catch (err) {
    if ((err as Error).name === "AbortError" || signal?.aborted) return;
    // If we already streamed something, don't fallback — just surface error
    if (hadLiveStream) {
      console.warn("[friday] stream interrupted:", err);
      store.setSessionError(err instanceof Error ? err.message : String(err));
      store.transition("error");
      await wait(1200);
      store.transition("idle");
      return;
    }
    // A refusal is not an outage. The orchestrator is up and said no, so the
    // offline demo path would replace a real limit with a fabricated answer.
    if (err instanceof OrchestratorRefused) {
      const wait_s = err.retryAfter ? ` — retry in ${Math.ceil(err.retryAfter / 60)} min` : "";
      store.setSessionError(`${err.message}${wait_s}`);
      store.setLiveMode("idle");
      store.transition("error");
      await wait(1600);
      store.transition("idle");
      return;
    }

    console.warn("[friday] orchestrator unreachable, using local rules planner:", err);
    store.setLiveMode("offline");
    await runLocal(store, query, voice);
    return;
  }

  // The answer is held until it has been read out, rather than for a fixed
  // beat — a two-sentence reply outlasts 3.6s and would otherwise be cleared,
  // and the HUD returned to IDLE, while FRIDAY was still talking.
  if (spoken) await (voice ? speak(spoken) : wait(3600));
  store.transition("idle");
  setAnswer(null);
  // Viz persists until the next query (§8 history): the turn-start
  // clearVisualizations() above is the only place that wipes the scene, so the
  // operator can keep inspecting the hologram at idle.
  setPendingConfirm(null);
  store.setToolActivity(null);
  store.setDeniedTool(null);
  store.setLiveMode("idle");
}

/** §11 — send the operator's decision so the blocked tool call can proceed. */
export async function decide(id: string, approved: boolean) {
  try {
    await confirmDecision(id, approved);
  } catch (err) {
    console.warn("[friday] could not deliver decision:", err);
  }
}

/** The pre-backend scripted flow, kept as the offline demo path. */
async function runLocal(store: FlowStore, query: string, voice = false) {
  const { transition, setAnswer } = store;

  transition("thinking");
  await wait(800);
  transition("searching");
  await wait(700);
  transition("tool_execution");
  store.setToolActivity({ tool: "get_system_metrics", risk: "low" });
  await wait(700);
  transition("processing");
  store.setToolActivity(null);
  await wait(500);

  const spec = planVisualization(query);
  transition("visualizing");
  store.addVisualization(spec);
  await wait(1500);

  const answer = summarize(spec);
  transition("speaking");
  setAnswer(answer);
  await (voice ? speak(answer) : wait(3600));

  transition("idle");
  setAnswer(null);
  store.setLiveMode("idle");
}
