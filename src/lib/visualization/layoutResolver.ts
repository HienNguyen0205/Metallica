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
/** Entries drawn in the 3D scene — a `map` spec renders in the DOM map layer, never here. */
export function sceneEntries<T extends Pick<VisualizationEntry, "spec">>(entries: T[]): T[] {
  return entries.filter((e) => e.spec.type !== "map");
}
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
      radial_gauge: 1.0,
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
 * The docked core is anchored in *screen* space, not world space: each frame
 * the corner is found by unprojecting this NDC (bottom-left, with margin) and
 * stepping a fixed distance in front of the camera. World-unit math
 * (`tan(fov) * distance`) drifts when the camera dollies or tilts — the globe
 * zoom bug — whereas a pixel anchor stays put through any camera move, and the
 * fixed distance keeps the core's apparent size constant, HUD-like.
 */
export const CORE_ANCHOR_NDC: readonly [number, number] = [-0.8, -0.62];
export const CORE_ANCHOR_DISTANCE = 7.2;

/**
 * Auto-hide the core once the camera is close enough that the corner widget
 * would overlap the hologram being inspected, and only bring it back once the
 * camera has clearly pulled away (hysteresis → no edge flicker). Thresholds sit
 * between the globe's focus dolly (≈4.9) / min (4.4) and every state's idle
 * framing (≥6.15), so normal viewing never trips it.
 */
export const CORE_HIDE_NEAR = 5.6;
export const CORE_HIDE_RELEASE = 6.2;

export function decideCoreHidden(
  distance: number,
  currentlyHidden: boolean,
  near = CORE_HIDE_NEAR,
  release = CORE_HIDE_RELEASE,
): boolean {
  if (!Number.isFinite(distance)) return currentlyHidden;
  // Not yet hidden → cross the near gate to hide. Already hidden → stay hidden
  // until clearly past the (wider) release gate. The gap between the two is the
  // hysteresis band that stops the edge from flickering.
  return currentlyHidden ? distance <= release : distance < near;
}

/** Half-extent of the center-stage box: a viz inside it owns the center. */
const CENTER_STAGE_HALF = 1.5;

/**
 * Whether the core should yield the center: true when the latest
 * visualization resolves inside the center-stage box. Multi-viz fans
 * whose latest entry sits on the rim keep the core where it is.
 */
export function shouldDockCore(entries: Pick<VisualizationEntry, "spec">[]): boolean {
  const scene = sceneEntries(entries);
  const latest = scene.at(-1);
  if (!latest) return false;
  const { position } = resolveVisualizationLayout(latest.spec, {
    count: scene.length,
    index: scene.length - 1,
  });
  return (
    Math.abs(position[0]) <= CENTER_STAGE_HALF && Math.abs(position[1]) <= CENTER_STAGE_HALF
  );
}
