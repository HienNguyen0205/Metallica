/**
 * Shared API base + tab session helpers. Single source so fridayClient and
 * ttsClient cannot drift (previously copy-pasted `API` + `sessionStorage`
 * logic in both files).
 */

const FALLBACK_API = "http://localhost:8000";

export function getApiBase(): string {
  const raw = process.env.NEXT_PUBLIC_FRIDAY_API;
  // Empty string bakes to same-origin "/query" — fall back to localhost so a
  // misconfigured env never silently changes the request target.
  if (!raw) return FALLBACK_API;
  return raw;
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

export function needsMisconfigBanner(pageHost: string, api: string): boolean {
  const pageIsLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(pageHost);
  const apiIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(api);
  return !pageIsLocal && apiIsLocal;
}
