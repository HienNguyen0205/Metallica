/**
 * Everything the map talks to (spec §4.3): TomTom styles/tiles with the
 * browser's Map-Display-only key, and the orchestrator's /geo/* endpoints for
 * search, places, reverse geocoding and routing (the TomTom server key never
 * reaches the browser). Pure helpers (styles, step geometry, format) are
 * unit-tested.
 */
import { getApiBase } from "@/lib/api/session";
import type { MapAvoid, MapProfile } from "@/lib/visualization/types";

export const TOMTOM_MAP_KEY = process.env.NEXT_PUBLIC_TOMTOM_MAP_KEY ?? "";

/** Map Styles v2 resource version; confirmed against the live API in Task 0/7. */
export const TOMTOM_STYLE_VERSION = "22.2.1-*";

export type MapStyleId = "dark" | "light" | "satellite";

const STYLES: Record<MapStyleId, { map: string; poi: string; flow: string; incidents: string }> = {
  dark: { map: "2/basic_street-dark", poi: "2/poi_dark", flow: "2/flow_relative-dark", incidents: "2/incidents_dark" },
  light: { map: "2/basic_street-light", poi: "2/poi_light", flow: "2/flow_relative-light", incidents: "2/incidents_light" },
  satellite: { map: "2/hybrid_street-satellite", poi: "2/poi_dark", flow: "2/flow_relative-dark", incidents: "2/incidents_dark" },
};

export function styleUrl(id: MapStyleId, traffic = false): string {
  const s = STYLES[id];
  const params = new URLSearchParams({ key: TOMTOM_MAP_KEY, map: s.map, poi: s.poi });
  if (traffic) {
    params.set("traffic_flow", s.flow);
    params.set("traffic_incidents", s.incidents);
  }
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

export const AVOID_ORDER: MapAvoid[] = ["tolls", "motorways", "ferries", "unpaved"];
export const AVOID_LABELS: Record<MapAvoid, string> = {
  tolls: "Tránh trạm thu phí",
  motorways: "Tránh cao tốc",
  ferries: "Tránh phà",
  unpaved: "Tránh đường đất",
};

/** Motorbikes are banned from Vietnamese expressways (spec 2026-09-23 §2). */
export function defaultAvoid(profile: MapProfile): MapAvoid[] {
  return profile === "motor_scooter" ? ["motorways"] : [];
}

/** Switching mode keeps the user's choices but moves the motorbike motorway rule with it. */
export function avoidForProfile(avoid: MapAvoid[], from: MapProfile, to: MapProfile): MapAvoid[] {
  const kept = from === "motor_scooter" ? avoid.filter((a) => a !== "motorways") : avoid;
  return to === "motor_scooter" && !kept.includes("motorways") ? [...kept, "motorways"] : kept;
}

export type RouteTime = { kind: "now" } | { kind: "depart" | "arrive"; at: string };

export interface RouteOptions {
  avoid: MapAvoid[];
  time: RouteTime;
}

/** `<input type="datetime-local">` value (no offset) → ISO with the browser's offset. */
export function toOffsetIso(local: string, offsetMin = -new Date(local).getTimezoneOffset()): string {
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const base = local.length === 16 ? `${local}:00` : local;
  return `${base}${sign}${hh}:${mm}`;
}

/** Default for a newly picked time: the next quarter hour, as a datetime-local value. */
export function nextQuarterHourLocal(now = new Date()): string {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** HH:MM of an ISO time as written (TomTom answers in the route's local time). */
export function formatClock(iso: string): string {
  return iso.slice(11, 16);
}

/** All four modes are on TomTom's free plan — the tabs if /geo/profiles cannot be read. */
export const DEFAULT_PROFILES: MapProfile[] = ["motor_scooter", "auto", "bicycle", "pedestrian"];

/** Travel modes the routing plan allows, default first (spec §6.3). */
export async function fetchProfiles(signal?: AbortSignal): Promise<MapProfile[]> {
  try {
    const res = await fetch(`${getApiBase()}/geo/profiles`, { signal });
    if (!res.ok) return DEFAULT_PROFILES;
    const body = (await res.json()) as { profiles?: MapProfile[] };
    return body.profiles?.length ? body.profiles : DEFAULT_PROFILES;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return DEFAULT_PROFILES;
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
  /** TomTom maneuver code (e.g. "TURN_RIGHT"); kept for a future turn icon. */
  maneuver: string;
  distance_m: number;
  duration_s: number;
  /** Index into `Route.coordinates` where this maneuver starts. */
  begin_shape_index: number;
}

export interface TrafficSection {
  start: number;
  end: number;
  category: "jam" | "road_work" | "road_closure" | "other";
  delay_s: number;
  /** 0 unknown, 1 minor … 4 indefinite (TomTom magnitudeOfDelay). */
  magnitude: number;
}

/** A rainy stretch of a route (spec 2026-09-23 open-meteo §5.3). */
export interface WeatherSection {
  start: number;
  end: number;
  category: "rain" | "heavy_rain" | "thunderstorm";
  probability: number;
  precip_mm: number;
  /** Local HH:MM when the rider enters / leaves the stretch. */
  from_time: string;
  to_time: string;
}

export interface RouteWeather {
  status: "ok" | "unavailable" | "out_of_range";
  /** Present only with status "ok"; [] means a dry route. */
  sections?: WeatherSection[];
}

export interface Route {
  distance_m: number;
  duration_s: number;
  /** Extra time from current traffic (TomTom). */
  traffic_delay_s: number;
  /** [lon, lat] pairs — GeoJSON order, ready for a LineString. */
  coordinates: [number, number][];
  maneuvers: Maneuver[];
  departure_time?: string | null;
  arrival_time?: string | null;
  traffic_sections: TrafficSection[];
  /** Rain along the way at the time it is passed (Open-Meteo). */
  weather?: RouteWeather;
}

export type RouteResult =
  | { ok: true; routes: Route[] }
  | { ok: false; reason: "unavailable" | "no_route" | "unsupported" | "quota" | "error" };

export async function fetchRoute(
  stops: Endpoint[],
  profile: MapProfile,
  options: RouteOptions,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const { time } = options;
  const body = {
    waypoints: stops.map(({ lat, lon }) => ({ lat, lon })),
    profile,
    avoid: options.avoid,
    ...(time.kind === "depart" ? { depart_at: time.at } : {}),
    ...(time.kind === "arrive" ? { arrive_at: time.at } : {}),
  };
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}/geo/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // Orchestrator offline reads the same as routing off: nothing to retry here.
    return { ok: false, reason: "unavailable" };
  }
  if (res.status === 503) return { ok: false, reason: "unavailable" };
  if (res.status === 429) return { ok: false, reason: "quota" };
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => null)) as { error?: string } | null;
    if (errorBody?.error === "no_route") return { ok: false, reason: "no_route" };
    if (errorBody?.error === "unsupported_profile") return { ok: false, reason: "unsupported" };
    return { ok: false, reason: "error" };
  }
  const data = (await res.json()) as { routes?: Route[] };
  return { ok: true, routes: data.routes ?? [] };
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

/** Congested stretches of one route as line features for the overlay layers. */
export function trafficSegments(route: Route): GeoJSON.FeatureCollection<GeoJSON.LineString, { magnitude: number; closure: boolean }> {
  return {
    type: "FeatureCollection",
    features: (route.traffic_sections ?? []).flatMap((s) => {
      const coordinates = route.coordinates.slice(s.start, s.end + 1);
      if (coordinates.length < 2) return [];
      return [{
        type: "Feature" as const,
        properties: { magnitude: s.magnitude, closure: s.category === "road_closure" },
        geometry: { type: "LineString" as const, coordinates },
      }];
    }),
  };
}

/** Rainy stretches of one route as line features for the weather overlay. */
export function weatherSegments(route: Route): GeoJSON.FeatureCollection<GeoJSON.LineString, { category: WeatherSection["category"] }> {
  return {
    type: "FeatureCollection",
    features: (route.weather?.sections ?? []).flatMap((s) => {
      const coordinates = route.coordinates.slice(s.start, s.end + 1);
      if (coordinates.length < 2) return [];
      return [{
        type: "Feature" as const,
        properties: { category: s.category },
        geometry: { type: "LineString" as const, coordinates },
      }];
    }),
  };
}

const WEATHER_LABELS: Record<WeatherSection["category"], string> = { rain: "mưa", heavy_rain: "mưa to", thunderstorm: "dông" };

/** The directions panel's one weather line, or null when there is nothing to say. */
export function weatherLine(route: Route): string | null {
  const weather = route.weather;
  if (weather?.status !== "ok") return null;
  const parts = (weather.sections ?? []).map((s) => {
    const when = s.from_time === s.to_time ? s.from_time : `${s.from_time}–${s.to_time}`;
    return `${WEATHER_LABELS[s.category]} ${when} (${Math.round(s.probability)}%)`;
  });
  if (parts.length === 0) return "Không mưa trên đường";
  const line = parts.join(" · ");
  return line[0].toUpperCase() + line.slice(1);
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
