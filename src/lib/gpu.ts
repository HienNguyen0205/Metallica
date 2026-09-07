export type GpuClass = "unknown" | "software" | "hardware";
export type QualityPreference = "auto" | "high" | "low";

/** SwiftShader / llvmpipe rasterise on the CPU — skip the expensive passes. */
export function isSoftwareRenderer(gl: { getContext?: () => unknown }): boolean {
  try {
    const ctx = gl.getContext?.() as
      | { getExtension?: (name: string) => unknown; getParameter?: (p: unknown) => unknown }
      | undefined;
    const ext = ctx?.getExtension?.("WEBGL_debug_renderer_info") as
      | { UNMASKED_RENDERER_WEBGL?: unknown }
      | null
      | undefined;
    if (!ctx || !ext || !ctx.getParameter) return false;
    const name = String(ctx.getParameter((ext as { UNMASKED_RENDERER_WEBGL: unknown }).UNMASKED_RENDERER_WEBGL));
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
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
  if (quality === "high") return false;
  return systemReduced;
}
