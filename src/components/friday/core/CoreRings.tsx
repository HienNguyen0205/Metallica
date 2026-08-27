"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group, Mesh } from "three";
import { ArcSegments, TickDial } from "../primitives";
import { createHologramMaterial } from "../effects/materials";

/** A single tilted torus using the hologram material. */
function HoloRing({
  radius,
  speed,
  tilt,
  color,
  thickness = 0.012,
  scanSpeed = 0.6,
}: {
  radius: number;
  speed: number;
  tilt: [number, number, number];
  color: string;
  thickness?: number;
  scanSpeed?: number;
}) {
  const ref = useRef<Mesh>(null);
  // built once; colour and scan speed arrive as uniforms so a state change does
  // not recompile the shader
  const { material, apply } = useMemo(() => createHologramMaterial({}), []);

  useEffect(() => () => material.dispose(), [material]);

  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.z += delta * speed;
    apply(color, scanSpeed);
  });

  return (
    <mesh ref={ref} rotation={tilt}>
      <torusGeometry args={[radius, thickness, 8, 128]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

/** A dashed arc ring that rotates as a whole. */
function SpinningArcs({
  radius,
  speed,
  tilt,
  color,
  count,
  span = Math.PI * 2,
  gap = 0.45,
  thickness = 0.016,
  opacity = 0.5,
  majorEvery = 0,
}: {
  radius: number;
  speed: number;
  tilt: [number, number, number];
  color: string;
  count: number;
  span?: number;
  gap?: number;
  thickness?: number;
  opacity?: number;
  majorEvery?: number;
}) {
  const ref = useRef<Group>(null);
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.z += delta * speed;
  });
  return (
    <group rotation={tilt}>
      <group ref={ref}>
        <ArcSegments
          radius={radius}
          count={count}
          span={span}
          gap={gap}
          thickness={thickness}
          color={color}
          opacity={opacity}
          majorEvery={majorEvery}
        />
      </group>
    </group>
  );
}

/**
 * §2 layers 2–3 — concentric ring system at several scales, tilts and speeds,
 * the way the reference frames its central object.
 */
export default function CoreRings({
  color,
  accent,
  speed,
  scanSpeed,
}: {
  color: string;
  accent: string;
  speed: number;
  scanSpeed: number;
}) {
  return (
    <group>
      {/* inner dial, tight to the shell */}
      <group rotation={[Math.PI / 2.3, 0, 0]}>
        <TickDial radius={1.02} count={72} color={color} opacity={0.5} length={0.05} />
      </group>

      {/* mid hologram rings on three different planes */}
      <HoloRing radius={1.28} speed={speed} tilt={[Math.PI / 2.3, 0, 0]} color={color} scanSpeed={scanSpeed} />
      <HoloRing radius={1.55} speed={-speed * 0.7} tilt={[Math.PI / 3, Math.PI / 5, 0]} color={accent} thickness={0.008} scanSpeed={scanSpeed} />
      <HoloRing radius={1.82} speed={speed * 0.45} tilt={[-Math.PI / 2.6, 0, Math.PI / 6]} color={color} thickness={0.006} scanSpeed={scanSpeed} />

      {/* dashed technical rings */}
      <SpinningArcs radius={1.42} speed={-speed * 1.4} tilt={[Math.PI / 2.3, 0, 0]} color={color} count={64} gap={0.55} thickness={0.012} opacity={0.4} majorEvery={8} />
      <SpinningArcs radius={2.35} speed={speed * 0.5} tilt={[Math.PI / 2.15, 0, 0]} color={color} count={90} gap={0.6} thickness={0.014} opacity={0.32} majorEvery={9} />

      {/* broken outer arcs — partial spans read as a HUD frame, not a circle */}
      <SpinningArcs radius={2.75} speed={-speed * 0.28} tilt={[Math.PI / 2.05, 0, 0]} color={accent} count={22} span={Math.PI * 0.55} gap={0.3} thickness={0.02} opacity={0.35} />
      <SpinningArcs radius={2.75} speed={-speed * 0.28} tilt={[Math.PI / 2.05, 0, Math.PI]} color={accent} count={22} span={Math.PI * 0.55} gap={0.3} thickness={0.02} opacity={0.35} />
    </group>
  );
}
