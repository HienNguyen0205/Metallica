"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { type Group } from "three";
import { useFridayStore } from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import { useTelemetry } from "@/lib/telemetry";
import {
  ArcSegments,
  CornerBrackets,
  Reticle,
  TechLabel,
  TickDial,
} from "../primitives";

/** The big framing arcs — large radial geometry cropped by the viewport. */
function OuterFrame({ color, speed, dim = 1 }: { color: string; speed: number; dim?: number }) {
  const slow = useRef<Group>(null);
  const fast = useRef<Group>(null);

  useFrame((_, delta) => {
    if (slow.current) slow.current.rotation.z += delta * speed * 0.12;
    if (fast.current) fast.current.rotation.z -= delta * speed * 0.3;
  });

  return (
    <group position={[0, 0, -1.2]}>
      <group ref={slow}>
        {/* two broken arcs left and right, like the reference's HUD frame */}
        <ArcSegments radius={3.5} count={30} span={Math.PI * 0.62} start={-Math.PI * 0.31} gap={0.35} thickness={0.022} color={color} opacity={0.3 * dim} majorEvery={6} />
        <ArcSegments radius={3.5} count={30} span={Math.PI * 0.62} start={Math.PI * 0.69} gap={0.35} thickness={0.022} color={color} opacity={0.3 * dim} majorEvery={6} />
        <ArcSegments radius={4.15} count={16} span={Math.PI * 0.3} start={-Math.PI * 0.15} gap={0.5} thickness={0.03} color={color} opacity={0.2 * dim} />
        <ArcSegments radius={4.15} count={16} span={Math.PI * 0.3} start={Math.PI * 0.85} gap={0.5} thickness={0.03} color={color} opacity={0.2 * dim} />
      </group>
      <group ref={fast}>
        <TickDial radius={3.15} count={120} color={color} opacity={0.18 * dim} length={0.07} />
      </group>
    </group>
  );
}

/** Measured refresh rate — was hardcoded 60HZ, which contradicted reality. */
function SyncReadout({ color }: { color: string }) {
  const t = useTelemetry();
  return (
    <TechLabel position={[2.55, -1.86, 0.2]} color={color} size={0.05} opacity={0.35} anchorX="right" capacity={18}>
      {`FRAME SYNC · ${t.fps > 0 ? t.fps.toFixed(0) : "--"}HZ`}
    </TechLabel>
  );
}

/**
 * §3 — the spatial HUD wrapped around the core: background grid, big framing
 * arcs, reticles and readouts at three different depths.
 */
export default function SpatialHud({ reduced = false }: { reduced?: boolean }) {
  const state = useFridayStore((s) => s.state);
  const look = STATE_LOOK[state];
  const drift = useRef<Group>(null);
  /**
   * Ambient chrome competes directly with chart geometry — the dotted grid in
   * particular sat right behind every line and bar. It steps back while a
   * visualization holds the frame instead of being read as data.
   */
  const hasViz = useFridayStore((s) => s.visualizations.length > 0);

  useFrame(() => {
    if (!drift.current) return;
    // midground drifts slightly against the camera rig for parallax
    drift.current.rotation.z = Math.sin(performance.now() * 0.0002) * 0.03;
  });

  return (
    <group>
      {!reduced && (
        <group ref={drift}>
          <OuterFrame color={look.color} speed={look.ringSpeed} dim={hasViz ? 0.45 : 1} />
        </group>
      )}

      {/* foreground framing */}
      <CornerBrackets half={2.62} arm={0.4} z={1.5} color={look.color} opacity={hasViz ? 0.18 : 0.35} />

      {/* reticles marking cardinal points of the core */}
      {!reduced && !hasViz && (
        <>
          <Reticle position={[-3.05, 1.32, -0.4]} color={look.color} opacity={0.4} />
          <Reticle position={[3.05, -1.32, -0.4]} color={look.color} opacity={0.4} />
        </>
      )}

      {/* §5 spatial telemetry — readouts floating in depth */}
      <SyncReadout color={look.color} />
    </group>
  );
}
