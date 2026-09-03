"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useFridayStore, type FridayState, type VisualizationType } from "@/lib/store";
import { sampleSpec } from "@/lib/vizPlanner";
import { playStateCue } from "@/lib/uiSound";
import { useTelemetry } from "@/lib/telemetry";
import { STATE_CAMERA } from "@/lib/stateLook";

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

/** §18 — cue sounds fire from state changes, muted until the user allows it. */
export function AudioCues() {
  const state = useFridayStore((s) => s.state);
  const audioEnabled = useFridayStore((s) => s.audioEnabled);
  const unlocked = useRef(false);
  const previous = useRef<FridayState>(state);

  useEffect(() => {
    const unlock = () => {
      unlocked.current = true;
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    if (state !== previous.current) {
      previous.current = state;
      if (audioEnabled && unlocked.current) playStateCue(state);
    }
  }, [state, audioEnabled]);

  return null;
}

/**
 * §12 — the 2D chrome is a projection in the same space, not a sticker on
 * glass: it parallaxes against camera drift and recedes slightly as the rig
 * pushes toward the core.
 *
 * Passive readouts only. Camera drift never stops, so applying this to the
 * rails left their buttons permanently in motion — unclickable to automation
 * and fiddly for a real cursor.
 *
 * Opacity range is deliberately shallow (0.96–1.0). The HUD text sits at
 * ~5.3:1 contrast and a heavier fade would drop it under WCAG AA.
 */
function useHudDepth(strength = 14): CSSProperties {
  const t = useTelemetry();
  const near = STATE_CAMERA.thinking.distance;
  const far = STATE_CAMERA.visualizing.distance;
  const depth = Math.min(1, Math.max(0, (t.camera[2] - near) / (far - near)));

  return {
    transform: `translate3d(${(-t.camera[0] * strength).toFixed(2)}px, ${(
      -t.camera[1] * strength
    ).toFixed(2)}px, 0)`,
    opacity: 0.96 + depth * 0.04,
    // smooths the 4Hz telemetry sampling into continuous motion
    transition: "transform 280ms linear, opacity 280ms linear",
    willChange: "transform",
  };
}

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
      </div>
    </div>
  );
}

/** §3 — thin telemetry at the screen edges. No panels, no boxes. */
export function EdgeTelemetry() {
  const depth = useHudDepth();
  const audioEnabled = useFridayStore((s) => s.audioEnabled);
  const toggleAudio = useFridayStore((s) => s.toggleAudio);
  const focus = useFridayStore((s) => s.focus);
  const renderBackend = useFridayStore((s) => s.renderBackend);
  const quality = useFridayStore((s) => s.quality);
  const setQuality = useFridayStore((s) => s.setQuality);
  const t = useTelemetry();

  const uplink = t.downlink > 0 ? `${t.downlink.toFixed(1)}MB/S` : "STABLE";
  const memory =
    t.heapMB > 0 ? `${t.heapMB.toFixed(0)}MB · ${(t.heapRatio * 100).toFixed(0)}%` : "NOMINAL";

  return (
    <>
      <div
        style={depth}
        className="pointer-events-none absolute bottom-28 left-8 hidden flex-col gap-1 font-mono text-[9px] tracking-[0.22em] text-cyan-300/60 md:flex"
      >
        <span>UPLINK · {uplink}</span>
        <span>FRAME · {t.frameMs > 0 ? `${t.frameMs.toFixed(1)}MS` : "—"}</span>
        <span>MEMORY · {memory}</span>
        <span>
          VECTOR · {t.camera[0].toFixed(3)} / {t.camera[1].toFixed(3)}
        </span>
      </div>
      <div className="absolute bottom-28 right-8 hidden flex-col items-end gap-1 font-mono text-[9px] tracking-[0.22em] text-cyan-300/60 md:flex">
        <span data-testid="hud-focus" className={focus ? "text-cyan-200" : undefined}>
          {focus ? `FOCUS · ${focus.label} ${focus.detail}` : "FOCUS · --"}
        </span>
        <span>RENDER · {renderBackend.toUpperCase()}</span>
        <span>SYNC · {t.fps > 0 ? `${t.fps.toFixed(0)}HZ` : "—"}</span>
        <span>SECURITY · ARMED</span>
        <button
          onClick={toggleAudio}
          className="pointer-events-auto tracking-[0.22em] transition-colors hover:text-cyan-200"
        >
          AUDIO · {audioEnabled ? "ON" : "OFF"}
        </button>
        <span className="flex gap-2">
          {(["auto", "high", "low"] as const).map((q) => (
            <button
              key={q}
              onClick={() => setQuality(q)}
              className={`pointer-events-auto tracking-[0.22em] transition-colors hover:text-cyan-200 ${
                quality === q ? "text-cyan-200" : undefined
              }`}
            >
              {q.toUpperCase()}
            </button>
          ))}
        </span>
      </div>
    </>
  );
}

/** §10 — the spoken answer, minimal and floating. Never a chat bubble. */
export function AnswerLine() {
  const answer = useFridayStore((s) => s.answer);

  /**
   * The container is always mounted, empty or not. A live region has to exist
   * before its content changes for the change to be announced — mounting the
   * region and the text together is the one arrangement screen readers reliably
   * miss, and the answer is spoken aloud only when the question arrived by
   * voice, so a typed turn otherwise reaches a screen reader user not at all.
   */
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-32 flex justify-center px-8"
    >
      {/* keyed so a new answer replays the rise-in */}
      {answer && (
        <p
          key={answer}
          className="answer-rise max-w-sm text-center font-mono text-[13px] font-light leading-relaxed tracking-[0.06em] text-cyan-50/85"
        >
          {answer}
        </p>
      )}
    </div>
  );
}

const STATE_OPTIONS: FridayState[] = [
  "idle",
  "listening",
  "thinking",
  "searching",
  "processing",
  "tool_execution",
  "visualizing",
  "speaking",
  "warning",
  "error",
];

const VIZ_OPTIONS: VisualizationType[] = [
  "radial_gauge",
  "health_core",
  "radar",
  "waveform",
  "line_3d",
  "bar_3d",
  "heatmap_3d",
  "timeline",
  "network",
  "globe",
  "particle_flow",
];

/**
 * Whether the two dev rails render at all.
 *
 * They call `setState`, which is the *unguarded* escape hatch — it bypasses the
 * transition table entirely. That is the right tool for driving the machine
 * while building, and the wrong thing to hand a visitor, so it ships off.
 *
 * On during `next dev` without any setup; the Playwright suite builds for
 * production and turns it back on through `playwright.config.ts`, because the
 * rails are how the tests drive states and visualizations.
 */
export function devRailsEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEV_RAILS === "1";
}

/** Dev rail — materializes any visualization type with sample data on click. */
export function VizRail() {
  // The type of what is on screen, not the spec: a primitive keeps this
  // selector from handing zustand a fresh value on every store write.
  const activeType = useFridayStore((s) => s.visualizations.at(-1)?.spec.type);
  const setVisualizations = useFridayStore((s) => s.setVisualizations);
  const setState = useFridayStore((s) => s.setState);

  if (!devRailsEnabled()) return null;

  return (
    <div
      className="pointer-events-auto absolute left-8 top-28 hidden flex-col items-start gap-1 font-mono text-[9px] tracking-[0.22em] md:flex"
      id="viz-rail"
    >
      {VIZ_OPTIONS.map((t) => (
        <button
          key={t}
          onClick={() => {
            // replaces the scene rather than appending to it — the rail picks
            // one visualization to look at, it does not build a collection
            setVisualizations([sampleSpec(t)]);
            setState("visualizing");
          }}
          className={`transition-colors ${
            activeType === t ? "text-cyan-200" : "text-cyan-300/60 hover:text-cyan-200"
          }`}
        >
          {activeType === t ? "▸ " : ""}
          {t.replace("_", " ").toUpperCase()}
        </button>
      ))}
    </div>
  );
}

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
    <div className="pointer-events-auto absolute bottom-40 left-1/2 hidden -translate-x-1/2 items-center gap-3 border border-cyan-300/25 bg-[#02050a]/80 px-4 py-2 font-mono text-[10px] tracking-[0.22em] text-cyan-100 backdrop-blur-sm md:flex">
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

export function StateRail() {
  const state = useFridayStore((s) => s.state);
  const setState = useFridayStore((s) => s.setState);

  if (!devRailsEnabled()) return null;

  return (
    <div
      className="pointer-events-auto absolute right-8 top-28 hidden flex-col items-end gap-1 font-mono text-[9px] tracking-[0.22em] md:flex"
      id="state-rail"
    >
      {STATE_OPTIONS.map((s) => (
        <button
          key={s}
          onClick={() => setState(s)}
          className={`transition-colors ${
            state === s ? "text-cyan-200" : "text-cyan-300/60 hover:text-cyan-200"
          }`}
        >
          {state === s ? "▸ " : ""}
          {s.replace("_", " ").toUpperCase()}
        </button>
      ))}
    </div>
  );
}
