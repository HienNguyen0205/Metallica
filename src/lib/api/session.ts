/**
 * Shared API base + tab session helpers. Single source so fridayClient and
 * ttsClient cannot drift (previously copy-pasted `API` + `sessionStorage`
 * logic in both files).
 */

const API = process.env.NEXT_PUBLIC_FRIDAY_API ?? "http://localhost:8000";

export function getApiBase(): string {
  return API;
}

/**
 * Per-tab conversation id. `sessionStorage`, not `localStorage`: the memory it
 * keys into lives in the orchestrator's process and does not survive a restart.
 */
export function getSessionId(): string | undefined {
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
