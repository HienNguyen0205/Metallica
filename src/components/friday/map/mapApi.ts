/**
 * Everything the map talks to (spec §4.3): MapTiler styles + geocoding
 * (browser key, origin-restricted) and the orchestrator's /geo/route.
 * Pure helpers (decode, format, parse) are unit-tested.
 */
import { getApiBase } from "@/lib/api/session";
import type { MapProfile } from "@/lib/visualization/types";

export const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";

export type MapStyleId = "dark" | "light" | "satellite" | "terrain";

const STYLE_PATH: Record<MapStyleId, string> = {
  dark: "streets-v2-dark",
  light: "streets-v2",
  satellite: "hybrid",
  terrain: "outdoor-v2",
};

export function styleUrl(id: MapStyleId): string {
  return `https://api.maptiler.com/maps/${STYLE_PATH[id]}/style.json?key=${encodeURIComponent(MAPTILER_KEY)}`;
}

export const PROFILE_LABELS: Record<MapProfile, string> = {
  motor_scooter: "🛵 Xe máy",
  auto: "🚗 Ô tô",
  bicycle: "🚲 Xe đạp",
  pedestrian: "🚶 Đi bộ",
};

// ---------- geocoding ----------

export interface Place {
  label: string;
  address: string;
  category?: string;
  lat: number;
  lon: number;
}

/** A directions stop: a place with a display label. */
export interface Endpoint {
  lat: number;
  lon: number;
  label: string;
}

export function parseGeocoding(json: unknown): Place[] {
  const features = (json as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  return features.flatMap((f) => {
    const feat = f as { center?: unknown; text?: unknown; place_name?: unknown; place_type?: unknown };
    const c = feat.center;
    if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return [];
    const address = typeof feat.place_name === "string" ? feat.place_name : "";
    const label = typeof feat.text === "string" && feat.text ? feat.text : address;
    const category =
      Array.isArray(feat.place_type) && typeof feat.place_type[0] === "string" ? feat.place_type[0] : undefined;
    return [{ label, address, category, lat: c[1], lon: c[0] }];
  });
}

/** `near` is rounded to ~1 km before it leaves the browser (spec §6.5). */
export async function searchPlaces(
  query: string,
  near: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<Place[]> {
  const params = new URLSearchParams({ key: MAPTILER_KEY, language: "vi", limit: "6", autocomplete: "true" });
  if (near) params.set("proximity", `${near.lon.toFixed(2)},${near.lat.toFixed(2)}`);
  const res = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?${params}`, { signal });
  if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`);
  return parseGeocoding(await res.json());
}

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<Place | null> {
  const params = new URLSearchParams({ key: MAPTILER_KEY, language: "vi" });
  const res = await fetch(`https://api.maptiler.com/geocoding/${lon},${lat}.json?${params}`, { signal });
  if (!res.ok) return null;
  return parseGeocoding(await res.json())[0] ?? null;
}

// ---------- routing ----------

export interface Maneuver {
  instruction: string;
  type: number;
  distance_m: number;
  duration_s: number;
  begin_shape_index: number;
}

export interface RouteLeg {
  shape: string;
  maneuvers: Maneuver[];
}

export interface Route {
  distance_m: number;
  duration_s: number;
  legs: RouteLeg[];
}

export type RouteResult =
  | { ok: true; routes: Route[] }
  | { ok: false; reason: "unavailable" | "no_route" | "error" };

export async function fetchRoute(stops: Endpoint[], profile: MapProfile, signal?: AbortSignal): Promise<RouteResult> {
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}/geo/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ waypoints: stops.map(({ lat, lon }) => ({ lat, lon })), profile }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // Orchestrator offline reads the same as routing off: nothing to retry here.
    return { ok: false, reason: "unavailable" };
  }
  if (res.status === 503) return { ok: false, reason: "unavailable" };
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, reason: body?.error === "no_route" ? "no_route" : "error" };
  }
  const body = (await res.json()) as { routes?: Route[] };
  return { ok: true, routes: body.routes ?? [] };
}

/** Valhalla's encoded polyline (precision 6) → [lon, lat] pairs, GeoJSON order. */
export function decodePolyline6(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (let axis = 0; axis < 2; axis++) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

export function routeCoordinates(route: Route): [number, number][] {
  return route.legs.flatMap((leg) => decodePolyline6(leg.shape));
}

/** Where one maneuver happens — `begin_shape_index` is relative to its own leg. */
export function maneuverCoordinate(route: Route, legIndex: number, maneuverIndex: number): [number, number] | null {
  const leg = route.legs[legIndex];
  const m = leg?.maneuvers[maneuverIndex];
  if (!m) return null;
  return decodePolyline6(leg.shape)[m.begin_shape_index] ?? null;
}

/** The stretch one step covers: its maneuver up to the next one (or the leg's end). */
export function stepCoordinates(route: Route, legIndex: number, maneuverIndex: number): [number, number][] {
  const leg = route.legs[legIndex];
  const m = leg?.maneuvers[maneuverIndex];
  if (!m) return [];
  const coords = decodePolyline6(leg.shape);
  const end = leg.maneuvers[maneuverIndex + 1]?.begin_shape_index ?? coords.length - 1;
  return coords.slice(m.begin_shape_index, end + 1);
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} km`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} phút`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} giờ ${m} phút` : `${h} giờ`;
}
