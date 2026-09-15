import type { VizFocus } from "./types";

/** A selection owned by a viz that renders its own focus (no shared chrome). */
export function makeNativeFocus(
  owner: string,
  key: string,
  label: string,
  detail: string,
): VizFocus {
  return { owner, key, label, detail, native: true, position: undefined };
}

/** The legacy generic drill-down focus: shared reticle + FocusPanel draw it. */
export function makeDrilldownFocus(
  label: string,
  detail: string,
  position: [number, number, number],
): VizFocus {
  return { owner: "drilldown", key: label, label, detail, native: false, position };
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
