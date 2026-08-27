import type { FridayStore, PendingConfirm, VisualizationSpec } from "@/lib/store";
import { planVisualization, summarize } from "@/lib/vizPlanner";

const API = process.env.NEXT_PUBLIC_FRIDAY_API ?? "http://localhost:8000";

/**
 * The dangerous misconfiguration is not a crash, it is a site that looks fine.
 *
 * NEXT_PUBLIC_FRIDAY_API is inlined at build time. Forget it on the deploy and
 * the bundle ships pointing at localhost:8000 — which, from a visitor's
 * browser, means *their* machine. The fetch fails, the offline rules planner
 * answers with canned data, and the page behaves exactly like a working one.
 */
function warnIfMisconfigured() {
  if (typeof window === "undefined") return;
  const pageIsLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const apiIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(API);
  if (!pageIsLocal && apiIsLocal) {
    console.error(
      `[friday] NEXT_PUBLIC_FRIDAY_API is "${API}" on a deployed page. ` +
        "Every answer below is canned demo data from the offline planner, not a real one. " +
        "Set it to the orchestrator's URL and rebuild — an env-var change alone will not do it.",
    );
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FlowStore = Pick<
  FridayStore,
  "transition" | "setAnswer" | "setVisualization" | "setPendingConfirm"
>;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Parses an SSE byte stream into events.
 *
 * POST rather than EventSource on purpose: EventSource is GET-only, which would
 * put the user's question into the URL — and therefore into every access log
 * and proxy along the way.
 */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // frames are separated by a blank line; the tail may be a partial frame
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");

      let event = "message";
      let data = "{}";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      try {
        yield { event, data: JSON.parse(data) };
      } catch {
        // a frame we cannot parse is not worth killing the turn over
      }
    }
  }
}

/**
 * §9 — drives the state machine from backend events.
 *
 * Falls back to the local rules planner when the orchestrator is unreachable,
 * so the interface still answers with no backend running. That fallback is
 * canned data: it is a demo path, not a degraded live one.
 */
export async function runQuery(store: FlowStore, query: string) {
  const { transition, setAnswer, setVisualization, setPendingConfirm } = store;

  setAnswer(null);
  setVisualization(null);
  setPendingConfirm(null);
  warnIfMisconfigured();

  let answered = false;

  try {
    const response = await fetch(`${API}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok || !response.body) throw new Error(`orchestrator ${response.status}`);

    for await (const { event, data } of readEvents(response.body)) {
      switch (event) {
        case "state":
          transition(data.state as Parameters<typeof transition>[0]);
          break;
        case "viz":
          setVisualization(data as unknown as VisualizationSpec);
          break;
        case "answer":
          setAnswer(String(data.text));
          answered = true;
          break;
        case "confirm":
          // §11 — the orchestrator is blocked until /confirm answers.
          setPendingConfirm(data as unknown as PendingConfirm);
          break;
        case "denied":
        case "tool":
          break;
        case "error":
          console.warn("[friday]", data.message);
          break;
      }
    }
  } catch (err) {
    console.warn("[friday] orchestrator unreachable, using local rules planner:", err);
    await runLocal(store, query);
    return;
  }

  if (answered) await wait(3600);
  transition("idle");
  setAnswer(null);
  setVisualization(null);
  setPendingConfirm(null);
}

/** §11 — send the operator's decision so the blocked tool call can proceed. */
export async function decide(id: string, approved: boolean) {
  try {
    await fetch(`${API}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, approved }),
    });
  } catch (err) {
    console.warn("[friday] could not deliver decision:", err);
  }
}

/** The pre-backend scripted flow, kept as the offline demo path. */
async function runLocal(store: FlowStore, query: string) {
  const { transition, setAnswer, setVisualization } = store;

  transition("thinking");
  await wait(800);
  transition("searching");
  await wait(700);
  transition("tool_execution");
  await wait(700);
  transition("processing");
  await wait(500);

  const spec = planVisualization(query);
  transition("visualizing");
  setVisualization(spec);
  await wait(1500);

  transition("speaking");
  setAnswer(summarize(spec));
  await wait(3600);

  transition("idle");
  setAnswer(null);
  setVisualization(null);
}
