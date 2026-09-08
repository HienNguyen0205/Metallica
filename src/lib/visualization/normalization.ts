import type { VisualizationSpec, VizData } from "@/lib/store";

/**
 * Backend-compatible normalization — fills defaults so renderers never
 * deal with undefined fields. Keeps wire spec minimal.
 *
 * The spec crosses a process boundary, so nothing here trusts shape: an array
 * field that is not an array is dropped rather than `.map`-crashed inside the
 * Canvas (which unmounts the whole scene), and colors are whitelisted to hex
 * because `THREE.Color.set` throws on anything else.
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function sanitizeColor(value: unknown): string | undefined {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : undefined;
}

function sanitizeTheme(theme: VisualizationSpec["theme"]): VisualizationSpec["theme"] {
  if (!theme) return {};
  const out: { color?: string; accent?: string } = {};
  const color = sanitizeColor(theme.color);
  const accent = sanitizeColor(theme.accent);
  if (color) out.color = color;
  if (accent) out.accent = accent;
  return out;
}

function sanitizeScale(scale: VisualizationSpec["scale"]): number {
  if (typeof scale !== "number" || !Number.isFinite(scale)) return 1;
  return Math.max(0.25, Math.min(4, scale));
}

function sanitizeData(data: VisualizationSpec["data"]): VizData {
  const out: VizData = data ? { ...data } : {};

  // Gauge semantics: 0..100, junk → 0. Non-arrays are dropped wholesale.
  out.metrics = Array.isArray(out.metrics)
    ? out.metrics.map((m) => ({
        ...m,
        value: Number.isFinite(m.value) ? Math.max(0, Math.min(100, m.value)) : 0,
      }))
    : undefined;

  // A series with no renderable points would crash max()/min() downstream.
  out.series = Array.isArray(out.series)
    ? out.series.flatMap((s) => {
        if (!s || !Array.isArray(s.points) || s.points.length === 0) return [];
        return [{ ...s, points: s.points.map((p) => (Number.isFinite(p) ? p : 0)) }];
      })
    : undefined;

  // Links index into `nodes`; an out-of-range pair used to draw a line to the
  // origin (silent wrong data) instead of failing.
  out.links =
    Array.isArray(out.links) && Array.isArray(out.nodes)
      ? out.links.filter(
          ([a, b]) =>
            Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < out.nodes!.length && b < out.nodes!.length,
        )
      : undefined;

  if (!Array.isArray(out.nodes)) out.nodes = undefined;
  if (!Array.isArray(out.points)) out.points = undefined;
  if (!Array.isArray(out.events)) out.events = undefined;
  if (typeof out.rate !== "number" || !Number.isFinite(out.rate)) out.rate = undefined;

  return out;
}

export function normalizeVisualization(spec: VisualizationSpec): VisualizationSpec {
  const out: VisualizationSpec = { ...spec, data: sanitizeData(spec.data) };
  if (!out.animation) out.animation = "materialize";
  if (!out.interaction) out.interaction = "drill_down";
  out.scale = sanitizeScale(out.scale);
  out.theme = sanitizeTheme(out.theme);
  return out;
}
