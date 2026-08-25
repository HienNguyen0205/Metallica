"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { AdaptiveDpr, AdaptiveEvents } from "@react-three/drei";
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  Noise,
  Vignette,
} from "@react-three/postprocessing";
import { Vector2 } from "three";
import { useFridayStore } from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import { createRenderer, detectWebGPU, webgpuRequested } from "@/lib/rendererBackend";
import FridayCore from "./core/FridayCore";
import SpatialHud from "./hud/SpatialHud";
import FridayVisualization from "./visualization/FridayVisualization";
import { RenderCompatProvider } from "./primitives";
import { reportCamera } from "@/lib/telemetry";

/** §12 — parallax + slow drift so the core sits in real space. */
function CameraRig({ reduced }: { reduced: boolean }) {
  const base = useRef(0);

  useFrame((state, delta) => {
    base.current += delta;
    const { camera, pointer } = state;
    const driftX = Math.sin(base.current * 0.12) * 0.18;
    const driftY = Math.cos(base.current * 0.09) * 0.1;
    const px = reduced ? 0 : pointer.x * 0.55;
    const py = reduced ? 0 : pointer.y * 0.3;

    camera.position.x += (px + driftX - camera.position.x) * 0.03;
    camera.position.y += (py + driftY + 0.15 - camera.position.y) * 0.03;
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

/**
 * Everything inside the canvas. On WebGPU the GLSL-only pieces
 * (post-processing chain, hologram shaders) swap for compatible materials.
 */
function SceneBody({ reduced }: { reduced: boolean }) {
  const gpu = useFridayStore((s) => s.renderBackend === "webgpu");

  return (
    <RenderCompatProvider value={gpu}>
      <color attach="background" args={["#02050a"]} />
      <fog attach="fog" args={["#02050a", 7, 16]} />

      <StateLights />
      <CameraRig reduced={reduced} />

      <SpatialHud reduced={reduced} />
      <FridayCore particleCount={reduced ? 260 : 950} compat={gpu} />
      <FridayVisualization />

      <AdaptiveDpr pixelated />
      <AdaptiveEvents />

      {!gpu && (
        <EffectComposer enableNormalPass={false}>
          <Bloom intensity={0.75} luminanceThreshold={0.18} luminanceSmoothing={0.85} mipmapBlur radius={0.65} />
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
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          // Ignore the intentional context loss from unmounting
          // (React StrictMode disposes the first mount in dev).
          if (!gl.domElement.isConnected) return;
          setTimeout(() => setCtxKey((k) => k + 1), 50);
        });
      }}
    >
      <SceneBody reduced={reduced} />
    </Canvas>
  );
}
