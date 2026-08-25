"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group, Mesh } from "three";
import { ArcSegments, TickDial } from "../primitives";
import "../effects/materials";

interface HoloUniforms {
  uTime: number;
  uScanSpeed: number;
}

/** A single tilted torus using the hologram shader (or a basic ring in compat mode). */
function HoloRing({
  radius,
  speed,
  tilt,
  color,
  thickness = 0.012,
  scanSpeed = 0.6,
  compat = false,
}: {
  radius: number;
  speed: number;
  tilt: [number, number, number];
  color: string;
  thickness?: number;
  scanSpeed?: number;
  compat?: boolean;
}) {
  const ref = useRef<Mesh>(null);
  const matRef = useRef<HoloUniforms>(null);

  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.z += delta * speed;
    if (matRef.current && !compat) {
      matRef.current.uTime += delta;
      matRef.current.uScanSpeed = scanSpeed;
    }
  });

  return (
    <mesh ref={ref} rotation={tilt}>
      <torusGeometry args={[radius, thickness, 8, 128]} />
      {compat ? (
        <meshBasicMaterial color={color} transparent opacity={0.45} toneMapped={false} depthWrite={false} />
      ) : (
        <hologramMaterial ref={matRef} uColor={color} transparent depthWrite={false} />
      )}
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
  compat = false,
}: {
  color: string;
  accent: string;
  speed: number;
  scanSpeed: number;
  compat?: boolean;
}) {
  return (
    <group>
      {/* inner dial, tight to the shell */}
      <group rotation={[Math.PI / 2.3, 0, 0]}>
        <TickDial radius={1.02} count={72} color={color} opacity={0.5} length={0.05} />
      </group>

      {/* mid hologram rings on three different planes */}
      <HoloRing radius={1.28} speed={speed} tilt={[Math.PI / 2.3, 0, 0]} color={color} scanSpeed={scanSpeed} compat={compat} />
      <HoloRing radius={1.55} speed={-speed * 0.7} tilt={[Math.PI / 3, Math.PI / 5, 0]} color={accent} thickness={0.008} scanSpeed={scanSpeed} compat={compat} />
      <HoloRing radius={1.82} speed={speed * 0.45} tilt={[-Math.PI / 2.6, 0, Math.PI / 6]} color={color} thickness={0.006} scanSpeed={scanSpeed} compat={compat} />

      {/* dashed technical rings */}
      <SpinningArcs radius={1.42} speed={-speed * 1.4} tilt={[Math.PI / 2.3, 0, 0]} color={color} count={64} gap={0.55} thickness={0.012} opacity={0.4} majorEvery={8} />
      <SpinningArcs radius={2.35} speed={speed * 0.5} tilt={[Math.PI / 2.15, 0, 0]} color={color} count={90} gap={0.6} thickness={0.014} opacity={0.32} majorEvery={9} />

      {/* broken outer arcs — partial spans read as a HUD frame, not a circle */}
      <SpinningArcs radius={2.75} speed={-speed * 0.28} tilt={[Math.PI / 2.05, 0, 0]} color={accent} count={22} span={Math.PI * 0.55} gap={0.3} thickness={0.02} opacity={0.35} />
      <SpinningArcs radius={2.75} speed={-speed * 0.28} tilt={[Math.PI / 2.05, 0, Math.PI]} color={accent} count={22} span={Math.PI * 0.55} gap={0.3} thickness={0.02} opacity={0.35} />
    </group>
  );
}
