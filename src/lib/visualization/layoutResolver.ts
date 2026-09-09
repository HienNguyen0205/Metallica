import type { VisualizationSpec } from "@/lib/store";

export interface LayoutPlacement {
  position: [number, number, number];
  scale: number;
}

export interface LayoutContext {
  count: number;
  index: number;
  viewportWidth: number;
  hasCore: boolean;
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
