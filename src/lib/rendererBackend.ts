import type { WebGLRenderer, WebGLRendererParameters } from "three";
import type { RenderBackend } from "@/lib/store";

type GLProps = Omit<WebGLRendererParameters, "canvas"> & {
  canvas?: HTMLCanvasElement | OffscreenCanvas;
};

/**
 * WebGPU-first. There is one renderer class now — `WebGPURenderer` — and it
 * carries its own WebGL2 backend for machines without a GPU adapter.
 *
 * This replaced a dual-renderer setup where the WebGPU branch swapped in
 * different materials and skipped post-processing entirely, so the fallback and
 * the "real" path shared almost no code. Everything downstream is TSL now, and
 * TSL compiles to WGSL or GLSL depending on the backend that ends up loaded, so
 * both paths render the same scene from the same source.
 */

/** Escape hatch: pin to WebGL2 without a code change when WebGPU misbehaves. */
export function forceWebGLRequested(): boolean {
  return process.env.NEXT_PUBLIC_FORCE_WEBGL === "1";
}

type NavigatorGPU = Navigator & { gpu?: { requestAdapter: () => Promise<unknown | null> } };

export async function detectWebGPU(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  const gpu = (navigator as NavigatorGPU).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

export async function createRenderer(
  props: GLProps,
): Promise<{ renderer: WebGLRenderer; backend: RenderBackend }> {
  const { WebGPURenderer } = await import("three/webgpu");

  // Decided here rather than left to the renderer's internal `getFallback`,
  // which resolves asynchronously mid-init and only announces itself through a
  // console warning — the store needs a definite answer to report.
  const useWebGPU = !forceWebGLRequested() && (await detectWebGPU());

  const renderer = new WebGPURenderer({ ...props, forceWebGL: !useWebGPU } as never);
  await renderer.init();

  // The adapter can exist and still fail at device creation, in which case the
  // renderer has quietly swapped to its WebGL backend. Read what actually
  // loaded instead of trusting the request.
  const ranOnGPU = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  if (useWebGPU && !ranOnGPU) {
    console.warn("[friday] WebGPU adapter present but device init failed; running on WebGL2.");
  }

  return {
    renderer: renderer as unknown as WebGLRenderer,
    backend: ranOnGPU ? "webgpu" : "webgl2",
  };
}
