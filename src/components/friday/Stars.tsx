"use client";

import { useEffect, useMemo } from "react";
import { AdditiveBlending, BufferGeometry, Float32BufferAttribute } from "three";

/** Deterministic PRNG so the field is stable across re-renders (no thrash). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Static star backdrop for the space around the hologram — depth + "out there"
 * without any per-frame cost. `fog={false}` is required: the scene fog (near 7,
 * far 16) would otherwise hide a shell placed at radius ~40, and `sizeAttenuation
 * ={false}` keeps the points a fixed, readable pixel size at that distance.
 * Never animated, so it is reduced-motion safe by construction.
 */
export function Stars({ count = 900, radius = 42 }: { count?: number; radius?: number }) {
  const geometry = useMemo(() => {
    const rand = mulberry32(0xc0ffee);
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = radius * (0.85 + rand() * 0.15);
      arr[i * 3] = r * s * Math.cos(theta);
      arr[i * 3 + 1] = r * u;
      arr[i * 3 + 2] = r * s * Math.sin(theta);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(arr, 3));
    return g;
  }, [count, radius]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <points geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        size={2}
        sizeAttenuation={false}
        color="#cfeaff"
        transparent
        opacity={0.8}
        depthWrite={false}
        fog={false}
        blending={AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
}
