"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { MeshDistortMaterial } from "@react-three/drei";
import { type Group, type Mesh } from "three";
import { useFridayStore } from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import CoreParticles from "./CoreParticles";
import CoreRings from "./CoreRings";
import WaveformRing from "./WaveformRing";
import { TechLabel } from "../primitives";
import "../effects/materials";

interface HoloUniforms {
  uTime: number;
}

/**
 * §2 — the central hologram. Eight stacked layers so it reads as a complex
 * technological object rather than a glowing ball.
 * `compat` swaps GLSL-only materials for WebGPU-safe equivalents.
 */
export default function FridayCore({
  particleCount = 900,
  compat = false,
  onCoreMesh,
}: {
  particleCount?: number;
  compat?: boolean;
  /** Publishes the core mesh so the god-ray pass can use it as its light source. */
  onCoreMesh?: (mesh: Mesh | null) => void;
}) {
  const state = useFridayStore((s) => s.state);
  const look = STATE_LOOK[state];

  const groupRef = useRef<Group>(null);
  const coreRef = useRef<Mesh>(null);
  const shellRef = useRef<Mesh>(null);
  const shellMatRef = useRef<HoloUniforms>(null);
  const innerShellRef = useRef<Mesh>(null);

  useFrame((_, delta) => {
    const t = performance.now() * 0.001;

    if (coreRef.current) {
      coreRef.current.scale.setScalar(1 + Math.sin(t * look.coreSpeed) * 0.05);
      coreRef.current.rotation.y += delta * 0.12;
    }
    if (shellRef.current) {
      shellRef.current.rotation.y -= delta * (0.06 + look.ringSpeed * 0.25);
      shellRef.current.rotation.x += delta * 0.04;
    }
    if (innerShellRef.current) {
      innerShellRef.current.rotation.y += delta * (0.1 + look.ringSpeed * 0.4);
      innerShellRef.current.rotation.z -= delta * 0.05;
    }
    if (shellMatRef.current && !compat) shellMatRef.current.uTime += delta;

    // §7 ERROR/WARNING — controlled positional glitch, never a seizure
    if (groupRef.current) {
      if (look.jitter > 0) {
        groupRef.current.position.set(
          (Math.random() - 0.5) * look.jitter,
          (Math.random() - 0.5) * look.jitter,
          0,
        );
      } else {
        groupRef.current.position.set(0, 0, 0);
      }
    }
  });

  return (
    <group ref={groupRef}>
      {/* layer 1 — energy core */}
      <mesh
        ref={(m: Mesh | null) => {
          coreRef.current = m;
          onCoreMesh?.(m);
        }}
      >
        <sphereGeometry args={[0.5, 48, 48]} />
        {compat ? (
          <meshStandardMaterial
            color={look.color}
            emissive={look.color}
            emissiveIntensity={look.glow}
            roughness={0.25}
            metalness={0.3}
          />
        ) : (
          <MeshDistortMaterial
            color={look.color}
            emissive={look.color}
            emissiveIntensity={look.glow}
            distort={look.coreDistort}
            speed={look.coreSpeed}
            roughness={0.2}
            metalness={0.4}
          />
        )}
      </mesh>

      {/* layer 2 — inner lattice */}
      <mesh ref={innerShellRef}>
        <icosahedronGeometry args={[0.66, 1]} />
        <meshBasicMaterial color={look.accent} wireframe transparent opacity={0.3} toneMapped={false} />
      </mesh>

      {/* fresnel shell */}
      <mesh ref={shellRef}>
        <icosahedronGeometry args={[0.86, 2]} />
        {compat ? (
          <meshBasicMaterial color={look.color} wireframe transparent opacity={0.22} toneMapped={false} depthWrite={false} />
        ) : (
          <hologramMaterial ref={shellMatRef} uColor={look.color} uFresnelPower={1.6} transparent depthWrite={false} wireframe />
        )}
      </mesh>

      {/* layer 3 + 5 — ring system and dials */}
      <CoreRings color={look.color} accent={look.accent} speed={look.ringSpeed} scanSpeed={look.scanSpeed} compat={compat} />

      {/* layer 4 — orbital particle field */}
      <CoreParticles count={particleCount} color={look.color} intensity={look.particleIntensity} compat={compat} />

      {/* layer 7 — audio-reactive outer ring */}
      <group rotation={[Math.PI / 2.15, 0, 0]}>
        <WaveformRing radius={2.08} color={look.accent} activity={look.waveform} />
      </group>

      {/* layer 6 — core identity readout */}
      <TechLabel position={[0, -1.18, 0]} color={look.color} size={0.085} decode>
        AI CORE
      </TechLabel>
      <TechLabel position={[0, -1.35, 0]} color="#e5f6ff" size={0.06} opacity={0.75}>
        {state.replace("_", " ")}
      </TechLabel>
    </group>
  );
}
