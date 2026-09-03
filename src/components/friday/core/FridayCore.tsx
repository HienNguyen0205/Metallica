"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { type Group, type Mesh } from "three";
import { useFridayStore } from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import { readMicLevels, utteranceEnvelope } from "@/lib/audioBus";
import { speakProgress } from "@/lib/voice";
import CoreParticles from "./CoreParticles";
import CoreRings from "./CoreRings";
import WaveformRing from "./WaveformRing";
import { TechLabel } from "../primitives";
import { createCoreMaterial, createHologramMaterial } from "../effects/materials";


/** How far the core withdraws behind an active visualization. */
const VIZ_SCALE = 0.4;

/**
 * §2 — the central hologram. Eight stacked layers so it reads as a complex
 * technological object rather than a glowing ball.
 */
export default function FridayCore({
  particleCount = 900,
  onCoreMesh,
}: {
  particleCount?: number;
  /** Publishes the core mesh so the god-ray pass can use it as its light source. */
  onCoreMesh?: (mesh: Mesh | null) => void;
}) {
  const state = useFridayStore((s) => s.state);
  const base = STATE_LOOK[state];
  /**
   * §16 — when data materializes the core stops being the subject. It kept
   * full size and full bloom directly behind every hologram, so charts were
   * drawn over a blown-out white sphere and could not be read at all.
   * It now withdraws to a marker: the data is what you are looking at.
   */
  const hasViz = useFridayStore((s) => s.visualizations.length > 0);
  const recede = useRef(1);
  // scale alone is not enough: bloom on the emissive core bleeds well past its
  // silhouette, so the glow has to come down with it.
  const look = hasViz
    ? { ...base, glow: base.glow * 0.5, particleIntensity: base.particleIntensity * 0.5 }
    : base;

  // Built once each. Everything the state look drives is a uniform, so a
  // transition re-tints these rather than recompiling two shaders mid-frame.
  const coreMat = useMemo(() => createCoreMaterial(), []);
  const shellMat = useMemo(() => createHologramMaterial({ fresnelPower: 1.6, wireframe: true }), []);

  useEffect(() => {
    return () => {
      coreMat.material.dispose();
      shellMat.material.dispose();
    };
  }, [coreMat, shellMat]);

  const groupRef = useRef<Group>(null);
  const coreRef = useRef<Mesh>(null);
  const shellRef = useRef<Mesh>(null);
  const innerShellRef = useRef<Mesh>(null);

  useFrame((_, delta) => {
    const t = performance.now() * 0.001;

    coreMat.apply(look.color, look.glow, look.coreDistort, look.coreSpeed);
    shellMat.apply(look.color, look.scanSpeed);

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

    if (groupRef.current) {
      // eased, so handing the stage over reads as a move, not a cut
      recede.current += ((hasViz ? VIZ_SCALE : 1) - recede.current) * Math.min(1, delta * 2.2);
      groupRef.current.scale.setScalar(recede.current);

      // §7 ERROR/WARNING — controlled positional glitch, never a seizure
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
        <primitive object={coreMat.material} attach="material" />
      </mesh>

      {/* layer 2 — inner lattice */}
      <mesh ref={innerShellRef}>
        <icosahedronGeometry args={[0.66, 1]} />
        <meshBasicMaterial color={look.accent} wireframe transparent opacity={0.3} toneMapped={false} />
      </mesh>

      {/* fresnel shell */}
      <mesh ref={shellRef}>
        <icosahedronGeometry args={[0.86, 2]} />
        <primitive object={shellMat.material} attach="material" />
      </mesh>

      {/* layer 3 + 5 — ring system and dials */}
      <CoreRings color={look.color} accent={look.accent} speed={look.ringSpeed} scanSpeed={look.scanSpeed} />

      {/* layer 4 — orbital particle field */}
      <CoreParticles count={particleCount} color={look.color} intensity={look.particleIntensity} />

      {/* layer 7 — audio-reactive outer ring.
          LISTENING reads the real mic via the shared bus (null → synth
          fallback inside the ring, so a denied mic degrades gracefully);
          SPEAKING breathes with utterance progress; anything else synths. */}
      <group rotation={[Math.PI / 2.15, 0, 0]}>
        <WaveformRing
          radius={2.08}
          color={look.accent}
          activity={look.waveform}
          getLevel={
            state === "listening"
              ? (bin) => readMicLevels(96)?.[bin] ?? null
              : state === "speaking"
                ? () => {
                    const p = speakProgress();
                    return p === null ? 0.4 : utteranceEnvelope(p);
                  }
                : undefined
          }
        />
      </group>

      {/* layer 6 — core identity readout. Hidden under a visualization: it
          landed inside the chart area and the HUD already names the state. */}
      {!hasViz && (
        <>
          <TechLabel position={[0, -1.18, 0]} color={look.color} size={0.085} decode>
            AI CORE
          </TechLabel>
          <TechLabel position={[0, -1.35, 0]} color="#e5f6ff" size={0.06} opacity={0.75}>
            {state.replace("_", " ")}
          </TechLabel>
        </>
      )}
    </group>
  );
}
