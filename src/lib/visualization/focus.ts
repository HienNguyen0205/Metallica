import type { VizFocus } from "./types";

/**
 * Build a selection record. `owner` namespaces `key` so two visualization
 * types never collide, and every viz now renders its own focus — there is no
 * shared reticle/card to opt out of anymore.
 */
export function makeFocus(
  owner: string,
  key: string,
  label: string,
  detail: string,
): VizFocus {
  return { owner, key, label, detail };
}

/** Click semantics: re-picking the same element releases it, else it replaces. */
export function toggleFocus(current: VizFocus | null, next: VizFocus): VizFocus | null {
  if (current && current.owner === next.owner && current.key === next.key) return null;
  return next;
}

/** ESC / click-miss: clear only this owner's selection, never steal another's. */
export function releaseFocus(current: VizFocus | null, owner: string): VizFocus | null {
  if (current && current.owner === owner) return null;
  return current;
}

export function isFocusedBy(focus: VizFocus | null, owner: string, key: string): boolean {
  return !!focus && focus.owner === owner && focus.key === key;
}

export function anyFocusedBy(focus: VizFocus | null, owner: string): boolean {
  return !!focus && focus.owner === owner;
}
