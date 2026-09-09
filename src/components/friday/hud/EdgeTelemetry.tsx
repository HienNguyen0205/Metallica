"use client";

import { useFridayStore } from "@/lib/store";
import { useTelemetry } from "@/lib/telemetry";
import { useHudDepth } from "./useHudDepth";

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
        <span className="flex gap-2" role="group" aria-label="Render quality">
          {(["auto", "high", "low"] as const).map((q) => (
            <button
              key={q}
              onClick={() => setQuality(q)}
              aria-pressed={quality === q}
              aria-label={`Render quality ${q}`}
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
