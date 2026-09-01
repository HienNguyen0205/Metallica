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

/**
 * The orchestrator answered and refused: §22 origin check (403) or a rate
 * limit (429). Distinct from unreachable on purpose — the caller must not
 * answer a refusal with the offline planner's canned data, which would show
 * the user an invented number and no reason it is not a real one.
 */
export class OrchestratorRefused extends Error {
  constructor(
    readonly status: number,
    /** Seconds until the window frees up; null when the header is absent. */
    readonly retryAfter: number | null,
  ) {
    super(status === 429 ? "rate limited by the orchestrator" : "orchestrator refused this origin");
    this.name = "OrchestratorRefused";
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

  if (response.status === 403 || response.status === 429) {
    // Readable cross-origin only because the backend lists Retry-After in
    // Access-Control-Expose-Headers; without that this is always null.
    const retry = Number(response.headers.get("retry-after"));
    throw new OrchestratorRefused(response.status, Number.isFinite(retry) && retry > 0 ? retry : null);
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

/**
 * A fact already in the store, as `GET /memory` returns it.
 *
 * Narrower than the row the backend holds: it also carries `created_at` and
 * `last_used_at`, which nothing here shows. Only what is rendered is parsed.
 */
export interface StoredMemory {
  id: number;
  fact: string;
  provenance: "user" | "tool";
}

/**
 * §8 of the memory design — the operator's half of "review and delete", which
 * that section calls the only mitigation standing behind the decision to let
 * the model write facts unprompted.
 *
 * Rows are validated rather than trusted. This crosses a process boundary, and
 * a malformed row rendering as `undefined` next to a FORGET button is worse
 * than one that never appears.
 */
export async function listMemories(signal?: AbortSignal): Promise<StoredMemory[]> {
  const res = await fetch(`${API}/memory`, { signal });
  if (!res.ok) throw new Error(`memory ${res.status}`);

  const body: unknown = await res.json();
  // Documented as `{ memories, from_cache }`; a bare array is accepted too
  // because this repo cannot see the backend's source to be sure.
  const rows: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { memories?: unknown[] })?.memories)
      ? (body as { memories: unknown[] }).memories
      : [];

  return rows.flatMap((row) => {
    const r = row as Partial<Record<keyof StoredMemory, unknown>>;
    if (typeof r?.id !== "number" || typeof r?.fact !== "string" || !r.fact) return [];
    return [{ id: r.id, fact: r.fact, provenance: r.provenance === "tool" ? "tool" : "user" }];
  });
}

/** `DELETE /memory/{id}` — permanent, and clears the backend's RAM cache too. */
export async function forgetMemory(id: number, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API}/memory/${id}`, { method: "DELETE", signal });
  if (!res.ok) throw new Error(`forget ${res.status}`);
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
