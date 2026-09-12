"use client";

import { useCallback, useEffect, useState } from "react";
import { DoubleSide } from "three";
import { useFridayStore, type GeoPoint, type GlobeRoute } from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import { TechLabel, useMaterialize } from "../../primitives";
import { GlobeEarth } from "./GlobeEarth";
import { GlobeMarkers } from "./GlobeMarkers";
import { GlobeRoutes } from "./GlobeRoutes";
import { useGlobeInteraction } from "./useGlobeInteraction";
import { SUN_DIRECTION, markerLabel, resolveGlobeQuality } from "./geo";

export interface GlobeProps {
  points?: GeoPoint[];
  routes?: GlobeRoute[];
  color: string;
  accent: string;
}

const DEFAULT_GEO: GeoPoint[] = [
  { id: "HAN", lat: 21.03, lon: 105.85, label: "HAN" },
  { id: "SIN", lat: 1.35, lon: 103.82, label: "SIN" },
  { id: "SFO", lat: 37.77, lon: -122.42, label: "SFO" },
  { id: "FRA", lat: 50.11, lon: 8.68, label: "FRA" },
];

const R = 1.8;

/**
 * §6 location → realistic interactive Earth.
 *
 * Layer order (back to front): atmosphere halo, surface, night speckle,
 * clouds, wireframe accent, routes, particles, markers, labels (§49).
 * Rotation/zoom/focus turn the planet group itself — the camera rig keeps
 * sole ownership of the camera, so the two never fight (§60).
 */
export function Globe3D({ points, routes = [], color, accent }: GlobeProps) {
  // An explicitly empty point list is a real empty state (§72) — the demo
  // fallback only applies when no data was provided at all.
  const data = points ?? DEFAULT_GEO;
  const [reduced, setReduced] = useState(false);
  const qualityPref = useFridayStore((s) => s.quality);
  const focus = useFridayStore((s) => s.focus);
  const state = useFridayStore((s) => s.state);
  const liveMode = useFridayStore((s) => s.liveMode);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const q = resolveGlobeQuality({ preference: qualityPref, systemReduced: reduced });
  const look = STATE_LOOK[state];
  const selectedLabel = focus?.label ?? null;

  const getFocusTarget = useCallback(() => {
    if (!focus) return null;
    const hit = data.find((p, i) => markerLabel(p, i) === focus.label);
    return hit ? { lat: hit.lat, lon: hit.lon } : null;
  }, [data, focus]);

  const { spinRef, zoomRef, handlers, focusOn } = useGlobeInteraction({ getFocusTarget });

  // Staggered materialize: surface first, data last (§43 — fast, not theatrical).
  const matSurface = useMaterialize(0.8, true, 0.25);
  const matData = useMaterialize(0.8, true, 0.85);

  const resolvedRoutes = routes.filter((r) => r && (typeof r.from === "string" || typeof r.from === "number"));

  return (
    <group position={[0, 0.2, -0.6]}>
      {/* Fixed sun: the terminator stays put while the planet turns beneath it. */}
      <directionalLight
        position={[SUN_DIRECTION[0] * 8, SUN_DIRECTION[1] * 8, SUN_DIRECTION[2] * 8]}
        intensity={2.2}
        color="#fff1dc"
      />
      <group ref={zoomRef}>
        <group ref={spinRef} {...handlers}>
          <group ref={matSurface}>
            <GlobeEarth
              radius={R}
              segments={q.segments}
              color={color}
              showClouds={q.clouds}
              reduced={reduced}
            />
          </group>
          <group ref={matData}>
            <GlobeMarkers
              points={data}
              radius={R}
              accent={accent}
              selectedLabel={selectedLabel}
              reduced={reduced}
              onFocusMarker={(p) => focusOn({ lat: p.lat, lon: p.lon })}
            />
            <GlobeRoutes
              points={data}
              routes={resolvedRoutes}
              radius={R}
              color={color}
              selectedLabel={selectedLabel}
              particleScale={q.particleScale}
              particleSpeed={look.particleIntensity}
              reduced={reduced}
            />
          </group>
        </group>
        {/* Equatorial guide ring stays fixed while the globe turns. */}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[R + 0.22, R + 0.235, 96]} />
          <meshBasicMaterial color={color} transparent opacity={0.3} side={DoubleSide} depthWrite={false} />
        </mesh>
      </group>
      {data.length === 0 ? (
        <TechLabel position={[0, -R - 0.5, 0]} color={color} size={0.075} opacity={0.8} decode>
          NO ACTIVE NODES
        </TechLabel>
      ) : (
        <TechLabel position={[0, -R - 0.5, 0]} color={color} size={0.055} opacity={0.55}>
          {`${data.length} ACTIVE NODES${resolvedRoutes.length === 0 ? " · NO ACTIVE ROUTES" : ` · ${resolvedRoutes.length} ROUTES`} · SOURCE ${liveMode === "live" ? "LIVE" : "SIMULATED"}`}
        </TechLabel>
      )}
    </group>
  );
}
