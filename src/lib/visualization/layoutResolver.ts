import type { VisualizationEntry, VisualizationSpec } from "@/lib/visualization/types";

export interface LayoutPlacement {
  position: [number, number, number];
  scale: number;
}

export interface LayoutContext {
  count: number;
  index: number;
}

/**
 * Deterministic spatial layout resolver.
 * No CSS grid — positions are in world units around the central core.
 */
export function resolveVisualizationLayout(
  spec: VisualizationSpec,
  ctx: LayoutContext,
): LayoutPlacement {
  // Respect explicit position/scale independently — a spec that only pins
  // `position` must not lose it just because `scale` is unset (and vice versa).
  // Only fall through to auto-layout for the fields the spec leaves unset.
  const { count, index } = ctx;

  // Defensive: no entries (or negative) centers instead of producing NaN
  // from index/count division.
  if (!Number.isFinite(count) || count <= 0) {
    return {
      position: spec.position ?? ([0, 0, 0] as [number, number, number]),
      scale: spec.scale ?? 1,
    };
  }

  // Single viz: centered
  if (count === 1) {
    const scaleMap: Record<string, number> = {
      network: 0.95,
      globe: 1.0,
      particle_flow: 1.0,
      radial_gauge: 1.0,
      health_core: 1.0,
      funnel_3d: 1.0,
      sankey_flow: 0.95,
    };
    return {
      position: spec.position ?? ([0, 0, 0] as [number, number, number]),
      scale: spec.scale ?? scaleMap[spec.type] ?? 1,
    };
  }

  // Multi-viz: fan around core
  const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
  const radius = count <= 3 ? 2.6 : 3.2;
  // y offset so viz floats slightly above equatorial plane
  const auto: LayoutPlacement = {
    position: [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.35, 0],
    scale: count > 4 ? 0.62 : count > 2 ? 0.78 : 0.9,
  };
  return {
    position: spec.position ?? auto.position,
    scale: spec.scale ?? auto.scale,
  };
}

/**
 * World half-extent of the core assembly (outer arcs) at scale 1.
 */
export const CORE_EXTENT = 2.75;

/**
 * Dock target for a receded core, anchored to the screen's bottom-left
 * corner — not a fixed offset: halfW/halfH are the viewport half-extents
 * (useThree viewport.width/2, viewport.height/2), `scale` is the core's
 * receded scale (extent = CORE_EXTENT * scale), and the dock sits one
 * assembly plus one margin inside both edges. Too small a frame centers
 * instead of clipping.
 */
export function dockPosition(
  halfW: number,
  halfH: number,
  scale: number,
  margin = 0.35,
): [number, number, number] {
  if (!Number.isFinite(halfW) || !Number.isFinite(halfH) || halfW <= 0 || halfH <= 0) {
    return [0, 0, 0];
  }
  const e = CORE_EXTENT * scale;
  const x = halfW - e - margin;
  const y = halfH - e - margin;
  if (x <= 0 || y <= 0) return [0, 0, 0];
  return [-x, -y, 0];
}

/** Half-extent of the center-stage box: a viz inside it owns the center. */
const CENTER_STAGE_HALF = 1.5;

/**
 * Whether the core should yield the center: true when the latest
 * visualization resolves inside the center-stage box. Multi-viz fans
 * whose latest entry sits on the rim keep the core where it is.
 */
export function shouldDockCore(entries: Pick<VisualizationEntry, "spec">[]): boolean {
  const latest = entries.at(-1);
  if (!latest) return false;
  const { position } = resolveVisualizationLayout(latest.spec, {
    count: entries.length,
    index: entries.length - 1,
  });
  return (
    Math.abs(position[0]) <= CENTER_STAGE_HALF && Math.abs(position[1]) <= CENTER_STAGE_HALF
  );
}
