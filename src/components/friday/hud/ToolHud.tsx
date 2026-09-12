"use client";

import { useEffect, useState } from "react";
import { useFridayStore } from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";

/**
 * §2/§11 — spatial tool instrumentation HUD.
 * Not a card: tiny telemetry floating near core, showing what FRIDAY is doing.
 */
export function ToolHud() {
  const activity = useFridayStore((s) => s.toolActivity);
  const denied = useFridayStore((s) => s.deniedTool);
  const step = useFridayStore((s) => s.currentStep);
  const state = useFridayStore((s) => s.state);
  const look = STATE_LOOK[state];

  if (!activity && !denied && !step) return null;

  const isDenied = !!denied && !activity;

  return (
    <div className="pointer-events-none absolute left-1/2 top-20 flex -translate-x-1/2 flex-col items-center gap-1 font-mono text-[10px] tracking-[0.24em]">
      <span className="text-[9px] tracking-[0.32em] text-cyan-300/50">SYSTEM CORE</span>
      <span aria-hidden="true" className="text-cyan-300/30">↓</span>
      <span
        role="status"
        className={
          isDenied ? "text-amber-300/80" : "tracking-[0.22em] text-cyan-200"
        }
        style={{ color: isDenied ? "#fbbf24" : look.color }}
      >
        {isDenied ? `DENIED · ${denied?.toUpperCase()}` : "SCANNING"}
      </span>
      <span aria-hidden="true" className="text-cyan-300/30">↓</span>
      <span
        className="text-[11px] tracking-[0.18em]"
        style={{ color: isDenied ? "#fbbf24cc" : look.color }}
      >
        {isDenied ? denied?.toUpperCase().replace(/_/g, " ") : activity?.tool.toUpperCase().replace(/_/g, " ")}
      </span>
      {activity && (
        <span
          className={`mt-1 rounded-sm border px-2 py-0.5 text-[8px] tracking-[0.28em] ${
            activity.risk === "high"
              ? "border-amber-300/40 bg-amber-300/10 text-amber-300"
              : activity.risk === "medium"
                ? "border-violet-300/30 bg-violet-300/10 text-violet-200"
                : "border-cyan-300/30 bg-cyan-300/10 text-cyan-200"
          }`}
        >
          RISK · {activity.risk.toUpperCase()}
        </span>
      )}
      {/* P0.2 — the run model's live step, in the same idiom (no boxes). It
          rides below the tool line and shows through whenever a step is
          current, including after `done` clears the tool activity. */}
      {!activity && !denied && step && (
        <span
          role="status"
          data-testid="hud-step"
          className="tracking-[0.22em] text-cyan-200"
        >
          {`STEP · ${step.kind.replace(/_/g, " ").toUpperCase()} · ${step.status.replace(/_/g, " ").toUpperCase()}${step.tool ? ` · ${step.tool.toUpperCase().replace(/_/g, " ")}` : ""}`}
        </span>
      )}
    </div>
  );
}

/** Live/offline indicator — §18 */
export function LiveIndicator() {
  const mode = useFridayStore((s) => s.liveMode);
  const sessionError = useFridayStore((s) => s.sessionError);
  const memories = useFridayStore((s) => s.memories);
  const [waking, setWaking] = useState(false);
  useEffect(() => {
    // Synchronous reset is intentional: leaving `connecting` must clear a
    // stale WAKING… on the same commit, not after another timeout fires.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (mode !== "connecting") { setWaking(false); return; }
    const id = setTimeout(() => setWaking(true), 2000);
    return () => clearTimeout(id);
  }, [mode]);
  if (mode === "idle" && !sessionError && memories.length === 0) return null;
  const label =
    mode === "live"
      ? "LIVE CORE"
      : mode === "offline"
        ? "OFFLINE DEMO"
        : mode === "connecting"
          ? (waking ? "WAKING…" : "CONNECTING")
          : null;
  if (!label && !sessionError && memories.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-8 top-[4.5rem] flex flex-col gap-1 font-mono text-[9px] tracking-[0.22em]">
      {label && (
        <span className={mode === "live" ? "text-emerald-300/80" : mode === "offline" ? "text-amber-300/80" : "text-cyan-300/60"}>
          {label}
          <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle opacity-70" style={{ background: mode === "live" ? "#6ee7b7" : mode === "offline" ? "#fbbf24" : "#38e8ff" }} />
        </span>
      )}
      {/* A turn is in flight and every other control is disabled — this is the
          only moment ESC does anything, so it is the only moment to say so. */}
      {(mode === "connecting" || mode === "live" || mode === "offline") && (
        <span className="text-cyan-300/60">ESC · CANCEL</span>
      )}
      {/* role="alert" rather than a pre-mounted live region: this span is
          inserted only when a turn fails, and an injected alert is the one
          pattern screen readers announce reliably without one. */}
      {sessionError && (
        <span role="alert" className="max-w-[20rem] break-words text-red-300/70">
          {sessionError.toUpperCase()}
        </span>
      )}
      {sessionError && /refused|rate limited/i.test(sessionError) && (
        <span role="alert" className="text-red-300/70">REFUSED · RETRY LATER</span>
      )}
      {memories.length > 0 && (
        // Same amber idiom as DENIED: both are recent events the operator
        // must see, and a line written to permanent memory deserves no less
        // attention than a denied tool.
        <span role="status" className="text-amber-300/80">
          LEARNED · {memories[0].fact.toUpperCase()}
          {memories[0].provenance === "tool" && " · FROM WEB"}
        </span>
      )}
    </div>
  );
}

