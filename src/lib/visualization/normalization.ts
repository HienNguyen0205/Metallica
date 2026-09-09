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
        value: typeof m?.value === "number" && Number.isFinite(m.value) ? Math.max(0, Math.min(100, m.value)) : 0,
      }))
    : undefined;

  // A series with no renderable points would crash max()/min() downstream.
  out.series = Array.isArray(out.series)
    ? out.series.flatMap((s) => {
        if (!s || !Array.isArray(s.points) || s.points.length === 0) return [];
        return [{ ...s, points: s.points.map((p) => (typeof p === "number" && Number.isFinite(p) ? p : 0)) }];
      })
    : undefined;

  // Clone node/point/event arrays so callers never share mutable wire data.
  if (Array.isArray(out.nodes)) out.nodes = out.nodes.map((n) => ({ ...n }));
  else out.nodes = undefined;
  if (Array.isArray(out.points)) out.points = out.points.map((p) => ({ ...p }));
  else out.points = undefined;
  if (Array.isArray(out.events)) out.events = out.events.map((e) => ({ ...e }));
  else out.events = undefined;

  // Links index into `nodes`; an out-of-range pair used to draw a line to the
  // origin (silent wrong data) instead of failing.
  out.links =
    Array.isArray(out.links) && Array.isArray(out.nodes)
      ? out.links.filter(
          (pair) =>
            Array.isArray(pair) &&
            Number.isInteger(pair[0]) &&
            Number.isInteger(pair[1]) &&
            (pair[0] as number) >= 0 &&
            (pair[1] as number) >= 0 &&
            (pair[0] as number) < out.nodes!.length &&
            (pair[1] as number) < out.nodes!.length,
        )
      : undefined;

  if (typeof out.rate !== "number" || !Number.isFinite(out.rate) || out.rate < 0) out.rate = undefined;

  return out;
}

function sanitizePosition(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
  return [x, y, z];
}

function sanitizeTitle(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeVisualization(spec: VisualizationSpec): VisualizationSpec {
  const out: VisualizationSpec = { ...spec, data: sanitizeData(spec.data) };
  if (!out.animation) out.animation = "materialize";
  if (!out.interaction) out.interaction = "drill_down";
  out.scale = sanitizeScale(out.scale);
  out.theme = sanitizeTheme(out.theme);
  const pos = sanitizePosition((spec as { position?: unknown }).position);
  if (pos) out.position = pos;
  else delete out.position;
  const title = sanitizeTitle((spec as { title?: unknown }).title);
  if (title) out.title = title;
  else delete out.title;
  return out;
}
