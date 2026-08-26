"use client";

import { useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import { useFrame, useThree } from "@react-three/fiber";
import { AdditiveBlending, type BufferGeometry, type Points } from "three";
import { buildParticleField } from "./particleField";
import "../effects/materials";

// three/webgpu is a large separate build — only pull it in on the GPU path
const CoreParticlesGPU = dynamic(() => import("./CoreParticlesGPU"), { ssr: false });

interface ParticleUniforms {
  uTime: number;
  uColor: { set: (c: string) => void };
  uIntensity: number;
  uPixelRatio: number;
}

/**
 * §20 — one Points draw call, all orbital motion computed in the vertex
 * shader from per-particle attributes.
 * `compat` (WebGPU) hands off to the TSL node-material path, which runs the
 * same orbital maths through instanced sprites.
 */
export default function CoreParticles({
  count = 900,
  color,
  intensity = 1,
  mode = "orbit",
  innerRadius = 1.1,
  span = 2.6,
  compat = false,
}: {
  count?: number;
  color: string;
  intensity?: number;
  mode?: "orbit" | "flow";
  innerRadius?: number;
  span?: number;
  compat?: boolean;
}) {
  const matRef = useRef<ParticleUniforms>(null);
  const geoRef = useRef<BufferGeometry>(null);
  const pointsRef = useRef<Points>(null);
  const dpr = useThree((s) => s.viewport.dpr);
  const smoothed = useRef(intensity);

  const attributes = useMemo(
    () => buildParticleField(count, innerRadius, span),
    [count, innerRadius, span],
  );

  useFrame((_, delta) => {
    if (!matRef.current) return;
    matRef.current.uTime += delta;
    // ease intensity so state changes feel like the field spinning up, not a jump
    smoothed.current += (intensity - smoothed.current) * Math.min(1, delta * 2.5);
    matRef.current.uIntensity = smoothed.current;
    matRef.current.uPixelRatio = dpr;
  });

  if (compat) {
    return (
      <CoreParticlesGPU
        count={count}
        color={color}
        intensity={intensity}
        innerRadius={innerRadius}
        span={span}
      />
    );
  }

  return (
    <points ref={pointsRef}>
      <bufferGeometry ref={geoRef}>
        <bufferAttribute attach="attributes-position" args={[attributes.position, 3]} />
        <bufferAttribute attach="attributes-aRadius" args={[attributes.aRadius, 1]} />
        <bufferAttribute attach="attributes-aAngle" args={[attributes.aAngle, 1]} />
        <bufferAttribute attach="attributes-aSpeed" args={[attributes.aSpeed, 1]} />
        <bufferAttribute attach="attributes-aTilt" args={[attributes.aTilt, 1]} />
        <bufferAttribute attach="attributes-aY" args={[attributes.aY, 1]} />
        <bufferAttribute attach="attributes-aSize" args={[attributes.aSize, 1]} />
      </bufferGeometry>
      <holoParticleMaterial
        ref={matRef}
        uColor={color}
        uMode={mode === "flow" ? 1 : 0}
        uSpan={span}
        transparent
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </points>
  );
}
