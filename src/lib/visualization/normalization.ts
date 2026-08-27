import type { VisualizationSpec } from "@/lib/store";

/**
 * Backend-compatible normalization — fills defaults so renderers never
 * deal with undefined fields. Keeps wire spec minimal.
 */
export function normalizeVisualization(spec: VisualizationSpec): VisualizationSpec {
  const out: VisualizationSpec = { ...spec };
  if (!out.animation) out.animation = "materialize";
  if (!out.interaction) out.interaction = "drill_down";
  if (out.scale === undefined) out.scale = 1;
  if (!out.theme) out.theme = {};
  // Ensure data object exists for renderers that read metrics/series
  if (!out.data) out.data = {};

  // Clamp metric values to 0..100 for gauge semantics (not all specs are gauges)
  if (out.data.metrics) {
    out.data.metrics = out.data.metrics.map((m) => ({
      ...m,
      value: Math.max(0, Math.min(100, m.value)),
    }));
  }
  if (out.data.series) {
    out.data.series = out.data.series.map((s) => ({
      ...s,
      points: s.points.map((p) => (Number.isFinite(p) ? p : 0)),
    }));
  }
  return out;
}
