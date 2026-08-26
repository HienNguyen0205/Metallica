"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { AdaptiveDpr, AdaptiveEvents } from "@react-three/drei";
import {
  Bloom,
  DepthOfField,
  GodRays,
  ChromaticAberration,
  EffectComposer,
  Noise,
  Vignette,
} from "@react-three/postprocessing";
import { Vector2, Vector3, type Mesh } from "three";
import { useFridayStore } from "@/lib/store";
import { STATE_CAMERA, STATE_LOOK } from "@/lib/stateLook";
import { createRenderer, detectWebGPU, webgpuRequested } from "@/lib/rendererBackend";
import FridayCore from "./core/FridayCore";
import SpatialHud from "./hud/SpatialHud";
import FridayVisualization from "./visualization/FridayVisualization";
import { RenderCompatProvider } from "./primitives";
import { reportCamera } from "@/lib/telemetry";

/**
 * §12 — parallax and slow drift so the core sits in real space, plus the
 * §8 state response: the rig leans in while FRIDAY works and pulls back
 * when a hologram materializes.
 */
function CameraRig({ reduced }: { reduced: boolean }) {
  const base = useRef(0);
  const fridayState = useFridayStore((s) => s.state);
  const target = STATE_CAMERA[fridayState];

  useFrame((state, delta) => {
    base.current += delta;
    const { camera, pointer } = state;
    const driftX = Math.sin(base.current * 0.12) * 0.18;
    const driftY = Math.cos(base.current * 0.09) * 0.1;
    const swing = Math.sin(base.current * 0.28) * target.orbit;
    const px = reduced ? 0 : pointer.x * 0.55;
    const py = reduced ? 0 : pointer.y * 0.3;

    // slow easing — the dolly should read as intent, not as a cut
    camera.position.x += (px + driftX + swing - camera.position.x) * 0.03;
    camera.position.y += (py + driftY + 0.15 - camera.position.y) * 0.03;
    camera.position.z += (target.distance - camera.position.z) * 0.02;
    camera.lookAt(0, 0, 0);

    // feeds the HUD coordinate readout — a plain write, no re-render
    reportCamera(camera.position.x, camera.position.y, camera.position.z);
  });

  return null;
}

/** Lights that follow the state colour so the core never looks repainted. */
function StateLights() {
  const state = useFridayStore((s) => s.state);
  const look = STATE_LOOK[state];
  return (
    <>
      <ambientLight intensity={0.28} />
      <pointLight position={[4, 3, 5]} intensity={1.1} color={look.color} />
      <pointLight position={[-4, -2, -3]} intensity={0.45} color={look.accent} />
    </>
  );
}

const CHROMA = new Vector2(0.0012, 0.0012);
/** The core sits at the origin; focus never leaves it. */
const FOCUS_TARGET = new Vector3(0, 0, 0);

/** SwiftShader / llvmpipe rasterise on the CPU — skip the expensive passes. */
function isSoftwareRenderer(gl: { getContext?: () => WebGLRenderingContext }): boolean {
  try {
    const ctx = gl.getContext?.();
    const ext = ctx?.getExtension("WEBGL_debug_renderer_info");
    if (!ctx || !ext) return false;
    const name = String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

/**
 * Everything inside the canvas. On WebGPU the GLSL-only pieces
 * (post-processing chain, hologram shaders) swap for compatible materials.
 */
function SceneBody({ reduced, heavy }: { reduced: boolean; heavy: boolean }) {
  const gpu = useFridayStore((s) => s.renderBackend === "webgpu");
  // the core mesh doubles as the god-ray light source
  const [sun, setSun] = useState<Mesh | null>(null);

  return (
    <RenderCompatProvider value={gpu}>
      <color attach="background" args={["#02050a"]} />
      <fog attach="fog" args={["#02050a", 7, 16]} />

      <StateLights />
      <CameraRig reduced={reduced} />

      <SpatialHud reduced={reduced} />
      <FridayCore particleCount={reduced ? 260 : 950} compat={gpu} onCoreMesh={setSun} />
      <FridayVisualization />

      <AdaptiveDpr pixelated />
      <AdaptiveEvents />

      {!gpu && (
        <EffectComposer enableNormalPass={false}>
          <Bloom intensity={0.75} luminanceThreshold={0.18} luminanceSmoothing={0.85} mipmapBlur radius={0.65} />
          {/* §12 — focus locked on the core, so the outer field softens with
              distance and the composition reads as photographed depth. */}
          {/* §13 volumetric shafts radiating out of the core. Weight and
              exposure stay low — this should read as light in the air, not
              as a lens flare washing the HUD out. */}
          {heavy && sun ? (
            <GodRays
              sun={sun}
              samples={30}
              density={0.9}
              decay={0.92}
              weight={0.28}
              exposure={0.2}
              clampMax={0.85}
              blur
            />
          ) : (
            <></>
          )}
          {heavy ? (
            /* Deep focal range on purpose: a shallow one (0.06) blurred the
               spatial labels into mush. Only the far field softens. */
            <DepthOfField target={FOCUS_TARGET} focalLength={0.42} bokehScale={1.1} height={720} />
          ) : (
            <></>
          )}
          {/* Radial, not uniform: a flat offset splits the tiny centre labels
              into red/cyan ghosts. Clean out to 40% radius, lens fringing
              only toward the edges. */}
          <ChromaticAberration offset={CHROMA} radialModulation modulationOffset={0.4} />
          <Noise opacity={reduced ? 0.012 : 0.022} />
          <Vignette eskil={false} offset={0.22} darkness={0.92} />
        </EffectComposer>
      )}
    </RenderCompatProvider>
  );
}

export default function Scene() {
  // §19 — mobile gets a simplified scene, not a shrunken desktop one
  const [reduced, setReduced] = useState(false);
  const [ctxKey, setCtxKey] = useState(0);
  const [preferGPU, setPreferGPU] = useState(false);
  // Tri-state on purpose. Defaulting to "capable" would mount the depth-of-field
  // pass for the first frames and tear it down once detection ran, and adding
  // then removing a pass mid-composer leaves the GL state inconsistent.
  const [gpuClass, setGpuClass] = useState<"unknown" | "software" | "hardware">("unknown");
  const setRenderBackend = useFridayStore((s) => s.setRenderBackend);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px), (prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!webgpuRequested()) return;
    let cancelled = false;
    void detectWebGPU().then((ok) => {
      if (!cancelled && ok) setPreferGPU(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Canvas
      key={`${ctxKey}-${preferGPU}`}
      dpr={reduced ? [1, 1.25] : [1, 1.75]}
      camera={{ position: [0, 0.15, 6.8], fov: 45 }}
      className="!absolute inset-0"
      gl={(props) => createRenderer(props as never).then(({ renderer }) => renderer)}
      onCreated={({ gl }) => {
        setRenderBackend(
          (gl as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer ? "webgpu" : "webgl2",
        );
        setGpuClass(isSoftwareRenderer(gl) ? "software" : "hardware");
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          // Ignore the intentional context loss from unmounting
          // (React StrictMode disposes the first mount in dev).
          if (!gl.domElement.isConnected) return;
          setTimeout(() => setCtxKey((k) => k + 1), 50);
        });
      }}
    >
      <SceneBody reduced={reduced} heavy={!reduced && gpuClass === "hardware"} />
    </Canvas>
  );
}
