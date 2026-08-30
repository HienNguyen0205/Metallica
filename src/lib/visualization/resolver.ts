import type { VisualizationSpec } from "@/lib/store";
import { normalizeVisualization } from "@/lib/visualization/normalization";
import { resolveAnimation, type MotionPreset } from "@/lib/visualization/animationResolver";
import { resolveVisualizationLayout, type LayoutPlacement, type LayoutContext } from "@/lib/visualization/layoutResolver";

export interface ResolvedVisualization {
  spec: VisualizationSpec;
  preset: MotionPreset;
  layout: LayoutPlacement;
}

export function resolveVisualization(
  spec: VisualizationSpec,
  layoutCtx?: Partial<LayoutContext>,
): ResolvedVisualization {
  const normalized = normalizeVisualization(spec);
  const preset = resolveAnimation(normalized);
  const layout = resolveVisualizationLayout(normalized, {
    count: 1,
    index: 0,
    viewportWidth: 1440,
    hasCore: true,
    ...layoutCtx,
  });
  return { spec: normalized, preset, layout };
}
