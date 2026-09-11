import type { FridayStore } from "@/lib/store";
import { planVisualization, summarize } from "@/lib/vizPlanner";
import { speak, stopSpeaking } from "@/lib/voice";
import {
  streamQuery,
  cancelRun,
  confirmDecision,
  fetchRunEvents,
  warnIfMisconfigured,
  OrchestratorRefused,
} from "@/lib/api/fridayClient";
import type { EnvelopeMeta, FridayEvent } from "@/lib/agent/events";
import { parseFridayEvent } from "@/lib/agent/events";
import { StreamGuard } from "@/lib/agent/streamGuard";
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

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

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

/**
 * P1.5 — the run_id of the turn in flight (from enveloped frames), so a
 * cancel also stops the server run instead of merely dropping the stream.
 * Cleared every turn; flat/offline turns never set it. A stale id is harmless:
 * cancelling a finished run is a server-side no-op report.
 */
let activeRunId: string | null = null;

/**
 * Best-effort server cancel for the in-flight turn. Returns the run id that
 * was cancelled, or null when there is nothing to cancel. Never throws —
 * aborting the fetch is the guarantee; this only stops server-side spend.
 */
export async function cancelActiveRun(): Promise<string | null> {
  const id = activeRunId;
  activeRunId = null;
  if (!id) return null;
  try {
    await cancelRun(id);
  } catch (err) {
    log("could not deliver cancel:", err);
  }
  return id;
}

/**
 * P1.10 — resume an interrupted turn from the server's event log. Missed
 * frames flow through the same guard → parser → store path as live ones, so
 * duplicates are impossible (the server filters by after_sequence) and a
 * replay can never re-execute tools — it is a read-only catch-up. Completes
 * only when the server reports a terminal run *and* its `done` landed here;
 * anything else (unknown run, network down, run still live) returns
 * incomplete and the caller keeps the existing error path.
 */
async function tryResume(
  store: FlowStore,
  guard: StreamGuard,
  flags: { doneSeen: boolean },
): Promise<{ completed: boolean; spoken: string | null }> {
  const incomplete = { completed: false, spoken: null } as const;
  const runId = activeRunId;
  const after = guard.lastSeenSequence ?? 0;
  if (!runId) return { ...incomplete };
  let replay;
  try {
    replay = await fetchRunEvents(runId, after);
  } catch (err) {
    log("resume failed:", err);
    return { ...incomplete };
  }
  let spoken: string | null = null;
  for (const entry of replay.events) {
    if (
      typeof entry.sequence !== "number" ||
      typeof entry.event !== "string" ||
      typeof entry.payload !== "object" ||
      entry.payload === null
    ) {
      continue;
    }
    const meta: EnvelopeMeta = {
      version: 1,
      runId,
      sessionId: null,
      turnId: null,
      sequence: entry.sequence,
      timestamp: null,
    };
    const verdict = guard.observe(meta, JSON.stringify(entry));
    if (verdict === "duplicate" || verdict === "stale" || verdict === "wrong-run") continue;
    const ev = parseFridayEvent({ event: entry.event, data: JSON.stringify(entry.payload) });
    if (!ev) continue;
    store.setLiveMode("live");
    if (ev.type === "done") activeRunId = null;
    if (ev.type === "answer") spoken = ev.text;
    dispatch(store, ev, flags);
  }
  if (replay.terminal && flags.doneSeen) activeRunId = null;
  if (!(replay.terminal && flags.doneSeen)) return { ...incomplete };
  return { completed: true, spoken };
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
  | "setCurrentStep"
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
    case "step":
      store.setCurrentStep(event.step);
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
  store.setCurrentStep(null);
  store.setSessionError(null);
  store.setToolActivity(null);
  store.setLiveMode("connecting");
  stopSpeaking();
  warnIfMisconfigured();
  activeRunId = null;

  let spoken: string | null = null;
  let hadLiveStream = false;
  const flags = { doneSeen: false };
  const guard = new StreamGuard();

  try {
    await streamQuery(query, {
      signal,
      onEvent: (ev, meta) => {
        const verdict = guard.observe(meta ?? null, JSON.stringify(ev));
        if (verdict === "duplicate" || verdict === "stale" || verdict === "wrong-run") {
          log(`stream ${verdict} skipped`, meta?.sequence ?? "", meta?.runId ?? "");
          return;
        }
        if (verdict === "gap") {
          log(`stream gap: last=${guard.lastSeenSequence} (gap #${guard.gapCount})`);
        }
        hadLiveStream = true;
        store.setLiveMode("live");
        if (ev.type === "done") activeRunId = null;
        else if (meta?.runId) activeRunId = meta.runId;
        if (ev.type === "answer") spoken = ev.text;
        dispatch(store, ev, flags);
      },
      onError: (msg) => {
        // P0.2 — protocol errors and orchestrator error frames land in the
        // store, never only in the console. Error events are also dispatched
        // above, so this is a harmless double-set for them; for rejected
        // envelopes it is the only surfacing.
        store.setSessionError(msg);
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
    // A streamed turn never falls back to the offline planner — that would
    // swap real events for canned data. Resume completion falls through to
    // the normal tail below; everything else returns from its branch.
    if (hadLiveStream) {
      // If we already streamed something, catch up from the server log before
      // reporting failure — a terminal replay completes the turn.
      const resumed = await tryResume(store, guard, flags);
      if (resumed.completed) {
        if (resumed.spoken) spoken = resumed.spoken;
      } else {
        log("stream interrupted:", err);
        store.setSessionError(err instanceof Error ? err.message : String(err));
        store.setLiveMode("idle");
        store.endTurn();
        return;
      }
    } else {
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
      await runLocal(store, query, voice, signal);
      return;
    }
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
async function runLocal(store: FlowStore, query: string, voice = false, signal?: AbortSignal) {
  const { transition, setAnswer } = store;

  try {
    transition("thinking");
    await wait(FLOW_TIMING.localThinking, signal);
    transition("searching");
    await wait(FLOW_TIMING.localSearching, signal);
    transition("tool_execution");
    store.setToolActivity({ tool: "get_system_metrics", risk: "low" });
    await wait(FLOW_TIMING.localTool, signal);
    transition("processing");
    store.setToolActivity(null);
    await wait(FLOW_TIMING.localProcessing, signal);

    const spec = planVisualization(query);
    transition("visualizing");
    store.addVisualization(spec);
    await wait(FLOW_TIMING.localVisualizing, signal);

    const answer = summarize(spec);
    transition("speaking");
    setAnswer(answer);
    // speakUnlessAborted (remote): barge-in abort during the utterance is
    // intentional silence, not a failure. Typed path waits on the signal so
    // cancel stops the hold short.
    await (voice ? speakUnlessAborted(answer) : wait(FLOW_TIMING.answerHold, signal));
  } catch (err) {
    // Cancelled mid-demo: behave like an aborted stream turn — leave the
    // machine wherever it stopped for the caller's reset(), no outcome to report.
    if ((err as Error).name === "AbortError" || signal?.aborted) return;
    throw err;
  }
  if (signal?.aborted) return;

  store.endTurn();
  store.setLiveMode("idle");
}
