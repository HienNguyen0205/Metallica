export type GpuClass = "unknown" | "software" | "hardware";
export type QualityPreference = "auto" | "high" | "low";

/**
 * The one software-GL classifier — UI tests (helpers.ts) must read this same
 * regex, not their own: two lists drifted before and a runner classified as
 * hardware failed a >24fps assertion it should never have run.
 */
const SOFTWARE_GL_RE = /swiftshader|llvmpipe|software|basic render|angle \(google, vulkan/i;

export function isSoftwareRendererName(name: string): boolean {
  return SOFTWARE_GL_RE.test(name);
}

/**
 * Whether the WebGPU adapter behind WebGPURenderer is a software fallback
 * (SwiftShader). Recorded at async detect time (see rendererBackend.ts) —
 * `onCreated` is sync, so the flag is cached, never awaited there.
 */
let fallbackAdapterCached = false;

export function setFallbackAdapterCached(fallback: boolean): void {
  fallbackAdapterCached = fallback;
}

export function isFallbackAdapterCached(): boolean {
  return fallbackAdapterCached;
}

/** SwiftShader / llvmpipe rasterise on the CPU — skip the expensive passes. */
export function isSoftwareRenderer(gl: {
  getContext?: () => unknown;
  backend?: { isWebGPUBackend?: boolean };
}): boolean {
  // On the WebGPU backend `getContext()` returns a GPUCanvasContext (no
  // WEBGL_debug_renderer_info), so the GL probe below always answers false and
  // SwiftShader-WebGPU used to classify as hardware. Trust the cached adapter
  // flag instead — the probe is meaningless there.
  try {
    const backend = (gl as { backend?: { isWebGPUBackend?: boolean } })?.backend;
    if (backend?.isWebGPUBackend) return isFallbackAdapterCached();
  } catch {
    return false;
  }
  try {
    const ctx = gl.getContext?.() as
      | { getExtension?: (name: string) => unknown; getParameter?: (p: unknown) => unknown }
      | undefined;
    const ext = ctx?.getExtension?.("WEBGL_debug_renderer_info") as
      | { UNMASKED_RENDERER_WEBGL?: unknown }
      | null
      | undefined;
    if (!ctx || !ext || !ctx.getParameter) return false;
    return isSoftwareRendererName(
      String(ctx.getParameter((ext as { UNMASKED_RENDERER_WEBGL: unknown }).UNMASKED_RENDERER_WEBGL)),
    );
  } catch {
    return false;
  }
}

/**
 * Pure heavy-pass truth table (unit-testable).
 * - low → never heavy
 * - high → heavy only on confirmed hardware (unknown stays safe)
 * - auto → heavy only when not reduced and confirmed hardware
 */
export function resolveHeavy({
  quality,
  gpuClass,
  reduced,
}: {
  quality: QualityPreference;
  gpuClass: GpuClass;
  reduced: boolean;
}): boolean {
  if (quality === "low") return false;
  if (quality === "high") return gpuClass === "hardware";
  return !reduced && gpuClass === "hardware";
}

export function resolveReduced({
  quality,
  systemReduced,
}: {
  quality: QualityPreference;
  systemReduced: boolean;
}): boolean {
  if (quality === "low") return true;
  // `high` must not override the OS reduced-motion signal — it only forces
  // DPR / heavy passes (see resolveHeavy), never motion itself.
  if (quality === "high") return systemReduced;
  return systemReduced;
}
