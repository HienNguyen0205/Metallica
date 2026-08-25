"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, type Group, type Mesh } from "three";
import { useFridayStore } from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import { ArcSegments, CornerBrackets, Reticle, TechLabel, TickDial } from "../primitives";
import "../effects/materials";

interface GridUniforms {
  uTime: number;
}

/** §3 background layer — dotted grid far behind the core, one draw call. */
function DottedGrid({ color }: { color: string }) {
  const matRef = useRef<GridUniforms>(null);
  useFrame((_, delta) => {
    if (matRef.current) matRef.current.uTime += delta;
  });
  return (
    <mesh position={[0, 0, -4.5]}>
      <planeGeometry args={[26, 16]} />
      <holoGridMaterial ref={matRef} uColor={color} uOpacity={0.42} transparent depthWrite={false} />
    </mesh>
  );
}

/** The big framing arcs — large radial geometry cropped by the viewport. */
function OuterFrame({ color, speed }: { color: string; speed: number }) {
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
        <ArcSegments radius={3.5} count={30} span={Math.PI * 0.62} start={-Math.PI * 0.31} gap={0.35} thickness={0.022} color={color} opacity={0.3} majorEvery={6} />
        <ArcSegments radius={3.5} count={30} span={Math.PI * 0.62} start={Math.PI * 0.69} gap={0.35} thickness={0.022} color={color} opacity={0.3} majorEvery={6} />
        <ArcSegments radius={4.15} count={16} span={Math.PI * 0.3} start={-Math.PI * 0.15} gap={0.5} thickness={0.03} color={color} opacity={0.2} />
        <ArcSegments radius={4.15} count={16} span={Math.PI * 0.3} start={Math.PI * 0.85} gap={0.5} thickness={0.03} color={color} opacity={0.2} />
      </group>
      <group ref={fast}>
        <TickDial radius={3.15} count={120} color={color} opacity={0.18} length={0.07} />
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
      <TechLabel position={[0, -0.65, 0]} color={color} size={0.055} opacity={0.6}>
        {label}
      </TechLabel>
    </group>
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

  useFrame(() => {
    if (!drift.current) return;
    // midground drifts slightly against the camera rig for parallax
    drift.current.rotation.z = Math.sin(performance.now() * 0.0002) * 0.03;
  });

  return (
    <group>
      <DottedGrid color={look.color} />

      {!reduced && (
        <group ref={drift}>
          <OuterFrame color={look.color} speed={look.ringSpeed} />
        </group>
      )}

      {/* foreground framing */}
      <CornerBrackets half={2.62} arm={0.4} z={1.5} color={look.color} opacity={0.35} />

      {/* reticles marking cardinal points of the core */}
      {!reduced && (
        <>
          <Reticle position={[-3.05, 1.32, -0.4]} color={look.color} opacity={0.4} />
          <Reticle position={[3.05, -1.32, -0.4]} color={look.color} opacity={0.4} />
        </>
      )}

      {/* §5 spatial telemetry — coordinates and readouts floating in depth */}
      <TechLabel position={[-2.55, 2.02, 0.2]} color={look.color} size={0.062} opacity={0.55} anchorX="left">
        SECTOR 07 · ORBIT LOCK
      </TechLabel>
      <TechLabel position={[-2.55, 1.86, 0.2]} color={look.color} size={0.05} opacity={0.35} anchorX="left">
        X 1.284 · Y 0.442 · Z 6.800
      </TechLabel>
      <TechLabel position={[2.55, -1.86, 0.2]} color={look.color} size={0.05} opacity={0.35} anchorX="right">
        FRAME SYNC · 60HZ
      </TechLabel>

      {!reduced && (
        <group position={[-3.35, 0, 0.3]}>
          <LevelColumn position={[0, 0, 0]} label="PWR" value={78} color={look.color} />
          <LevelColumn position={[0.16, 0, 0]} label="MEM" value={54} color={look.color} />
          <LevelColumn position={[0.32, 0, 0]} label="NET" value={91} color={look.accent} />
        </group>
      )}
    </group>
  );
}
