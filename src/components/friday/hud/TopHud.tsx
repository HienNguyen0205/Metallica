"use client";

import { useEffect, useState } from "react";
import { useFridayStore, type FridayState } from "@/lib/store";
import { useHudDepth } from "./useHudDepth";

const STATE_TONE: Record<FridayState, string> = {
  idle: "text-cyan-200",
  listening: "text-cyan-200",
  thinking: "text-sky-200",
  searching: "text-cyan-200",
  processing: "text-violet-300",
  tool_execution: "text-violet-300",
  visualizing: "text-teal-200",
  speaking: "text-teal-200",
  warning: "text-amber-300",
  error: "text-red-300",
};

function useClock() {
  const [time, setTime] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setTime(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

export function TopHud() {
  const depth = useHudDepth();
  const state = useFridayStore((s) => s.state);
  const audioEnabled = useFridayStore((s) => s.audioEnabled);
  const toggleAudio = useFridayStore((s) => s.toggleAudio);
  const time = useClock();

  return (
    <div
      style={depth}
      className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between px-8 py-6 font-mono text-[10px] tracking-[0.28em] text-cyan-300/75"
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-light tracking-[0.42em] text-cyan-100/90">METALLICA</span>
        <span>FRIDAY · HOLOGRAPHIC INTERFACE</span>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <span className={`tracking-[0.32em] ${STATE_TONE[state]}`} data-testid="hud-state">
          {state.replace("_", " ").toUpperCase()}
        </span>
        <span className="text-cyan-300/60">{time ?? "--:--:--"}</span>
        {/* Mobile mute — the EdgeTelemetry AUDIO toggle is desktop-only. */}
        <button
          onClick={toggleAudio}
          aria-pressed={audioEnabled}
          aria-label={audioEnabled ? "Mute audio cues" : "Unmute audio cues"}
          className="pointer-events-auto tracking-[0.22em] text-cyan-300/60 transition-colors hover:text-cyan-200 md:hidden"
        >
          AUDIO · {audioEnabled ? "ON" : "OFF"}
        </button>
      </div>
    </div>
  );
}
