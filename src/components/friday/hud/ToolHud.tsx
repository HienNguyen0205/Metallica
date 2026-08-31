"use client";

import { useFridayStore } from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";

/**
 * §2/§11 — spatial tool instrumentation HUD.
 * Not a card: tiny telemetry floating near core, showing what FRIDAY is doing.
 */
export function ToolHud() {
  const activity = useFridayStore((s) => s.toolActivity);
  const denied = useFridayStore((s) => s.deniedTool);
  const state = useFridayStore((s) => s.state);
  const look = STATE_LOOK[state];

  if (!activity && !denied) return null;

  const isDenied = !!denied && !activity;

  return (
    <div className="pointer-events-none absolute left-1/2 top-[42%] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 font-mono text-[10px] tracking-[0.24em]">
      <span className="text-[9px] tracking-[0.32em] text-cyan-300/50">SYSTEM CORE</span>
      <span className="text-cyan-300/30">↓</span>
      <span
        className={
          isDenied ? "text-amber-300/80" : "animate-pulse tracking-[0.22em] text-cyan-200"
        }
        style={{ color: isDenied ? "#fbbf24" : look.color }}
      >
        {isDenied ? `DENIED · ${denied?.toUpperCase()}` : "SCANNING"}
      </span>
      <span className="text-cyan-300/30">↓</span>
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
      {activity?.tool === "get_system_metrics" && !isDenied && (
        <div className="mt-3 flex gap-4 text-[8px] tracking-[0.14em] text-cyan-200/60">
          <span>CPU</span>
          <span>RAM</span>
          <span>DISK</span>
        </div>
      )}
    </div>
  );
}

/** Live/offline indicator — §18 */
export function LiveIndicator() {
  const mode = useFridayStore((s) => s.liveMode);
  const sessionError = useFridayStore((s) => s.sessionError);
  const memories = useFridayStore((s) => s.memories);
  if (mode === "idle" && !sessionError && memories.length === 0) return null;
  const label =
    mode === "live"
      ? "LIVE CORE"
      : mode === "offline"
        ? "OFFLINE DEMO"
        : mode === "connecting"
          ? "CONNECTING"
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
      {memories.length > 0 && (
        // Cùng lối amber như DENIED: cả hai là chuyện vừa xảy ra mà operator
        // cần nhìn thấy, và một dòng ghi vào ký ức vĩnh viễn thì đáng chú ý
        // không kém một tool bị từ chối.
        <span role="status" className="text-amber-300/80">
          LEARNED · {memories[0].fact.toUpperCase()}
          {memories[0].provenance === "tool" && " · FROM WEB"}
        </span>
      )}
    </div>
  );
}
