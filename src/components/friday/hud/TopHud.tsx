"use client";

import { useEffect, useState } from "react";
import { useFridayStore, type FridayState } from "@/lib/store";
import { useHudDepth } from "./useHudDepth";
import { getApiBase, needsMisconfigBanner } from "@/lib/api/session";

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
    // local wall time — toISOString() is UTC, seven hours off in Hanoi
    const tick = () => setTime(new Date().toLocaleTimeString("en-GB", { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

function useMisconfigured(): boolean {
  const [mis, setMis] = useState(false);
  useEffect(() => {
    const API = getApiBase();
    // Post-mount by design: reading window.location.hostname during render
    // would mismatch the server prerender (no banner) on a misconfigured
    // deploy. The sync set below lands once on mount, never per-render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMis(needsMisconfigBanner(window.location.hostname, API));
  }, []);
  return mis;
}

export function TopHud() {
  const depth = useHudDepth();
  const state = useFridayStore((s) => s.state);
  const audioEnabled = useFridayStore((s) => s.audioEnabled);
  const toggleAudio = useFridayStore((s) => s.toggleAudio);
  const time = useClock();
  const [dismissed, setDismissed] = useState(false);
  const misconfigured = useMisconfigured();

  return (
    <div
      style={depth}
      className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between px-8 py-6 font-mono text-[10px] tracking-[0.28em] text-cyan-300/75"
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-light tracking-[0.42em] text-cyan-100/90">METALLICA</span>
        <span>FRIDAY · HOLOGRAPHIC INTERFACE</span>
        {misconfigured && !dismissed && (
          <button
            role="status"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss backend warning"
            className="pointer-events-auto text-amber-300/80 tracking-[0.22em]"
          >
            UNSPECIFIED BACKEND — SHOWING DEMO DATA
          </button>
        )}
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
