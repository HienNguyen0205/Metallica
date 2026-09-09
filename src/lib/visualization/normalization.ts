import type { VisualizationSpec, VizData } from "@/lib/visualization/types";

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

/**
 * Wire labels must be non-empty strings: canvas labels call `.toUpperCase()`
 * and a number/null/object there throws inside the Canvas, unmounting the
 * whole scene. Finite numbers stringify; everything else is dropped.
 */
function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function sanitizeUnit(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizeData(data: VisualizationSpec["data"]): VizData {
  const out: VizData = data ? { ...data } : {};

  // Gauge semantics: 0..100, junk → 0. Non-arrays are dropped wholesale.
  // Labels are coerced too: a metric with no usable label cannot be drilled
  // into or captioned, so it is dropped rather than rendered as "undefined".
  out.metrics = Array.isArray(out.metrics)
    ? out.metrics.flatMap((m) => {
        const label = sanitizeLabel(m?.label);
        if (!label) return [];
        return [{
          ...m,
          label,
          unit: sanitizeUnit(m?.unit),
          value: typeof m?.value === "number" && Number.isFinite(m.value) ? Math.max(0, Math.min(100, m.value)) : 0,
        }];
      })
    : undefined;

  // A series with no renderable points would crash max()/min() downstream.
  out.series = Array.isArray(out.series)
    ? out.series.flatMap((s, i) => {
        if (!s || !Array.isArray(s.points) || s.points.length === 0) return [];
        return [{ ...s, label: sanitizeLabel(s.label) ?? `SERIES-${i}`, points: s.points.map((p) => (typeof p === "number" && Number.isFinite(p) ? p : 0)) }];
      })
    : undefined;

  // Clone node/point/event arrays so callers never share mutable wire data.
  // Ids and labels are coerced: nodes key React + raycast tags off them.
  // Length is preserved with fallback ids — `links` index into this array, so
  // dropping a node would shift every later index and rewire the graph.
  if (Array.isArray(out.nodes))
    out.nodes = out.nodes.map((n, i) => {
      const label = sanitizeLabel(n?.label);
      return { ...n, id: sanitizeLabel(n?.id) ?? `node-${i}`, ...(label === undefined ? { label: undefined } : { label }) };
    });
  else out.nodes = undefined;
  if (Array.isArray(out.points)) out.points = out.points.map((p) => ({ ...p, label: sanitizeLabel(p?.label) }));
  else out.points = undefined;
  if (Array.isArray(out.events))
    out.events = out.events.flatMap((e) => {
      const label = sanitizeLabel(e?.label);
      if (!label) return [];
      return [{ ...e, label }];
    });
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
