import type { GeoPoint, GlobeRoute, RenderQuality, VizData } from "@/lib/store";

export type Vec3 = [number, number, number];

/**
 * Canonical lat/lon → sphere position.
 *
 * Longitude convention: 0° (prime meridian) points toward -X…+Z blend defined
 * by theta = (lon + 180°); the equator lies in the XZ plane, +Y is north.
 * Every globe layer (surface markers, arcs, borders, camera focus) must use
 * this function — never an inline re-derivation.
 */
export function latLonToVector3(lat: number, lon: number, radius: number): Vec3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return [
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

/** Stable key for a marker — `GeoPoint.label` is optional, so index disambiguates. */
export function markerKey(point: GeoPoint, index: number): string {
  return `${point.id ?? point.label ?? "point"}-${index}`;
}

/** Display label for a marker. */
export function markerLabel(point: GeoPoint, index: number): string {
  return (point.label ?? point.id ?? `NODE-${index}`).toUpperCase();
}

export type MarkerStatus = "healthy" | "warning" | "critical" | "offline";

/** Status → Metallica palette (§16 of the globe guide — no unrelated colors). */
export const STATUS_COLORS: Record<MarkerStatus, string> = {
  healthy: "#38e8ff",
  warning: "#fbbf24",
  critical: "#f87171",
  offline: "#155e75",
};

export function statusOf(point: GeoPoint): MarkerStatus {
  return point.status ?? "healthy";
}

/**
 * Log-scale normalization so one giant city cannot dwarf the rest.
 * `max` defaults to a traffic-like magnitude; values are clamped to 0..1.
 */
export function normalizeMetric(value: number, max = 20000): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const normalized = Math.log(value + 1) / Math.log(max + 1);
  return Math.max(0, Math.min(1, normalized));
}

/** Marker core radius from a normalized value — deliberately narrow range. */
export function markerRadius(normalized: number): number {
  const t = Math.max(0, Math.min(1, normalized));
  return 0.018 + (0.055 - 0.018) * t;
}

/** Resolve a route endpoint (id → label → index) to a point index. */
export function resolveEndpoint(points: GeoPoint[], ref: string | number): number {
  if (typeof ref === "number") {
    return Number.isInteger(ref) && ref >= 0 && ref < points.length ? ref : -1;
  }
  const needle = ref.toLowerCase();
  let found = points.findIndex((p) => p.id?.toLowerCase() === needle);
  if (found >= 0) return found;
  found = points.findIndex((p) => p.label?.toLowerCase() === needle);
  return found;
}

/** Resolve a route to point indices, or null when either end is unresolvable. */
export function resolveGlobeRoute(
  points: GeoPoint[],
  route: GlobeRoute,
): { a: number; b: number } | null {
  const a = resolveEndpoint(points, route.from);
  const b = resolveEndpoint(points, route.to);
  if (a < 0 || b < 0 || a === b) return null;
  return { a, b };
}

/** Arc apex elevation scales with angular distance — short hops hug the surface. */
export function arcHeightFor(angle: number): number {
  const t = Math.max(0, Math.min(Math.PI, angle)) / Math.PI;
  return 1.12 + 0.38 * Math.sin(t * Math.PI * 0.5);
}

function angleBetween(a: Vec3, b: Vec3): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  if (la === 0 || lb === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / (la * lb))));
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Elevated arc between two surface points — never a straight line through
 * the planet. Spherical interpolation (slerp) scaled by a sine altitude
 * profile: endpoints are exact, the apex hits `radius * height` at t=0.5,
 * and no sample ever dips below the surface.
 */
export function buildArcPoints(a: Vec3, b: Vec3, radius: number, segments = 32): Vec3[] {
  const la = Math.hypot(a[0], a[1], a[2]) || 1;
  const lb = Math.hypot(b[0], b[1], b[2]) || 1;
  const na: Vec3 = [(a[0] / la) * radius, (a[1] / la) * radius, (a[2] / la) * radius];
  const nb: Vec3 = [(b[0] / lb) * radius, (b[1] / lb) * radius, (b[2] / lb) * radius];
  const angle = angleBetween(na, nb);
  const height = arcHeightFor(angle);
  const pts: Vec3[] = [];
  if (angle < 1e-6) {
    for (let i = 0; i <= segments; i++) pts.push([...na]);
    return pts;
  }
  // Antipodal endpoints have no unique slerp plane — swing through a stable
  // perpendicular axis instead of collapsing through the origin.
  const antipodal = Math.sin(angle) < 1e-4;
  const axis: Vec3 =
    antipodal && Math.abs(na[1] / radius) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const alt = 1 + (height - 1) * Math.sin(Math.PI * t);
    let dir: Vec3;
    if (antipodal) {
      const c = Math.cos(Math.PI * t);
      const s = Math.sin(Math.PI * t);
      dir = [
        (na[0] / radius) * c + axis[0] * s,
        (na[1] / radius) * c + axis[1] * s,
        (na[2] / radius) * c + axis[2] * s,
      ];
    } else {
      const sa = Math.sin(angle);
      const wa = Math.sin((1 - t) * angle) / sa;
      const wb = Math.sin(t * angle) / sa;
      dir = [
        (na[0] / radius) * wa + (nb[0] / radius) * wb,
        (na[1] / radius) * wa + (nb[1] / radius) * wb,
        (na[2] / radius) * wa + (nb[2] / radius) * wb,
      ];
    }
    pts.push([dir[0] * radius * alt, dir[1] * radius * alt, dir[2] * radius * alt]);
  }
  return pts;
}

/** Point on a sampled arc polyline at parameter t — drives route particles. */
export function arcPointAt(samples: Vec3[], t: number): Vec3 {
  if (samples.length === 0) return [0, 0, 0];
  if (t <= 0) return [...samples[0]] as Vec3;
  if (t >= 1) return [...samples[samples.length - 1]] as Vec3;
  const f = t * (samples.length - 1);
  const i = Math.min(samples.length - 2, Math.floor(f));
  return lerpVec(samples[i], samples[i + 1], f - i);
}

/** Particle count for a route — communicates traffic, capped hard. */
export function particleCountFor(value: number | undefined): number {
  if (value === undefined) return 1;
  return Math.max(1, Math.min(3, Math.round(value / 4000) || 1));
}

/** Drill-down detail line for a marker — generated from data, never hard-coded. */
export function markerDetail(point: GeoPoint): string {
  const parts: string[] = ["EDGE REGION"];
  const latency = point.metadata?.latencyMs;
  const rps = point.metadata?.requestsPerSecond;
  if (typeof latency === "number") parts.push(`${latency}MS`);
  if (typeof rps === "number") parts.push(rps >= 1000 ? `${(rps / 1000).toFixed(1)}K/S` : `${rps}/S`);
  parts.push(statusOf(point).toUpperCase());
  return parts.join(" · ");
}

/** Tooltip line explaining why a node is highlighted (§75 of the guide). */
export function markerWhy(point: GeoPoint): string | null {
  const latency = point.metadata?.latencyMs;
  if (point.status === "critical" || point.status === "warning") {
    return typeof latency === "number"
      ? `LATENCY ABOVE THRESHOLD · ${latency}MS`
      : "HEALTH DEGRADED";
  }
  const rps = point.metadata?.requestsPerSecond;
  if (typeof rps === "number" && rps >= 12000) {
    const v = rps >= 1000 ? `${(rps / 1000).toFixed(1)}K` : `${rps}`;
    return `HIGH REQUEST VOLUME · ${v} REQUESTS/S`;
  }
  return null;
}

/** DOM-accessible summary of the globe — screen readers never parse WebGL. */
export function toAccessibleSummary(data: VizData): string {
  const points = data.points ?? [];
  if (points.length === 0) return "Global Edge Map. No active nodes.";
  const lines = points.map((p, i) => {
    const label = markerLabel(p, i);
    const latency = p.metadata?.latencyMs;
    return `${label} ${statusOf(p)}${typeof latency === "number" ? `, ${latency} ms latency` : ""}`;
  });
  return `Global Edge Map. ${points.length} location${points.length > 1 ? "s" : ""}. ${lines.join(". ")}.`;
}

// ---------- quality ----------

export type GlobeQuality = "high" | "medium" | "low";

export const GEO_SEGMENTS: Record<GlobeQuality, number> = {
  high: 128,
  medium: 96,
  low: 64,
};

export interface GlobeQualityConfig {
  quality: GlobeQuality;
  segments: number;
  clouds: boolean;
  borders: boolean;
  particleScale: number;
  postBloom: boolean;
}

/**
 * Adaptive quality with hysteresis-friendly inputs: the caller feeds the
 * stored preference + reduced-motion flag, and gets a stable config.
 * `low` (or reduced motion) drops clouds and post work first.
 */
export function resolveGlobeQuality({
  preference,
  systemReduced,
}: {
  preference: RenderQuality;
  systemReduced: boolean;
}): GlobeQualityConfig {
  const quality: GlobeQuality =
    preference === "low" || systemReduced ? "low" : preference === "high" ? "high" : "medium";
  return {
    quality,
    segments: GEO_SEGMENTS[quality],
    clouds: quality !== "low",
    borders: quality !== "low",
    particleScale: quality === "high" ? 1 : quality === "medium" ? 0.6 : 0.3,
    postBloom: quality === "high",
  };
}

/** Stable sun direction for the demo terminator (§53 of the guide). */
export const SUN_DIRECTION: Vec3 = [-0.55, 0.32, 1].map((v) => {
  const len = Math.hypot(-0.55, 0.32, 1);
  return v / len;
}) as Vec3;
