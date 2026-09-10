"use client";

import { useFridayStore, type VisualizationType } from "@/lib/store";
import { sampleSpec } from "@/lib/vizPlanner";
import { devRailsEnabled } from "./devRails";

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
  "funnel_3d",
  "sankey_flow",
];

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
