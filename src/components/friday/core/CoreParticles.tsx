"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { createParticleField } from "../effects/materials";

/**
 * §20 — one instanced draw call; all orbital motion is computed on the GPU from
 * per-particle attributes.
 *
 * There is no longer a `compat` branch or a separate WebGPU twin of this file:
 * the field is TSL, so the same node graph compiles for whichever backend the
 * renderer ended up on.
 */
export default function CoreParticles({
  count = 900,
  color,
  intensity = 1,
  mode = "orbit",
  innerRadius = 1.1,
  span = 2.6,
}: {
  count?: number;
  color: string;
  intensity?: number;
  mode?: "orbit" | "flow";
  innerRadius?: number;
  span?: number;
}) {
  const smoothed = useRef(intensity);

  // Colour and intensity are deliberately not dependencies — both change on
  // every state transition, and rebuilding the field would recompile a shader
  // and re-randomise every particle. They are pushed in as uniforms below.
  const { sprite, apply } = useMemo(
    () => createParticleField({ count, mode, innerRadius, span }),
    [count, mode, innerRadius, span],
  );

  useEffect(() => {
    return () => {
      // The material is ours; the geometry is NOT. `Sprite` holds a single
      // module-level `BufferGeometry` shared by every sprite ever constructed,
      // and `dispose()` does not reset the module slot — so freeing it here
      // destroys the quad for every other particle field on the page and three
      // never rebuilds it. That is what `Buffer used in submit while destroyed`
      // was: opening the particle-flow visualization mounts a second field, and
      // unmounting either one took the core's field down with it.
      sprite.material.dispose();
    };
  }, [sprite]);

  useFrame((_, delta) => {
    // ease intensity so state changes feel like the field spinning up, not a jump
    smoothed.current += (intensity - smoothed.current) * Math.min(1, delta * 2.5);
    apply(color, smoothed.current);
  });

  return <primitive object={sprite} />;
}
