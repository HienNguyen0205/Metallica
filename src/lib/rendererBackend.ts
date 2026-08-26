import type { WebGLRenderer, WebGLRendererParameters } from "three";
import type { RenderBackend } from "@/lib/store";

type GLProps = Omit<WebGLRendererParameters, "canvas"> & {
  canvas?: HTMLCanvasElement | OffscreenCanvas;
};

/**
 * WebGPU is opt-in via NEXT_PUBLIC_WEBGPU=1. When enabled and the browser
 * exposes a GPU adapter, the scene boots on WebGPURenderer; any failure
 * (no adapter, device/pipeline error) falls back to WebGL2 automatically.
 */
export function webgpuRequested(): boolean {
  return process.env.NEXT_PUBLIC_WEBGPU === "1";
}

type NavigatorGPU = Navigator & { gpu?: { requestAdapter: () => Promise<unknown | null> } };

export async function detectWebGPU(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  const gpu = (navigator as NavigatorGPU).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export async function createRenderer(
  props: GLProps,
): Promise<{ renderer: WebGLRenderer; backend: RenderBackend }> {
  if (webgpuRequested() && (await detectWebGPU())) {
    try {
      const { WebGPURenderer } = await import("three/webgpu");
      const renderer = new WebGPURenderer(props as never);
      await renderer.init();
      return { renderer: renderer as unknown as WebGLRenderer, backend: "webgpu" };
    } catch (err) {
      // Adapter present but device/pipeline creation failed. Falling back is
      // correct, but doing it silently hides real WebGPU breakage — say so.
      console.warn("[friday] WebGPU init failed, falling back to WebGL2:", err);
    }
  }
  const { WebGLRenderer: GL } = await import("three");
  return { renderer: new GL(props), backend: "webgl2" };
}
