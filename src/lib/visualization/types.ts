/**
 * Visualization spec types — the renderer contract (§16/§5).
 *
 * Lives here rather than in the zustand store so pure modules (planner,
 * normalization, layout, event parsing, renderers) can depend on the contract
 * without importing store machinery. `lib/store` re-exports everything, so
 * existing `@/lib/store` type imports keep working.
 */

/** §16 — visualization kinds the renderer can materialize. */
export type VisualizationType =
  | "radial_gauge"
  | "radar"
  | "waveform"
  | "network"
  | "line_3d"
  | "bar_3d"
  | "globe"
  | "timeline"
  | "sankey_flow";

export interface MetricDatum {
  label: string;
  value: number;
  unit?: string;
}
export interface SeriesDatum {
  label: string;
  points: number[];
}
export interface NodeDatum {
  id: string;
  label?: string;
}
export interface GeoPoint {
  lat: number;
  lon: number;
  label?: string;
  /** Stable reference for routes (`GlobeRoute.from/to`). Falls back to label. */
  id?: string;
  /** Traffic / request volume / node importance — drives marker size. */
  value?: number;
  /** Health state — drives marker color. Defaults to "healthy". */
  status?: "healthy" | "warning" | "critical" | "offline";
  /** Explicit marker tint (hex). Overrides the status color. */
  color?: string;
  /** Live/simulated telemetry shown on focus (latencyMs, requestsPerSecond…). */
  metadata?: {
    region?: string;
    latencyMs?: number;
    requestsPerSecond?: number;
    uptime?: number;
    [key: string]: unknown;
  };
}
/** Curved data connection between two globe markers (§18-19 of the globe guide). */
export interface GlobeRoute {
  id: string;
  /** Marker id/label (string) or index into `points` (number). */
  from: string | number;
  /** Marker id/label (string) or index into `points` (number). */
  to: string | number;
  /** Traffic volume — drives arc thickness + particle count. */
  value?: number;
  latencyMs?: number;
  status?: "healthy" | "warning" | "critical";
}
export interface TimelineEvent {
  label: string;
  at: number;
}

export interface VizData {
  metrics?: MetricDatum[];
  series?: SeriesDatum[];
  nodes?: NodeDatum[];
  links?: [number, number][];
  points?: GeoPoint[];
  /** Globe arcs — `from`/`to` reference `points` by id/label/index. */
  routes?: GlobeRoute[];
  events?: TimelineEvent[];
  rate?: number;
}

/** §16/§5 — renderer contract. Pages never pick a component, only a spec. */
export interface VisualizationSpec {
  type: VisualizationType;
  data?: VizData;
  animation?: "materialize" | "pulse" | "none";
  /** "none" disables picking; anything else allows click-to-inspect. */
  interaction?: "none" | "drill_down";
  theme?: { color?: string; accent?: string };
  position?: [number, number, number];
  scale?: number;
  title?: string;
}

/** A visualization element the user drilled into. */
export interface VizFocus {
  label: string;
  detail: string;
  position: [number, number, number];
}

export type VizLifecycle = "materializing" | "active" | "updating" | "settling";

export interface VisualizationEntry {
  /** Stable identity across cap eviction — never use array index to settle. */
  id: number;
  spec: VisualizationSpec;
  lifecycle: VizLifecycle;
  /**
   * Early non-interactive materialize (§18). Replaced — not appended to — when
   * the turn's real spec arrives, so preview → viz never costs two slots.
   */
  preview?: boolean;
}
