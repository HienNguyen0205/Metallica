"use client";

import { useEffect } from "react";

/**
 * The scene's own failure modes are already handled where they happen: a lost
 * WebGL context remounts the canvas, an unreachable orchestrator falls back to
 * the local planner. This catches the class none of those cover — a React
 * render throwing somewhere in the r3f tree — which otherwise takes the whole
 * page to blank white on whatever driver happened to disagree.
 *
 * Deliberately plain DOM: whatever just failed may well be the renderer, so
 * nothing here may depend on it.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[friday] scene failed:", error);
  }, [error]);

  return (
    <main className="flex h-dvh w-screen flex-col items-center justify-center gap-6 bg-background px-8 text-center font-mono">
      <span className="h-2 w-2 rounded-full bg-red-400 shadow-[0_0_12px_4px_rgba(248,113,113,0.5)]" />
      <div className="flex flex-col gap-2">
        <p className="text-[11px] tracking-[0.32em] text-red-300/90">HOLOGRAM OFFLINE</p>
        <p className="max-w-md text-[10px] leading-relaxed tracking-[0.18em] text-cyan-300/60">
          {/* the message, not a friendly paraphrase: whoever sees this is the
              operator, and the driver's own words are the useful part */}
          {error.message || "the scene stopped rendering"}
        </p>
      </div>
      <button
        onClick={reset}
        className="border border-cyan-300/40 px-5 py-2 text-[10px] tracking-[0.24em] text-cyan-200 transition-colors hover:bg-cyan-300/10 hover:text-cyan-100"
      >
        REINITIALIZE
      </button>
    </main>
  );
}
