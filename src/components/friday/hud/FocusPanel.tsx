"use client";

import { useEffect } from "react";
import { useFridayStore } from "@/lib/store";

/** Drill-down detail card — DOM mirror of the 3D focus reticle. ESC or ✕ releases. */
export function FocusPanel() {
  const focus = useFridayStore((s) => s.focus);
  const setFocus = useFridayStore((s) => s.setFocus);

  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, setFocus]);

  if (!focus) return null;
  return (
    <div
      role="status"
      className="pointer-events-auto absolute bottom-40 left-1/2 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 border border-cyan-300/25 bg-[#02050a]/80 px-4 py-2 font-mono text-[10px] tracking-[0.22em] text-cyan-100 backdrop-blur-sm"
    >
      <span className="text-cyan-200">{focus.label}</span>
      <span className="text-cyan-300/70">{focus.detail}</span>
      <button
        onClick={() => setFocus(null)}
        aria-label="Release focus"
        className="text-cyan-300/60 transition-colors hover:text-cyan-100"
      >
        ✕
      </button>
    </div>
  );
}
