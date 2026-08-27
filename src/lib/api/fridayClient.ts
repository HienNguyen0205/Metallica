import { parseSseStream } from "@/lib/api/sse";
import { parseFridayEvent, type FridayEvent } from "@/lib/agent/events";

const API = process.env.NEXT_PUBLIC_FRIDAY_API ?? "http://localhost:8000";

export function getApiBase(): string {
  return API;
}

/**
 * §15 — identifies this tab to the orchestrator so it can replay the last few
 * exchanges into the next prompt.
 *
 * `sessionStorage`, not `localStorage`: the memory it keys into lives in the
 * orchestrator's process and does not survive a restart, so a browser-side id
 * that outlived the tab would point at nothing while implying continuity. Per
 * tab also means two tabs are two conversations, which is what they look like.
 */
function sessionId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    let id = window.sessionStorage.getItem("friday.session");
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem("friday.session", id);
    }
    return id;
  } catch {
    // storage can be blocked outright; a turn without continuity beats no turn
    return undefined;
  }
}

export interface QueryOptions {
  signal?: AbortSignal;
  onEvent: (event: FridayEvent) => void;
  onError?: (message: string) => void;
}

/**
 * POST /query streaming via fetch — not EventSource (GET-only).
 * Resolves when stream completes (done) or aborts.
 */
export async function streamQuery(query: string, opts: QueryOptions): Promise<void> {
  const { signal, onEvent, onError } = opts;

  let response: Response;
  try {
    response = await fetch(`${API}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, session_id: sessionId() }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    throw err;
  }

  if (!response.ok || !response.body) {
    throw new Error(`orchestrator ${response.status}`);
  }

  try {
    for await (const raw of parseSseStream(response.body, signal)) {
      if (signal?.aborted) break;
      const event = parseFridayEvent(raw);
      if (!event) continue;
      onEvent(event);
      if (event.type === "error") onError?.(event.message);
      if (event.type === "done") break;
    }
  } catch (err) {
    if ((err as Error).name === "AbortError" || signal?.aborted) return;
    throw err;
  }
}

export async function confirmDecision(
  id: string,
  approved: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, approved }),
    signal,
  });
  if (!res.ok) throw new Error(`confirm ${res.status}`);
}

/** Warn when NEXT_PUBLIC_FRIDAY_API was baked pointing at localhost on a deployed page. */
export function warnIfMisconfigured(): void {
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
