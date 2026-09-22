/**
 * Everything the map talks to (spec §4.3): TomTom styles/tiles with the
 * browser's Map-Display-only key, and the orchestrator's /geo/* endpoints for
 * search, places, reverse geocoding and routing (the TomTom server key never
 * reaches the browser). Pure helpers (styles, step geometry, format) are
 * unit-tested.
 */
import { getApiBase } from "@/lib/api/session";
import type { MapProfile } from "@/lib/visualization/types";

export const TOMTOM_MAP_KEY = process.env.NEXT_PUBLIC_TOMTOM_MAP_KEY ?? "";

/** Map Styles v2 resource version; confirmed against the live API in Task 0/7. */
export const TOMTOM_STYLE_VERSION = "22.2.1-*";

export type MapStyleId = "dark" | "light" | "satellite";

const STYLES: Record<MapStyleId, { map: string; poi: string; flow: string }> = {
  dark: { map: "2/basic_street-dark", poi: "2/poi_dark", flow: "2/flow_relative-dark" },
  light: { map: "2/basic_street-light", poi: "2/poi_light", flow: "2/flow_relative-light" },
  satellite: { map: "2/hybrid_street-satellite", poi: "2/poi_dark", flow: "2/flow_relative-dark" },
};

export function styleUrl(id: MapStyleId, traffic = false): string {
  const s = STYLES[id];
  const params = new URLSearchParams({ key: TOMTOM_MAP_KEY, map: s.map, poi: s.poi });
  if (traffic) params.set("traffic_flow", s.flow);
  return `https://api.tomtom.com/style/1/style/${TOMTOM_STYLE_VERSION}?${params}`;
}

/** MapLibre `transformRequest`: TomTom tiles/sprites/glyphs named by the style may omit the key. */
export function withTomTomKey(url: string): string {
  if (!url.startsWith("https://api.tomtom.com/") || /[?&]key=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(TOMTOM_MAP_KEY)}`;
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

/** One autocomplete row; its position is fetched only when picked (Places Details is 5K/month). */
export interface Suggestion {
  ref: string;
  title: string;
  subtitle: string;
  type: string;
}

export type SuggestResult =
  | { ok: true; suggestions: Suggestion[] }
  | { ok: false; reason: "quota" | "unavailable" };

/** `near` is rounded to ~1 km before it leaves the browser (spec §6.5). */
export async function suggestPlaces(
  query: string,
  near: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<SuggestResult> {
  const params = new URLSearchParams({ q: query });
  if (near) {
    params.set("lat", near.lat.toFixed(2));
    params.set("lon", near.lon.toFixed(2));
  }
  const res = await fetch(`${getApiBase()}/geo/suggest?${params}`, { signal });
  if (res.status === 429) return { ok: false, reason: "quota" };
  if (!res.ok) return { ok: false, reason: "unavailable" };
  const body = (await res.json()) as { suggestions?: Suggestion[] };
  return { ok: true, suggestions: body.suggestions ?? [] };
}

export async function resolvePlace(s: Suggestion, signal?: AbortSignal): Promise<Place | null> {
  const res = await fetch(`${getApiBase()}/geo/place?${new URLSearchParams({ ref: s.ref })}`, { signal });
  if (!res.ok) return null;
  const { lat, lon } = (await res.json()) as { lat: number; lon: number };
  return { label: s.title, address: s.subtitle, category: s.type || undefined, lat, lon };
}

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<Place | null> {
  const res = await fetch(`${getApiBase()}/geo/reverse?${new URLSearchParams({ lat: String(lat), lon: String(lon) })}`, { signal });
  if (!res.ok) return null;
  const { address } = (await res.json()) as { address: string | null };
  return address ? { label: address, address, lat, lon } : null;
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
