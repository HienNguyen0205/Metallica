"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useFridayStore } from "@/lib/store";

/** maplibre-gl loads only the first time the map opens (spec §4.4). */
const MapStage = dynamic(() => import("./MapLayer"), {
  ssr: false,
  loading: () => (
    <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 rounded-full bg-slate-900/80 px-3 py-1 text-xs text-cyan-100">
      Đang tải bản đồ…
    </div>
  ),
});

export default function MapIsland() {
  const mode = useFridayStore((s) => s.mapView.mode);
  useEffect(() => {
    // globals.css hides the decorative HUD layers while this is "on" (spec §4.1).
    document.documentElement.dataset.map = mode === "globe" ? "off" : "on";
  }, [mode]);
  return mode === "globe" ? null : <MapStage />;
}
