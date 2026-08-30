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
  // If spec already declares explicit position/scale, respect it
  if (spec.position && spec.scale !== undefined) {
    return { position: spec.position, scale: spec.scale };
  }

  const { count, index } = ctx;

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
  return {
    position: [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.35, 0],
    scale: count > 4 ? 0.62 : count > 2 ? 0.78 : 0.9,
  };
}
