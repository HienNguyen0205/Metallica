"use client";

import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { RenderPipeline } from "three/webgpu";
import { Vector2, Vector3, type Mesh } from "three";
import {
  Fn,
  Loop,
  float,
  pass,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { chromaticAberration } from "three/addons/tsl/display/ChromaticAberrationNode.js";
import { film } from "three/addons/tsl/display/FilmNode.js";

/**
 * The post chain, rebuilt on three's node pipeline.
 *
 * `@react-three/postprocessing` could not come along: its `EffectComposer`
 * requires a classic `WebGLRenderer`, which no longer exists here. Every pass
 * below is either a stock TSL node or a short node function, so the chain
 * compiles to WGSL or GLSL from the same source as the rest of the scene.
 *
 * Taking `priority = 1` on `useFrame` turns off r3f's own render call — from
 * here on this component owns the frame.
 */

/**
 * Shaft march length. Baked into the compiled shader, so it is a chain
 * dependency rather than a uniform: this is the only full-resolution loop in
 * the chain, and at 5120x2880 the difference between 30 and 16 taps is what
 * pays for rendering the scene itself at native dpr. Bloom needs no equivalent
 * knob — three's node bloom already runs at half resolution unconditionally.
 */
const sunSamples = (dense: boolean) => (dense ? 16 : 30);


export default function PostFX({
  heavy,
  reduced,
  denseDisplay,
  sun,
}: {
  heavy: boolean;
  reduced: boolean;
  denseDisplay: boolean;
  sun: Mesh | null;
}) {
  const renderer = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  const { post, sunScreen } = useMemo(() => {
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode("output");
    const viewZ = scenePass.getViewZNode();

    const sunScreen = uniform(new Vector2(0.5, 0.5));

    // Bloom is additive on the node pipeline — it returns the glow, not the
    // composite. Half resolution on dense displays: at dpr 2 that still lands
    // at or above the pixel density a 1x display gets, and it is a blur anyway.
    const bloomed = color.add(bloom(color, 0.75, 0.65, 0.18));
    // Every stock pass declares its own concrete node class as its return type,
    // so a chain that reassigns one variable trips the checker at each hand-off
    // even though they all share Node's method chaining at runtime. One alias,
    // cast at each stock pass, keeps the chain readable.
    type FxNode = typeof bloomed;
    let output: FxNode = bloomed;

    if (heavy && sun) {
      const samples = sunSamples(denseDisplay);
      /* §13 volumetric shafts radiating out of the core.
       *
       * Deliberately *not* three's `godrays()` node: that one is raymarched
       * against shadow maps and accepts only point/directional lights, so it
       * would need a whole shadow setup and would not look like what it
       * replaced. This is the same radial-decay blur the old chain used — march
       * toward the core's screen position, accumulating bright pixels on the way. */
      const shafts = Fn(() => {
        const coord = screenUV.toVar();
        // 0.9 was the old `density`; dividing by the sample count keeps shaft
        // length constant however many steps we take
        const step = coord.sub(sunScreen).mul(0.9 / samples).toVar();
        const acc = vec3(0).toVar();
        const decay = float(1).toVar();

        Loop(samples, () => {
          coord.subAssign(step);
          const sample = color.sample(coord).rgb;
          // only genuinely bright pixels throw shafts, so the HUD text does not
          const lum = sample.dot(vec3(0.2126, 0.7152, 0.0722));
          acc.addAssign(sample.mul(smoothstep(0.35, 0.9, lum)).mul(decay));
          decay.mulAssign(0.92);
        });

        // clamped so a bright frame cannot wash the composition out
        return acc.mul(0.28 / samples).min(vec3(0.85));
      })();

      output = output.add(shafts);
    }

    if (heavy) {
      // Deep focal range on purpose: a shallow one blurred the spatial labels
      // into mush. Only the far field softens.
      output = dof(output, viewZ, 6.8, 0.42, 1.1) as unknown as FxNode;
    }

    // Radial, not uniform: a flat offset splits the tiny centre labels into
    // red/cyan ghosts. Fringing grows toward the edges only.
    output = chromaticAberration(output, float(0.0012), vec2(0.5, 0.5), float(1.1)) as unknown as FxNode;
    output = film(output, float(reduced ? 0.012 : 0.022)) as unknown as FxNode;

    // No stock vignette node ships with three; this is the whole effect.
    const r = screenUV.sub(vec2(0.5, 0.5)).length();
    output = output.mul(float(1).sub(smoothstep(0.22, 1.0, r).mul(0.92)));

    const post = new RenderPipeline(renderer as never);
    post.outputNode = output;

    return { post, sunScreen };
  }, [renderer, scene, camera, heavy, reduced, sun, denseDisplay]);

  useEffect(() => () => post.dispose(), [post]);

  const world = useMemo(() => new Vector3(), []);

  useFrame(() => {
    if (sun) {
      // the shafts have to know where the core landed on screen this frame
      sun.getWorldPosition(world).project(camera);
      sunScreen.value.set(world.x * 0.5 + 0.5, world.y * 0.5 + 0.5);
    }
    post.render();
  }, 1);

  return null;
}
