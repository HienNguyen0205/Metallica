"use client";

import { Suspense, useEffect } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useFridayStore } from "@/lib/store";
import { sampleSpec } from "@/lib/vizPlanner";
import { toAccessibleSummary } from "@/components/friday/visualization/globe/geo";
import { getApiBase } from "@/lib/api/session";
import type { VisualizationType } from "@/lib/visualization/types";

const Scene = dynamic(() => import("@/components/friday/Scene"), { ssr: false });

const KNOWN: VisualizationType[] = ["radial_gauge","radar","waveform","network","line_3d","bar_3d","globe","timeline","sankey_flow"];

function VizDeepLink() {
  const params = useSearchParams();
  useEffect(() => {
    const viz = params.get("viz");
    if (!viz || !KNOWN.includes(viz as VisualizationType)) return;
    const s = useFridayStore.getState();
    if (s.visualizations.length > 0) return;
    s.setLiveMode("offline");
    s.addVisualization(sampleSpec(viz as VisualizationType));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  return null;
}

/** Screen-reader mirror of the canvas globe — WebGL is never parsed by AT. */
function GlobeA11y() {
  const globeData = useFridayStore((s) => s.visualizations.find((e) => e.spec.type === "globe")?.spec.data);
  if (!globeData) return null;
  return (
    <p className="sr-only" role="status">
      {toAccessibleSummary(globeData)}
    </p>
  );
}

export default function SceneIsland() {
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    fetch(`${getApiBase()}/health`, { signal: ctrl.signal })
      .catch(() => {})
      .finally(() => { if (!cancelled) clearTimeout(t); });
    return () => { cancelled = true; ctrl.abort(); };
  }, []);
  return (
    <>
      <Suspense fallback={null}>
        <VizDeepLink />
      </Suspense>
      <GlobeA11y />
      <Scene />
    </>
  );
}
