/**
 * Map mode state (spec §3) — pure, so the store, the globe and the map layer
 * share one set of rules and the rules are unit-testable without React.
 * The store holds intent only; camera easing lives in refs and MapLibre.
 */
import type { GeoPoint, MapView, VisualizationSpec } from "@/lib/visualization/types";

export type MapMode = "globe" | "entering" | "map" | "leaving";
export type MapSource = "zoom" | "agent" | "user";

export interface MapViewState {
  mode: MapMode;
  center: { lat: number; lon: number };
  zoom: number;
  source: MapSource;
  view?: MapView;
  points?: GeoPoint[];
  /** Bumped on every accepted open request, so the map re-applies camera and route. */
  rev: number;
}

export interface OpenMapRequest {
  center: { lat: number; lon: number };
  zoom: number;
  source: MapSource;
  view?: MapView;
  points?: GeoPoint[];
}

/** MapLibre zoom whose globe matches the R3F globe's size at ENTER_DIST (tuned by eye in Task 9). */
export const HANDOFF_ZOOM = 2.2;
/** Where a zoom handoff flies once the crossfade lands. */
export const ARRIVAL_ZOOM = 5;
/** Zooming the map out past this hands back to the globe. */
export const LEAVE_ZOOM = 1.8;
/** A spec that gives a center but no zoom (spec §5). */
export const DEFAULT_SPEC_ZOOM = 14;

export const INITIAL_MAP_VIEW: MapViewState = {
  mode: "globe",
  center: { lat: 21.0285, lon: 105.8542 },
  zoom: HANDOFF_ZOOM,
  source: "user",
  rev: 0,
};

const isOpen = (s: MapViewState) => s.mode === "entering" || s.mode === "map";

export function openMapState(prev: MapViewState, req: OpenMapRequest): MapViewState {
  // A preview followed by the identical final spec must not re-fly the camera.
  if (
    isOpen(prev) &&
    JSON.stringify([prev.center, prev.zoom, prev.view, prev.points]) ===
      JSON.stringify([req.center, req.zoom, req.view, req.points])
  ) {
    return prev;
  }
  return { ...req, mode: isOpen(prev) ? prev.mode : "entering", rev: prev.rev + 1 };
}

/** `center` is where the map was looking, so the globe turns there on the way back. */
export function closeMapState(prev: MapViewState, center?: { lat: number; lon: number }): MapViewState {
  if (!isOpen(prev)) return prev;
  return { ...prev, mode: "leaving", center: center ?? prev.center };
}

export function settleMapState(prev: MapViewState): MapViewState {
  if (prev.mode === "entering") return { ...prev, mode: "map" };
  if (prev.mode === "leaving") return { ...prev, mode: "globe" };
  return prev;
}

export function requestFromSpec(spec: VisualizationSpec): OpenMapRequest | null {
  const view = spec.data?.map;
  const points = spec.data?.points;
  const fromBbox = view?.bbox
    ? { lat: (view.bbox[1] + view.bbox[3]) / 2, lon: (view.bbox[0] + view.bbox[2]) / 2 }
    : undefined;
  const c = fromBbox ?? view?.center ?? view?.route?.waypoints[0] ?? points?.[0];
  if (!c) return null;
  return {
    center: { lat: c.lat, lon: c.lon },
    zoom: view?.zoom ?? DEFAULT_SPEC_ZOOM,
    source: "agent",
    view,
    points,
  };
}

/** Spec §5: a map spec opens (or re-aims) the map; any other visualization closes it. */
export function mapViewAfterSpec(prev: MapViewState, spec: VisualizationSpec): MapViewState {
  if (spec.type !== "map") return closeMapState(prev);
  const req = requestFromSpec(spec);
  return req ? openMapState(prev, req) : prev;
}

// ---------- over-zoom: "keep pushing past the globe's limit" (spec §3.2) ----------

export interface OverZoom {
  amount: number;
  at: number;
}

/** One wheel notch pushes 0.25, so the handoff needs ~4 notches in a row. */
export const OVERZOOM_THRESHOLD = 1;
/** A pause this long starts the push over from zero. */
export const OVERZOOM_DECAY_MS = 600;

export function pushOverZoom(prev: OverZoom, push: number, now: number): { next: OverZoom; fire: boolean } {
  const base = now - prev.at > OVERZOOM_DECAY_MS ? 0 : prev.amount;
  const amount = base + Math.max(0, push);
  if (amount >= OVERZOOM_THRESHOLD) return { next: { amount: 0, at: now }, fire: true };
  return { next: { amount, at: now }, fire: false };
}
