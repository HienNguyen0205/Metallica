import type { VisualizationSpec } from "@/lib/store";

/**
 * Semantic animation presets. BE sends a coarse `animation` hint;
 * FE maps to a richer internal motion vocabulary.
 */
export type MotionPreset =
  | "materialize"
  | "pulse"
  | "breathe"
  | "orbit"
  | "scan"
  | "flow"
  | "draw"
  | "rise"
  | "glitch"
  | "flash"
  | "none";

const BASE_MAP: Record<string, MotionPreset> = {
  materialize: "materialize",
  pulse: "pulse",
  none: "none",
};

export function resolveAnimation(spec: VisualizationSpec): MotionPreset {
  const hint = spec.animation ?? "materialize";
  const base = BASE_MAP[hint] ?? "materialize";

  // Type-specific overrides
  switch (spec.type) {
    case "line_3d":
      return base === "materialize" ? "draw" : base;
    case "bar_3d":
      return base === "materialize" ? "rise" : base;
    case "network":
      return base === "materialize" ? "flow" : base;
    case "particle_flow":
      return "flow";
    case "radar":
      return "scan";
    case "waveform":
      return "pulse";
    case "health_core":
      return "pulse";
    default:
      break;
  }

  // Value-driven semantics: a critical gauge should not calmly breathe
  if (spec.type === "radial_gauge" && spec.data?.metrics?.length) {
    const max = Math.max(...spec.data.metrics.map((m) => m.value));
    if (max >= 90) return "flash";
    if (max >= 75) return "pulse";
    if (max <= 35) return "breathe";
  }

  return base;
}
