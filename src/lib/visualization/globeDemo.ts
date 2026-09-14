import type { GeoPoint, GlobeRoute } from "@/lib/visualization/types";

/**
 * Single source for globe demo data.
 *
 * Previously the planner (`vizPlanner.ts`) and the renderer fallback
 * (`GlobeVisualization.tsx` DEFAULT_GEO) each carried their own copy — 6 rich
 * telemetry points vs 4 bare ones — matching only by coincidence. Both now
 * import from here. Consumers must treat these as read-only (`cloneSpec`
 * deep-copies on the planner path; the renderer only reads).
 */
export const GLOBE_DEMO_POINTS: GeoPoint[] = [
  { id: "SFO", lat: 37.8, lon: -122.4, label: "SFO", value: 12400, status: "healthy", metadata: { region: "US-WEST", latencyMs: 31, requestsPerSecond: 12400 } },
  { id: "FRA", lat: 50.1, lon: 8.7, label: "FRA", value: 9800, status: "healthy", metadata: { region: "EU-CENTRAL", latencyMs: 48, requestsPerSecond: 9800 } },
  { id: "SIN", lat: 1.35, lon: 103.8, label: "SIN", value: 15400, status: "healthy", metadata: { region: "AP-SOUTHEAST", latencyMs: 72, requestsPerSecond: 15400 } },
  { id: "TYO", lat: 35.7, lon: 139.7, label: "TYO", value: 11100, status: "warning", metadata: { region: "AP-NORTHEAST", latencyMs: 121, requestsPerSecond: 11100 } },
  { id: "SYD", lat: -33.9, lon: 151.2, label: "SYD", value: 6200, status: "healthy", metadata: { region: "AP-SOUTH", latencyMs: 37, requestsPerSecond: 6200 } },
  { id: "LON", lat: 51.5, lon: -0.1, label: "LON", value: 8700, status: "healthy", metadata: { region: "EU-WEST", latencyMs: 44, requestsPerSecond: 8700 } },
];

export const GLOBE_DEMO_ROUTES: GlobeRoute[] = [
  { id: "r-sfo-fra", from: "SFO", to: "FRA", value: 8200, latencyMs: 142 },
  { id: "r-sfo-tyo", from: "SFO", to: "TYO", value: 6400, latencyMs: 118, status: "warning" },
  { id: "r-sin-syd", from: "SIN", to: "SYD", value: 4100, latencyMs: 96 },
  { id: "r-fra-sin", from: "FRA", to: "SIN", value: 7300, latencyMs: 156 },
];
