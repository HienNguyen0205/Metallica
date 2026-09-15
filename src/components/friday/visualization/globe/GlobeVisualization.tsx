"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, Vector3, type DirectionalLight } from "three";
import { useFridayStore, type GeoPoint, type GlobeRoute } from "@/lib/store";
import { GLOBE_DEMO_POINTS, GLOBE_DEMO_ROUTES } from "@/lib/visualization/globeDemo";
import { STATE_LOOK } from "@/lib/stateLook";
import { TechLabel, useMaterialize } from "../../primitives";
import { GlobeEarth } from "./GlobeEarth";
import { GlobeMarkers } from "./GlobeMarkers";
import { GlobeRoutes } from "./GlobeRoutes";
import { useGlobeInteraction, GLOBE_CENTER } from "./useGlobeInteraction";
import {
  SUN_DIRECTION,
  SUN_CYCLE_SECONDS,
  globeFocusFor,
  markerLabel,
  resolveGlobeQuality,
  sunDirectionAt,
} from "./geo";

export interface GlobeProps {
  points?: GeoPoint[];
  routes?: GlobeRoute[];
  color: string;
  accent: string;
}

const R = 1.8;

/**
 * §6 location → realistic interactive Earth.
 *
 * Layer order (back to front): atmosphere halo, surface, night speckle,
 * clouds, wireframe accent, routes, particles, markers, labels (§49).
 * Rotation/zoom/focus turn the planet group itself — the camera rig keeps
 * sole ownership of the camera, so the two never fight (§60).
 */
export function Globe3D({ points, routes, color }: GlobeProps) {
  // An explicitly empty point list is a real empty state (§72) — the demo
  // fallback only applies when no data was provided at all. Demo content is
  // single-sourced in `lib/visualization/globeDemo` (shared with the planner).
  const data = points ?? GLOBE_DEMO_POINTS;
  const inputRoutes = routes ?? GLOBE_DEMO_ROUTES;
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
  const selectedLabel = focus?.owner === "globe" ? focus.key : null;

  // While mounted, this visualization owns the camera for geographic
  // navigation; the cinematic rig yields and resumes on unmount (§16).
  useEffect(() => {
    useFridayStore.getState().acquireGlobeCamera();
    return () => useFridayStore.getState().releaseGlobeCamera();
  }, []);

  const getFocusTarget = useCallback(() => {
    if (!focus || focus.owner !== "globe") return null;
    const hit = data.find((p, i) => markerLabel(p, i) === focus.key);
    return hit ? { lat: hit.lat, lon: hit.lon } : null;
  }, [data, focus]);

  const { spinRef, handlers, focusOn } = useGlobeInteraction({ getFocusTarget });

  const handleFocusMarker = useCallback(
    (p: GeoPoint, index: number) => {
      // Camera flies AND store focus sets — selection highlight, dimming,
      // route emphasis and the `F` key all read from the same focus.
      focusOn({ lat: p.lat, lon: p.lon });
      useFridayStore.getState().setFocus(globeFocusFor(p, index));
    },
    [focusOn],
  );

  // Expose for e2e debugging (only in dev)

  // Slow terminator cycle: the sun drifts in world space so day/night keeps
  // sweeping even when the planet's own spin is idle or focused (the spin
  // already moves the terminator via world normals; this adds motion that is
  // independent of it). Paused by reduced-motion and the shared Space motion
  // flag. `sunDir` is shared with GlobeEarth's terminator uniform; the
  // directional light tracks the same direction so specular stays coherent.
  const sunDir = useMemo(() => new Vector3(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]), []);
  const sunPhase = useRef(0);
  const lightRef = useRef<DirectionalLight>(null);
  useFrame((_, delta) => {
    if (!(reduced || useFridayStore.getState().motionPaused)) {
      sunPhase.current += Math.min(delta, 0.05) * ((Math.PI * 2) / SUN_CYCLE_SECONDS);
      const d = sunDirectionAt(sunPhase.current);
      sunDir.set(d[0], d[1], d[2]);
    }
    if (lightRef.current) lightRef.current.position.copy(sunDir).multiplyScalar(8);
  });

  // Staggered materialize: surface first, data last (§43 — fast, not theatrical).
  const matSurface = useMaterialize(0.8, true, 0.25);
  const matData = useMaterialize(0.8, true, 0.85);

  const resolvedRoutes = inputRoutes.filter((r) => r && (typeof r.from === "string" || typeof r.from === "number"));

  return (
    <group position={GLOBE_CENTER}>
      {/* Sun fixed in world space; the planet turns beneath it and the sun
          itself drifts slowly (§ terminator cycle). */}
      <directionalLight
        ref={lightRef}
        position={[SUN_DIRECTION[0] * 8, SUN_DIRECTION[1] * 8, SUN_DIRECTION[2] * 8]}
        intensity={2.2}
        color="#fff1dc"
      />
      <group>
        <group ref={spinRef} {...handlers}>
          <group ref={matSurface}>
            <GlobeEarth
              radius={R}
              segments={q.segments}
              color={color}
              detail={q.quality !== "low"}
              reduced={reduced}
              sunDir={sunDir}
            />
          </group>
          <group ref={matData}>
            <GlobeMarkers
              points={data}
              radius={R}
              selectedLabel={selectedLabel}
              reduced={reduced}
              onFocusMarker={handleFocusMarker}
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
        {/* Equatorial guide ring stays fixed while the globe turns — deliberately
            faint; it is an interaction affordance, not a frame (§11). */}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[R + 0.22, R + 0.235, 96]} />
          <meshBasicMaterial color={color} transparent opacity={selectedLabel ? 0.3 : 0.12} side={DoubleSide} depthWrite={false} />
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
