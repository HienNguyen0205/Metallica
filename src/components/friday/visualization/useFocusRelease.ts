"use client";

import { useEffect } from "react";
import { useFridayStore } from "@/lib/store";
import { releaseFocus } from "@/lib/visualization/focus";

/**
 * ESC releases THIS visualization's selection only — a network node's ESC must
 * never clear the gauge's, and vice versa (one spine, owner-scoped). Every
 * selecting viz calls this — it is the only keyboard release now that the old
 * `FocusPanel` card is gone.
 */
export function useFocusRelease(owner: string) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = useFridayStore.getState();
      const next = releaseFocus(s.focus, owner);
      if (next !== s.focus) s.setFocus(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [owner]);
}
