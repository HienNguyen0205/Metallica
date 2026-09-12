"use client";

import { useFridayStore } from "@/lib/store";
import { useTelemetry } from "@/lib/telemetry";

/** §3 — thin telemetry at the screen edges. No panels, no boxes. */
export function EdgeTelemetry() {
  const audioEnabled = useFridayStore((s) => s.audioEnabled);
  const toggleAudio = useFridayStore((s) => s.toggleAudio);
  const focus = useFridayStore((s) => s.focus);
  const renderBackend = useFridayStore((s) => s.renderBackend);
  const quality = useFridayStore((s) => s.quality);
  const setQuality = useFridayStore((s) => s.setQuality);
  const t = useTelemetry();
  const liveMode = useFridayStore((s) => s.liveMode);
  // Link telemetry only shows while a turn is in flight — once the backend
  // finishes, the frame belongs to the core again, not to numbers.
  const busy = liveMode !== "idle";

  const uplink = t.downlink > 0 ? `${t.downlink.toFixed(1)}MB/S` : "STABLE";
  const memory =
    t.heapMB > 0 ? `${t.heapMB.toFixed(0)}MB · ${(t.heapRatio * 100).toFixed(0)}%` : "NOMINAL";

  return (
    // One column on the right edge. Link telemetry used to sit bottom-left —
    // exactly where the core docks under a visualization, so the two overlapped.
    <div className="absolute bottom-28 right-8 hidden flex-col items-end gap-1.5 font-mono text-[10px] tracking-[0.18em] text-cyan-300/75 md:flex">
      {busy && (
        <>
          <span>UPLINK · {uplink}</span>
          <span>FRAME · {t.frameMs > 0 ? `${t.frameMs.toFixed(1)}MS` : "—"}</span>
          <span>MEMORY · {memory}</span>
        </>
      )}
      <span data-testid="hud-focus" className={focus ? "text-cyan-200" : undefined}>
        {focus ? `FOCUS · ${focus.label} ${focus.detail}` : "FOCUS · --"}
      </span>
      <span>RENDER · {renderBackend.toUpperCase()}</span>
      <span>SYNC · {t.fps > 0 ? `${t.fps.toFixed(0)}HZ` : "—"}</span>
      <span>SECURITY · ARMED</span>
      <button onClick={toggleAudio} className="pointer-events-auto transition-colors hover:text-cyan-200">
        AUDIO · {audioEnabled ? "ON" : "OFF"}
      </button>
      <span className="flex gap-2" role="group" aria-label="Render quality">
        {(["auto", "high", "low"] as const).map((q) => (
          <button
            key={q}
            onClick={() => setQuality(q)}
            aria-pressed={quality === q}
            aria-label={`Render quality ${q}`}
            // colour alone did not read as "selected"
            className={`pointer-events-auto transition-colors hover:text-cyan-200 ${
              quality === q ? "text-cyan-200 underline underline-offset-4" : ""
            }`}
          >
            {q.toUpperCase()}
          </button>
        ))}
      </span>
    </div>
  );
}
