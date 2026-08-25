"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { AdditiveBlending, type BufferAttribute, type BufferGeometry, type Points } from "three";
import "../effects/materials";

/** Deterministic pseudo-random in [0,1) — stable across renders and SSR. */
function noise(i: number, seed: number) {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

interface ParticleUniforms {
  uTime: number;
  uColor: { set: (c: string) => void };
  uIntensity: number;
  uPixelRatio: number;
}

/**
 * §20 — one Points draw call, all orbital motion computed in the vertex
 * shader from per-particle attributes.
 * `compat` bakes the orbital layout into the position buffer on the CPU and
 * spins the whole cloud slowly, for renderers without custom GLSL support.
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

  const attributes = useMemo(() => {
    const position = new Float32Array(count * 3);
    const aRadius = new Float32Array(count);
    const aAngle = new Float32Array(count);
    const aSpeed = new Float32Array(count);
    const aTilt = new Float32Array(count);
    const aY = new Float32Array(count);
    const aSize = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      aRadius[i] = innerRadius + noise(i, 1) * span;
      aAngle[i] = noise(i, 2) * Math.PI * 2;
      aSpeed[i] = 0.06 + noise(i, 3) * 0.22;
      aTilt[i] = (noise(i, 4) - 0.5) * 1.5;
      aY[i] = (noise(i, 5) - 0.5) * 1.1;
      aSize[i] = 0.6 + noise(i, 6) * 1.8;
    }
    return { position, aRadius, aAngle, aSpeed, aTilt, aY, aSize };
  }, [count, innerRadius, span]);

  useLayoutEffect(() => {
    if (!compat || !geoRef.current) return;
    const pos = geoRef.current.getAttribute("position") as BufferAttribute;
    const { aRadius, aAngle, aY } = attributes;
    for (let i = 0; i < count; i++) {
      pos.setXYZ(i, Math.cos(aAngle[i]) * aRadius[i], aY[i], Math.sin(aAngle[i]) * aRadius[i]);
    }
    pos.needsUpdate = true;
  }, [compat, attributes, count]);

  useFrame((_, delta) => {
    if (!matRef.current && !compat) return;
    if (compat) {
      if (pointsRef.current) pointsRef.current.rotation.y += delta * 0.12;
      return;
    }
    matRef.current!.uTime += delta;
    // ease intensity so state changes feel like the field spinning up, not a jump
    smoothed.current += (intensity - smoothed.current) * Math.min(1, delta * 2.5);
    matRef.current!.uIntensity = smoothed.current;
    matRef.current!.uPixelRatio = dpr;
  });

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
      {compat ? (
        <pointsMaterial
          color={color}
          size={0.035}
          sizeAttenuation
          transparent
          opacity={0.8}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      ) : (
        <holoParticleMaterial
          ref={matRef}
          uColor={color}
          uMode={mode === "flow" ? 1 : 0}
          uSpan={span}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      )}
    </points>
  );
}
