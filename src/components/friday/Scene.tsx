"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdaptiveDpr, AdaptiveEvents } from "@react-three/drei";
import { type Mesh } from "three";
import { useFridayStore } from "@/lib/store";
import { STATE_CAMERA, STATE_LOOK } from "@/lib/stateLook";
import { createRenderer } from "@/lib/rendererBackend";
import { isSoftwareRenderer, resolveHeavy, resolveReduced } from "@/lib/gpu";
import FridayCore from "./core/FridayCore";
import SpatialHud from "./hud/SpatialHud";
import FridayVisualization from "./visualization/FridayVisualization";
import PostFX from "./effects/PostFX";
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
  const yaw = useRef(0);
  const pitch = useRef(0);
  const dragging = useRef(false);
  const last = useRef<[number, number]>([0, 0]);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    if (reduced) return;
    const el = gl.domElement;
    const downPos = { x: 0, y: 0 };
    const DRAG_THRESHOLD = 4;
    const down = (e: PointerEvent) => {
      dragging.current = false;
      downPos.x = e.clientX;
      downPos.y = e.clientY;
      last.current = [e.clientX, e.clientY];
      (el as HTMLElement & { dataset: DOMStringMap }).dataset.dragArmed = "1";
    };
    const move = (e: PointerEvent) => {
      // Arm on pointerdown, engage only past the threshold so a plain click
      // never becomes a 1-frame orbit jump (and pairs with DrillDown's own gate).
      if ((el as HTMLElement & { dataset: DOMStringMap }).dataset.dragArmed !== "1") return;
      const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      if (!dragging.current && dist < DRAG_THRESHOLD) return;
      dragging.current = true;
      const dx = e.clientX - last.current[0];
      const dy = e.clientY - last.current[1];
      last.current = [e.clientX, e.clientY];
      yaw.current = Math.max(-0.6, Math.min(0.6, yaw.current + dx * 0.003));
      pitch.current = Math.max(-0.25, Math.min(0.25, pitch.current - dy * 0.002));
    };
    const up = () => {
      dragging.current = false;
      delete (el as HTMLElement & { dataset: DOMStringMap }).dataset.dragArmed;
    };
    const reset = () => {
      yaw.current = 0;
      pitch.current = 0;
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    el.addEventListener("dblclick", reset);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.removeEventListener("dblclick", reset);
    };
  }, [gl, reduced]);

  useFrame((state, delta) => {
    base.current += delta;
    const { camera, pointer } = state;
    // Reduced motion: freeze drift/swing/parallax, keep only the eased dolly.
    const driftX = reduced ? 0 : Math.sin(base.current * 0.12) * 0.18;
    const driftY = reduced ? 0 : Math.cos(base.current * 0.09) * 0.1;
    const swing = reduced ? 0 : Math.sin(base.current * 0.28) * target.orbit;
    const px = reduced ? 0 : pointer.x * 0.55;
    const py = reduced ? 0 : pointer.y * 0.3;

    // slow easing — the dolly should read as intent, not as a cut
    // user drag adds a clamped orbit offset on top of drift + parallax
    camera.position.x += (px + driftX + swing + yaw.current - camera.position.x) * 0.03;
    camera.position.y += (py + driftY + 0.15 + pitch.current - camera.position.y) * 0.03;
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

/**
 * Everything inside the canvas.
 *
 * There is no backend branch here any more. The renderer is always
 * `WebGPURenderer` — on its WebGPU backend where an adapter exists, on its
 * WebGL2 backend otherwise — and every material below is TSL, so both backends
 * draw the same scene. The old `compat` prop threading and the WebGPU-only
 * bypass of the whole post chain are gone with it.
 */
function SceneBody({
  reduced,
  heavy,
  denseDisplay,
}: {
  reduced: boolean;
  heavy: boolean;
  denseDisplay: boolean;
}) {
  // the core mesh doubles as the god-ray light source
  const [sun, setSun] = useState<Mesh | null>(null);

  return (
    <>
      <color attach="background" args={["#02050a"]} />
      <fog attach="fog" args={["#02050a", 7, 16]} />

      <StateLights />
      <CameraRig reduced={reduced} />

      <SpatialHud reduced={reduced} />
      <FridayCore particleCount={reduced ? 260 : 950} onCoreMesh={setSun} />
      <FridayVisualization />

      {/* No `pixelated`: it stamps image-rendering:pixelated on the canvas while
          regressing, which turns a resolution drop into visible blocks. Letting
          the browser smooth the upscale degrades far less harshly. */}
      <AdaptiveDpr />
      <AdaptiveEvents />

      <PostFX heavy={heavy} reduced={reduced} denseDisplay={denseDisplay} sun={sun} />
    </>
  );
}

export default function Scene() {
  // §19 — mobile gets a simplified scene, not a shrunken desktop one
  const [reduced, setReduced] = useState(false);
  const [ctxKey, setCtxKey] = useState(0);
  // Tri-state on purpose. Defaulting to "capable" would mount the depth-of-field
  // pass for the first frames and tear it down once detection ran, and adding
  // then removing a pass mid-composer leaves the GL state inconsistent.
  const [gpuClass, setGpuClass] = useState<"unknown" | "software" | "hardware">("unknown");
  // Retina and 4K panels. On these the blur passes can run at half resolution
  // and still be at or above the pixel density a 1x display gets, which is what
  // pays for rendering the scene itself at native dpr.
  const [denseDisplay, setDenseDisplay] = useState(false);
  const setRenderBackend = useFridayStore((s) => s.setRenderBackend);
  const quality = useFridayStore((s) => s.quality);

  useEffect(() => {
    // Subscribed, not read once: devicePixelRatio changes when the window is
    // dragged to another monitor or the page is zoomed.
    const mq = window.matchMedia("(min-resolution: 2dppx)");
    const apply = () => setDenseDisplay(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px), (prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);


  const effectiveReduced = resolveReduced({ quality, systemReduced: reduced });
  const heavy = resolveHeavy({ quality, gpuClass, reduced: effectiveReduced });

  return (
    <Canvas
      key={ctxKey}
      /* Was capped at 1.75, so a devicePixelRatio-2 display rendered at 87.5%
         of native and was upscaled — measurably soft, and the most common
         "looks blurry on a big screen" cause. AdaptiveDpr still walks this
         down when the GPU cannot keep up. Dense (Retina/4K) panels cap at 1.5:
         a 5120×2880 backing at dpr 2 is ~118M px (~470MB + post targets) and
         the 30-tap god-ray pass scales with framebuffer area — 1.5 is still
         above 1x density for the blur passes while keeping fill-rate alive. */
      dpr={effectiveReduced || denseDisplay ? [1, 1.5] : [1, 2]}
      camera={{ position: [0, 0.15, 6.8], fov: 45 }}
      className="!absolute inset-0"
      gl={(props) => createRenderer(props as never).then(({ renderer }) => renderer)}
      onCreated={({ gl }) => {
        // `isWebGPURenderer` is true even when WebGPURenderer fell back to its
        // WebGL2 backend, so it reports the class, not what is actually
        // drawing. The HUD said WEBGPU on a machine running WebGL2 because of
        // exactly that. Read the loaded backend instead.
        const backend: "webgpu" | "webgl2" = (
          gl as unknown as { backend?: { isWebGPUBackend?: boolean } }
        ).backend?.isWebGPUBackend
          ? "webgpu"
          : "webgl2";
        setRenderBackend(backend);
        // Test hooks for tests/ui/helpers.ts glRenderer()/glHealth(): the canvas
        // is owned by WebGPURenderer, so a second getContext("webgl2") in-page
        // returns null on the WebGPU backend — read the reported values instead.
        const software = isSoftwareRenderer(gl);
        if (typeof window !== "undefined") {
          const w = window as unknown as { __fridayBackend?: string; __fridaySoftware?: boolean };
          w.__fridayBackend = backend;
          w.__fridaySoftware = software;
        }
        setGpuClass(software ? "software" : "hardware");
        let remountQueued = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onLost = (e: Event) => {
          e.preventDefault();
          // Ignore the intentional context loss from unmounting
          // (React StrictMode disposes the first mount in dev).
          if (!gl.domElement.isConnected || remountQueued) return;
          remountQueued = true;
          timer = setTimeout(() => setCtxKey((k) => k + 1), 50);
        };
        gl.domElement.addEventListener("webglcontextlost", onLost);
        // Cleanup on unmount: no orphan listeners or queued remounts.
        return () => {
          gl.domElement.removeEventListener("webglcontextlost", onLost);
          if (timer) clearTimeout(timer);
        };
      }}
    >
      <SceneBody
        reduced={effectiveReduced}
        heavy={heavy}
        denseDisplay={denseDisplay}
      />
    </Canvas>
  );
}
