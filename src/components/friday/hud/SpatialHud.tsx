"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { DoubleSide, type Group, type Mesh } from "three";
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
import { createHoloGridMaterial } from "../effects/materials";

/** §3 background layer — dotted grid far behind the core, one draw call. */
function DottedGrid({ color, opacity = 0.42 }: { color: string; opacity?: number }) {
  // This layer used to disappear entirely on WebGPU — the dot pattern lives in
  // the fragment shader and there was no node equivalent to swap in. As TSL it
  // renders on both backends, which is the point of the move.
  const { material, apply } = useMemo(() => createHoloGridMaterial({ opacity }), [opacity]);

  useEffect(() => () => material.dispose(), [material]);
  useFrame(() => apply(color));

  return (
    <mesh position={[0, 0, -4.5]}>
      <planeGeometry args={[26, 16]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

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

/** A slim vertical progress column — telemetry furniture, not a card. */
function LevelColumn({
  position,
  label,
  value,
  color,
}: {
  position: [number, number, number];
  label: string;
  value: number;
  color: string;
}) {
  const fillRef = useRef<Mesh>(null);
  useFrame(() => {
    if (!fillRef.current) return;
    const target = Math.max(0.02, value / 100);
    fillRef.current.scale.y += (target - fillRef.current.scale.y) * 0.08;
    fillRef.current.position.y = -0.5 + fillRef.current.scale.y / 2;
  });

  return (
    <group position={position}>
      <mesh>
        <planeGeometry args={[0.035, 1]} />
        <meshBasicMaterial color={color} transparent opacity={0.12} side={DoubleSide} depthWrite={false} />
      </mesh>
      <mesh ref={fillRef} scale={[1, 0.02, 1]}>
        <planeGeometry args={[0.035, 1]} />
        <meshBasicMaterial color={color} transparent opacity={0.7} side={DoubleSide} toneMapped={false} depthWrite={false} />
      </mesh>
      <TechLabel position={[0, 0.62, 0]} color="#e5f6ff" size={0.05} opacity={0.7}>
        {String(value)}
      </TechLabel>
      <TechLabel position={[0, -0.62, 0]} color={color} size={0.05} opacity={0.6}>
        {label}
      </TechLabel>
    </group>
  );
}

/** Pitch wide enough that neighbouring 3-glyph labels never touch. */
const COLUMN_PITCH = 0.3;

/** Narrower than this (world units) and the columns crowd the core. */
const MIN_FRAME_WIDTH = 7.4;

/**
 * Level columns are ambient furniture: anchored to the frame edge rather than
 * a fixed world X (which collided with the radial gauge's outer nodes and fell
 * off-screen on narrow frames), and they stand down entirely while a
 * visualization is on screen so nothing can overlap the actual data.
 */
const COLUMN_PLANE_Z = 0.3;
/** Clear of the frame edge, with room for the widest label glyphs. */
const COLUMN_INSET = 0.5;

function LevelColumns({ color, accent }: { color: string; accent: string }) {
  const viewportWidth = useThree((s) => s.viewport.width);
  const visualization = useFridayStore((s) => s.visualization);
  const groupRef = useRef<Group>(null);
  const t = useTelemetry();

  /**
   * Re-anchored every frame rather than computed once from viewport.width.
   * That width is measured at z=0, but these sit nearer the camera where the
   * frustum is narrower, and the camera drifts horizontally — using the z=0
   * width pushed the first column off the left edge whenever the rig dollied in.
   */
  useFrame((state) => {
    if (!groupRef.current) return;
    const { camera, viewport } = state;
    const distance = camera.position.z;
    const halfAtPlane = (viewport.width / 2) * ((distance - COLUMN_PLANE_Z) / distance);
    groupRef.current.position.x = camera.position.x - halfAtPlane + COLUMN_INSET;
  });

  if (visualization || viewportWidth < MIN_FRAME_WIDTH) return null;

  // real where a real source exists; NET falls back to a link estimate
  const pwr = Math.min(100, (t.fps / 60) * 100);
  const mem = t.heapRatio > 0 ? t.heapRatio * 100 : 54;
  const net = t.downlink > 0 ? Math.min(100, t.downlink * 10) : 91;

  return (
    <group ref={groupRef} position={[0, 0, COLUMN_PLANE_Z]}>
      <LevelColumn position={[0, 0, 0]} label="PWR" value={Math.round(pwr)} color={color} />
      <LevelColumn position={[COLUMN_PITCH, 0, 0]} label="MEM" value={Math.round(mem)} color={color} />
      <LevelColumn position={[COLUMN_PITCH * 2, 0, 0]} label="NET" value={Math.round(net)} color={accent} />
    </group>
  );
}

/** Measured refresh rate — was hardcoded 60HZ, which contradicted reality. */
function SyncReadout({ color }: { color: string }) {
  const t = useTelemetry();
  return (
    <TechLabel position={[2.55, -1.86, 0.2]} color={color} size={0.05} opacity={0.35} anchorX="right">
      {`FRAME SYNC · ${t.fps > 0 ? t.fps.toFixed(0) : "--"}HZ`}
    </TechLabel>
  );
}

/** Live camera coordinates — the readout the reticles imply. */
function CoordReadout({ color }: { color: string }) {
  const t = useTelemetry();
  return (
    <TechLabel position={[-2.55, 1.86, 0.2]} color={color} size={0.05} opacity={0.35} anchorX="left">
      {`X ${t.camera[0].toFixed(3)} · Y ${t.camera[1].toFixed(3)} · Z ${t.camera[2].toFixed(3)}`}
    </TechLabel>
  );
}

/**
 * §3 — the spatial HUD wrapped around the core: background grid, big framing
 * arcs, reticles, coordinates and level columns at three different depths.
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
  const hasViz = useFridayStore((s) => !!s.visualization);

  useFrame(() => {
    if (!drift.current) return;
    // midground drifts slightly against the camera rig for parallax
    drift.current.rotation.z = Math.sin(performance.now() * 0.0002) * 0.03;
  });

  return (
    <group>
      <DottedGrid color={look.color} opacity={hasViz ? 0.14 : 0.42} />

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

      {/* §5 spatial telemetry — coordinates and readouts floating in depth */}
      <TechLabel position={[-2.55, 2.02, 0.2]} color={look.color} size={0.062} opacity={0.55} anchorX="left">
        SECTOR 07 · ORBIT LOCK
      </TechLabel>
      <CoordReadout color={look.color} />
      <SyncReadout color={look.color} />

      {!reduced && (
        <LevelColumns color={look.color} accent={look.accent} />
      )}
    </group>
  );
}
