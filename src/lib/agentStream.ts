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

/** All flow timing in one place — tuning the demo/UX never hunts magic numbers. */
export const FLOW_TIMING = {
  streamInterrupted: 1200,
  refused: 1600,
  answerHold: 3600,
  localThinking: 800,
  localSearching: 700,
  localTool: 700,
  localProcessing: 500,
  localVisualizing: 1500,
} as const;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Voice turns await the utterance before landing idle. Barge-in and cancel
 * abort it via stopSpeaking() — an AbortError there is intentional silence,
 * not a turn failure, so it must not surface as a session error.
 */
async function speakUnlessAborted(text: string): Promise<void> {
  try {
    await speak(text);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
    throw err;
  }
}

function log(...args: unknown[]) {
  console.warn("[friday]", ...args);
}

type FlowStore = Pick<
  FridayStore,
  | "transition"
  | "endTurn"
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
function dispatch(store: FlowStore, event: FridayEvent, flags: { doneSeen: boolean }): void {
  switch (event.type) {
    case "state":
      store.transition(event.state);
      break;
    case "tool":
      store.setToolActivity({ tool: event.tool, risk: event.risk });
      // clear previous denied marker when a new tool starts
      store.setDeniedTool(null);
      break;
    case "preview": {
      const spec = normalizeVisualization(event.spec);
      // §8/§18 — early materialize; replaced when the real spec arrives.
      store.addVisualization(spec, { preview: true });
      break;
    }
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
      log(event.message);
      break;
    case "memory":
      store.addMemory(event);
      break;
    case "done":
      store.setToolActivity(null);
      flags.doneSeen = true;
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
  const flags = { doneSeen: false };

  try {
    await streamQuery(query, {
      signal,
      onEvent: (ev) => {
        hadLiveStream = true;
        // first successful event confirms liveness
        store.setLiveMode("live");
        if (ev.type === "answer") spoken = ev.text;
        dispatch(store, ev, flags);
      },
      onError: (msg) => {
        log(msg);
      },
    });
    // A stream that yielded events but never `done` died mid-pipeline: the
    // machine sits in thinking/… with no legal edge out, which used to freeze
    // the input bar until reload. Treat it as an interrupted turn.
    if (!hadLiveStream) throw new Error("empty stream");
    if (!flags.doneSeen) {
      log("stream ended without done");
      store.setSessionError("the orchestrator ended the turn early");
      store.setLiveMode("idle");
      store.endTurn();
      return;
    }
  } catch (err) {
    if ((err as Error).name === "AbortError" || signal?.aborted) return;
    // If we already streamed something, don't fallback — just surface error
    if (hadLiveStream) {
      log("stream interrupted:", err);
      store.setSessionError(err instanceof Error ? err.message : String(err));
      store.setLiveMode("idle");
      store.endTurn();
      return;
    }
    // A refusal is not an outage. The orchestrator is up and said no, so the
    // offline demo path would replace a real limit with a fabricated answer.
    if (err instanceof OrchestratorRefused) {
      const wait_s = err.retryAfter ? ` — retry in ${Math.ceil(err.retryAfter / 60)} min` : "";
      store.setSessionError(`${err.message}${wait_s}`);
      store.setLiveMode("idle");
      store.endTurn();
      return;
    }

    log("orchestrator unreachable, using local rules planner:", err);
    store.setLiveMode("offline");
    await runLocal(store, query, voice);
    return;
  }

  // The answer is held until it has been read out, rather than for a fixed
  // beat — a two-sentence reply outlasts 3.6s and would otherwise be cleared,
  // and the HUD returned to IDLE, while FRIDAY was still talking.
  if (spoken) await (voice ? speakUnlessAborted(spoken) : wait(FLOW_TIMING.answerHold));
  store.endTurn();
  // Answer stays on screen until the next query (turn-start setAnswer(null) is
  // the only place that clears it), same as the viz scene above.
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
    log("could not deliver decision:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * The pre-backend scripted flow, kept as the offline demo path.
 * Production-reachable only when the orchestrator is unreachable (never on
 * refusal) — see the catch branch above. Canned numbers inside are demo data.
 */
async function runLocal(store: FlowStore, query: string, voice = false) {
  const { transition, setAnswer } = store;

  transition("thinking");
  await wait(FLOW_TIMING.localThinking);
  transition("searching");
  await wait(FLOW_TIMING.localSearching);
  transition("tool_execution");
  store.setToolActivity({ tool: "get_system_metrics", risk: "low" });
  await wait(FLOW_TIMING.localTool);
  transition("processing");
  store.setToolActivity(null);
  await wait(FLOW_TIMING.localProcessing);

  const spec = planVisualization(query);
  transition("visualizing");
  store.addVisualization(spec);
  await wait(FLOW_TIMING.localVisualizing);

  const answer = summarize(spec);
  transition("speaking");
  setAnswer(answer);
  await (voice ? speakUnlessAborted(answer) : wait(FLOW_TIMING.answerHold));

  store.endTurn();
  store.setLiveMode("idle");
}
