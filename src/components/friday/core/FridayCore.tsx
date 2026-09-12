"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera, type Group, type Mesh } from "three";
import { useFridayStore } from "@/lib/store";
import { dockPosition, shouldDockCore } from "@/lib/visualization/layoutResolver";
import { STATE_LOOK } from "@/lib/stateLook";
import { readMicLevels, utteranceEnvelope } from "@/lib/audioBus";
import { speakProgress, ttsLevels } from "@/lib/voice";
import CoreParticles from "./CoreParticles";
import CoreRings from "./CoreRings";
import WaveformRing from "./WaveformRing";
import { TechLabel } from "../primitives";
import { createCoreMaterial, createHologramMaterial } from "../effects/materials";


/** How far the core withdraws behind an active visualization. */
const VIZ_SCALE = 0.4;

/** Undocked home of the core group: dead center. */
const ORIGIN: [number, number, number] = [0, 0, 0];

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
  // Docked while the latest viz owns the center — recede alone leaves the
  // shrunken core glowing directly behind centered holograms (globe, network).
  const docked = useFridayStore((s) => shouldDockCore(s.visualizations));
  const recede = useRef(1);
  /**
   * Dock target in world units, recomputed from the live camera every frame:
   * visible half-extents at the origin plane from fov + distance + pixel
   * aspect (all measured, none assumed), then one receded assembly plus one
   * margin inside the bottom-left corner. A ref, not state — no re-renders.
   */
  const dockTarget = useRef<[number, number, number]>([0, 0, 0]);
  const dockPos = useRef<[number, number, number]>([0, 0, 0]);
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
  // Stable callback ref — a fresh inline ref identity per render fires
  // null+mesh on every FridayCore re-render and bounces Scene's setSun.
  const coreCallback = useCallback(
    (m: Mesh | null) => {
      coreRef.current = m;
      onCoreMesh?.(m);
    },
    [onCoreMesh],
  );
  /**
   * Per-frame mic cache. `WaveformRing` calls `getLevel` once per bar per
   * frame (96×), and a naive `(bin) => readMicLevels(96)` would run
   * `getByteFrequencyData + binsToLevels` 96× per frame. Cache by the ring's
   * own timestamp `t`, which is constant within a frame and changes next frame.
   */
  const micCache = useRef<{ t: number; levels: number[] | null } | null>(null);
  const getMicLevel = (bin: number, t: number): number | null => {
    if (!micCache.current || micCache.current.t !== t) {
      micCache.current = { t, levels: readMicLevels(96) };
    }
    return micCache.current.levels?.[bin] ?? null;
  };
  // Mirror of the mic cache for streamed TTS audio (null = inactive/fallback).
  const ttsCache = useRef<{ t: number; levels: number[] | null } | null>(null);
  const getTtsLevel = (bin: number, t: number): number | null => {
    if (!ttsCache.current || ttsCache.current.t !== t) {
      ttsCache.current = { t, levels: ttsLevels(96) };
    }
    return ttsCache.current.levels?.[bin] ?? null;
  };

  useFrame((state, delta) => {
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
      // Corner-anchored dock from measured camera geometry (see dockTarget).
      const { camera, size } = state;
      if (camera instanceof PerspectiveCamera && size.width > 0 && size.height > 0) {
        const dist = Math.max(0.001, camera.position.length());
        const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist;
        const halfW = halfH * (size.width / size.height);
        dockTarget.current = dockPosition(halfW, halfH, VIZ_SCALE);
      }
      // eased, so handing the stage over reads as a move, not a cut
      const k = Math.min(1, delta * 2.2);
      recede.current += ((hasViz ? VIZ_SCALE : 1) - recede.current) * k;
      groupRef.current.scale.setScalar(recede.current);

      const target = docked ? dockTarget.current : ORIGIN;
      dockPos.current[0] += (target[0] - dockPos.current[0]) * k;
      dockPos.current[1] += (target[1] - dockPos.current[1]) * k;
      dockPos.current[2] += (target[2] - dockPos.current[2]) * k;

      // §7 ERROR/WARNING — controlled positional glitch, never a seizure
      if (look.jitter > 0) {
        groupRef.current.position.set(
          dockPos.current[0] + (Math.random() - 0.5) * look.jitter,
          dockPos.current[1] + (Math.random() - 0.5) * look.jitter,
          0,
        );
      } else {
        groupRef.current.position.set(dockPos.current[0], dockPos.current[1], dockPos.current[2]);
      }
    }
  });

  return (
    <group ref={groupRef}>
      {/* layer 1 — energy core */}
      <mesh ref={coreCallback}>
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
              ? getMicLevel
              : state === "speaking"
                ? (bin: number, t: number) => {
                    // Real streamed audio first; envelope while synthesis
                    // fallback talks; synth motion when nothing is speaking
                    // (e.g. typed query holding on wait(3600)).
                    const real = getTtsLevel(bin, t);
                    if (real !== null) return real;
                    const p = speakProgress();
                    if (p === null) return null;
                    return utteranceEnvelope(p);
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
