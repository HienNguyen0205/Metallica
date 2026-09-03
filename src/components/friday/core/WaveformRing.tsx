"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, Object3D, type InstancedMesh } from "three";

/**
 * §7 — the ring that reacts to audio during LISTENING / SPEAKING.
 * `getLevel` may return null (e.g. mic not attached) — that bin falls back
 * to the synthesised motion, so a denied mic degrades instead of freezing.
 */
export default function WaveformRing({
  radius = 2.05,
  bars = 96,
  color,
  activity = 1,
  getLevel,
}: {
  radius?: number;
  bars?: number;
  color: string;
  activity?: number;
  getLevel?: (bin: number, time: number) => number | null | undefined;
}) {
  const ref = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const heights = useRef(new Float32Array(bars));
  const time = useRef(0);

  useFrame((_, delta) => {
    if (!ref.current) return;
    time.current += delta;
    const t = time.current;

    for (let i = 0; i < bars; i++) {
      // layered sines read as speech-like without a real analyser
      const synth =
        (Math.sin(i * 0.7 + t * 6) * 0.5 + 0.5) * (Math.sin(i * 0.19 + t * 2.3) * 0.5 + 0.5);
      const raw = getLevel?.(i, t) ?? synth;
      const target = 0.06 + raw * 0.5 * activity;
      heights.current[i] += (target - heights.current[i]) * Math.min(1, delta * 12);

      const angle = (i / bars) * Math.PI * 2;
      const h = heights.current[i];
      dummy.position.set(Math.cos(angle) * (radius + h / 2), Math.sin(angle) * (radius + h / 2), 0);
      dummy.rotation.set(0, 0, angle + Math.PI / 2);
      dummy.scale.set(0.014, h, 1);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, bars]}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.3 + activity * 0.55}
        side={DoubleSide}
        toneMapped={false}
        depthWrite={false}
      />
    </instancedMesh>
  );
}
