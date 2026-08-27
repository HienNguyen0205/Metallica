import type { VisualizationType } from "@/lib/store";

/**
 * Registry knowledge at the lib layer (no React here).
 * Validates type before render and provides fallback.
 */
const KNOWN: Set<VisualizationType> = new Set([
  "radial_gauge",
  "health_core",
  "radar",
  "waveform",
  "network",
  "line_3d",
  "bar_3d",
  "particle_flow",
  "globe",
  "timeline",
]);

export function isKnownVisualization(type: string): boolean {
  return KNOWN.has(type as VisualizationType);
}

export function assertVisualizationType(type: string): VisualizationType {
  if (!KNOWN.has(type as VisualizationType)) {
    throw new Error(`unknown visualization type: ${type}`);
  }
  return type as VisualizationType;
}

export const VISUALIZATION_TYPES: VisualizationType[] = [...KNOWN];
