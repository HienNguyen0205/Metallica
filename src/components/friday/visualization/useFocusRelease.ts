"use client";

import { useEffect } from "react";
import { useFridayStore } from "@/lib/store";
import { releaseFocus } from "@/lib/visualization/focus";

/**
 * ESC releases THIS visualization's selection only — a network node's ESC must
 * never clear the gauge's, and vice versa (one spine, owner-scoped). Migrated
 * viz call this with their owner id so the shared `FocusPanel` (which only sees
 * `native:false` drill-down focus) is not their only release path.
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
