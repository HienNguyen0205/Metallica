/**
 * Everything the map talks to (spec §4.3): MapTiler styles + geocoding
 * (browser key, origin-restricted) and the orchestrator's /geo/route and /geo/profiles (the GraphHopper key stays on the server).
 * Pure helpers (parse, step geometry, format) are unit-tested.
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

/** GraphHopper's free plan — what the tabs show if /geo/profiles cannot be read. */
export const FREE_PLAN_PROFILES: MapProfile[] = ["auto", "bicycle", "pedestrian"];

/** Travel modes the routing plan allows, default first (spec §6.3). */
export async function fetchProfiles(signal?: AbortSignal): Promise<MapProfile[]> {
  try {
    const res = await fetch(`${getApiBase()}/geo/profiles`, { signal });
    if (!res.ok) return FREE_PLAN_PROFILES;
    const body = (await res.json()) as { profiles?: MapProfile[] };
    return body.profiles?.length ? body.profiles : FREE_PLAN_PROFILES;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return FREE_PLAN_PROFILES;
  }
}

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
  /** GraphHopper turn sign (-98..8); kept for a future turn icon. */
  sign: number;
  distance_m: number;
  duration_s: number;
  /** Index into `Route.coordinates` where this maneuver starts. */
  begin_shape_index: number;
}

export interface Route {
  distance_m: number;
  duration_s: number;
  /** [lon, lat] pairs — GeoJSON order, ready for a LineString. */
  coordinates: [number, number][];
  maneuvers: Maneuver[];
}

export type RouteResult =
  | { ok: true; routes: Route[] }
  | { ok: false; reason: "unavailable" | "no_route" | "unsupported" | "error" };

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
    if (body?.error === "no_route") return { ok: false, reason: "no_route" };
    if (body?.error === "unsupported_profile") return { ok: false, reason: "unsupported" };
    return { ok: false, reason: "error" };
  }
  const body = (await res.json()) as { routes?: Route[] };
  return { ok: true, routes: body.routes ?? [] };
}

/** Where maneuver `i` happens. */
export function maneuverCoordinate(route: Route, i: number): [number, number] | null {
  const m = route.maneuvers[i];
  return m ? (route.coordinates[m.begin_shape_index] ?? null) : null;
}

/** The stretch step `i` covers: its maneuver up to the next one (or the end). */
export function stepCoordinates(route: Route, i: number): [number, number][] {
  const m = route.maneuvers[i];
  if (!m) return [];
  const end = route.maneuvers[i + 1]?.begin_shape_index ?? route.coordinates.length - 1;
  return route.coordinates.slice(m.begin_shape_index, end + 1);
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
