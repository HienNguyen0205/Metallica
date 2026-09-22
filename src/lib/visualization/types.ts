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
  | "sankey_flow"
  | "map";

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
/** Travel mode for a map route (spec §5); the backend maps these to GraphHopper profiles. */
export type MapProfile = "auto" | "motor_scooter" | "bicycle" | "pedestrian";

export interface MapWaypoint {
  lat: number;
  lon: number;
  label?: string;
}

/**
 * Where a `map` visualization looks and what it routes. A route is intent
 * only — the map fetches the geometry from `/geo/route` itself, the same call
 * user-driven directions make (spec §5).
 */
export interface MapView {
  center?: { lat: number; lon: number };
  /** 0–20; defaults to 14 when only `center` is given. */
  zoom?: number;
  /** [west, south, east, north]; wins over center/zoom. */
  bbox?: [number, number, number, number];
  route?: { profile: MapProfile; waypoints: MapWaypoint[] };
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
  /** `map` visualizations only — camera and route intent. */
  map?: MapView;
  events?: TimelineEvent[];
  rate?: number;
}

/** §16/§5 — renderer contract. Pages never pick a component, only a spec. */
export interface VisualizationSpec {
  type: VisualizationType;
  data?: VizData;
  animation?: "materialize" | "pulse" | "none";
  /**
   * Wire contract with the backend. "none" (previews) disables picking; the
   * viz's own focus handlers gate on it. "drill_down" is the historical name
   * for "pickable" — the shared drill-down chrome is gone.
   */
  interaction?: "none" | "drill_down";
  theme?: { color?: string; accent?: string };
  position?: [number, number, number];
  scale?: number;
  title?: string;
}

/**
 * The single selection spine. Every visualization owns its focus rendering
 * now (gauge enlarge + dim, network neighbor highlight, bar lift, globe
 * camera fly, …); this record only identifies WHAT is selected so the HUD
 * `FOCUS ·` lane can name it and ESC/empty-click can release it. `owner`
 * namespaces `key` so two viz types can never collide.
 */
export interface VizFocus {
  /** Which visualization drew this selection: "globe" | "gauge" | "network" | "bar" | "line" | "timeline" | "radar" | "sankey". */
  owner: string;
  /** Stable element id within that owner (unique per owner only). */
  key: string;
  label: string;
  detail: string;
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
