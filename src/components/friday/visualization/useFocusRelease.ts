"use client";

import { useEffect } from "react";
import { useFridayStore } from "@/lib/store";
import { releaseFocus } from "@/lib/visualization/focus";

/** Clear `owner`'s selection only — never another viz's. */
function release(owner: string) {
  const s = useFridayStore.getState();
  const next = releaseFocus(s.focus, owner);
  if (next !== s.focus) s.setFocus(next);
}

/**
 * ESC releases THIS visualization's selection only — a network node's ESC must
 * never clear the gauge's, and vice versa (one spine, owner-scoped). Every
 * selecting viz calls this — it is the only keyboard release now that the old
 * `FocusPanel` card is gone. Returns the same release for `onPointerMissed`.
 */
export function useFocusRelease(owner: string) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") release(owner);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [owner]);
  return () => release(owner);
}
