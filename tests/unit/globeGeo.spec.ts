import { test, expect } from "@playwright/test";
import {
  arcHeightFor,
  arcPointAt,
  buildArcPoints,
  latLonToVector3,
  markerDetail,
  markerRadius,
  normalizeMetric,
  particleCountFor,
  resolveEndpoint,
  resolveGlobeQuality,
  resolveGlobeRoute,
  SUN_DIRECTION,
  toAccessibleSummary,
} from "@/components/friday/visualization/globe/geo";
import type { GeoPoint } from "@/lib/store";

const R = 1.8;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("north pole maps to +Y, south pole to −Y", () => {
  expect(latLonToVector3(90, 0, R)).toEqual([0, R, 0]);
  const [x, y, z] = latLonToVector3(-90, 123, R);
  expect(close(x, 0) && close(y + R, 0) && close(z, 0)).toBe(true);
});

test("equator points sit in the XZ plane with unit radius", () => {
  for (const lon of [0, 90, -90, 180, -180, 42.5]) {
    const [x, y, z] = latLonToVector3(0, lon, R);
    expect(Math.abs(y)).toBeLessThan(1e-9);
    expect(Math.hypot(x, y, z)).toBeCloseTo(R, 9);
  }
});

test("prime meridian faces +X, date line faces −X", () => {
  const [x0] = latLonToVector3(0, 0, R);
  const [x180] = latLonToVector3(0, 180, R);
  expect(x0).toBeCloseTo(R, 9);
  expect(x180).toBeCloseTo(-R, 9);
});

test("known cities land in the right octants", () => {
  // SFO: north, west (−X), front (+Z)
  const [sx, sy, sz] = latLonToVector3(37.8, -122.4, R);
  expect(sx).toBeLessThan(0);
  expect(sy).toBeGreaterThan(0);
  expect(sz).toBeGreaterThan(0);
  // SYD: south
  expect(latLonToVector3(-33.9, 151.2, R)[1]).toBeLessThan(0);
  // TYO: north, east (this mapping puts east Asia at −X — locked by the
  // prime-meridian/dateline test above, so assert the actual convention).
  const [tx, ty] = latLonToVector3(35.7, 139.7, R);
  expect(ty).toBeGreaterThan(0);
  expect(tx).toBeLessThan(0);
});

test("metric normalization is log-scaled and bounded", () => {
  expect(normalizeMetric(0)).toBe(0);
  expect(normalizeMetric(-5)).toBe(0);
  expect(normalizeMetric(Number.NaN)).toBe(0);
  const small = normalizeMetric(100);
  const big = normalizeMetric(10000);
  expect(small).toBeGreaterThan(0);
  expect(big).toBeGreaterThan(small);
  // Linear would put 100k at 10x the max; log keeps it pinned at 1.
  expect(normalizeMetric(1e9)).toBe(1);
  expect(markerRadius(0)).toBeCloseTo(0.018, 9);
  expect(markerRadius(1)).toBeCloseTo(0.055, 9);
});

test("arcs keep endpoints and lift the apex off the surface", () => {
  const a = latLonToVector3(37.8, -122.4, R);
  const b = latLonToVector3(50.1, 8.7, R);
  const pts = buildArcPoints(a, b, R, 16);
  expect(pts).toHaveLength(17);
  expect(pts[0]![0]).toBeCloseTo(a[0], 9);
  expect(pts[16]![2]).toBeCloseTo(b[2], 9);
  const apex = pts.reduce((m, p) => Math.max(m, Math.hypot(p[0], p[1], p[2])), 0);
  expect(apex).toBeGreaterThan(R * 1.05);
});

test("antipodal arcs do not collapse through the planet", () => {
  const pts = buildArcPoints([R, 0, 0], [-R, 0, 0], R, 8);
  for (const p of pts) expect(Math.hypot(p[0], p[1], p[2])).toBeGreaterThan(R * 0.9);
});

test("arc height grows with angular distance", () => {
  expect(arcHeightFor(0.2)).toBeLessThan(arcHeightFor(2.0));
  expect(arcHeightFor(0)).toBeCloseTo(1.12, 9);
});

test("arcPointAt interpolates endpoints", () => {
  const pts = buildArcPoints([R, 0, 0], [0, R, 0], R, 4);
  const [ax, ay, az] = arcPointAt(pts, 0);
  expect(Math.hypot(ax - R, ay, az)).toBeLessThan(1e-9);
  const [bx, by, bz] = arcPointAt(pts, 1);
  expect(Math.hypot(bx, by - R, bz)).toBeLessThan(1e-9);
});

const POINTS: GeoPoint[] = [
  { id: "SFO", lat: 37.8, lon: -122.4, label: "SFO" },
  { id: "FRA", lat: 50.1, lon: 8.7, label: "FRA" },
];

test("route endpoints resolve by id, label, then index", () => {
  expect(resolveEndpoint(POINTS, "SFO")).toBe(0);
  expect(resolveEndpoint(POINTS, "fra")).toBe(1);
  expect(resolveEndpoint(POINTS, 1)).toBe(1);
  expect(resolveEndpoint(POINTS, "NRT")).toBe(-1);
  expect(resolveEndpoint(POINTS, 7)).toBe(-1);
  expect(resolveGlobeRoute(POINTS, { id: "r", from: "SFO", to: "FRA" })).toEqual({ a: 0, b: 1 });
  expect(resolveGlobeRoute(POINTS, { id: "r", from: "SFO", to: "SFO" })).toBeNull();
  expect(resolveGlobeRoute(POINTS, { id: "r", from: "SFO", to: "NRT" })).toBeNull();
});

test("particle counts communicate traffic within caps", () => {
  expect(particleCountFor(undefined)).toBe(1);
  expect(particleCountFor(100)).toBe(1);
  expect(particleCountFor(15400)).toBe(3);
  expect(particleCountFor(1e9)).toBe(3);
});

test("marker detail is generated from telemetry", () => {
  const d = markerDetail({
    lat: 0,
    lon: 0,
    label: "SFO",
    status: "healthy",
    metadata: { latencyMs: 31, requestsPerSecond: 12400 },
  });
  expect(d).toContain("31MS");
  expect(d).toContain("12.4K/S");
  expect(d).toContain("HEALTHY");
});

test("accessible summary covers empty and populated globes", () => {
  expect(toAccessibleSummary({})).toContain("No active nodes");
  const s = toAccessibleSummary({
    points: [
      { lat: 0, lon: 0, label: "SFO", status: "healthy", metadata: { latencyMs: 31 } },
      { lat: 0, lon: 0, label: "TYO", status: "warning", metadata: { latencyMs: 121 } },
    ],
  });
  expect(s).toContain("2 locations");
  expect(s).toContain("SFO healthy, 31 ms latency");
  expect(s).toContain("TYO warning, 121 ms latency");
});

test("quality resolver degrades clouds and particles first", () => {
  const high = resolveGlobeQuality({ preference: "high", systemReduced: false });
  expect(high.quality).toBe("high");
  expect(high.clouds).toBe(true);
  const low = resolveGlobeQuality({ preference: "low", systemReduced: false });
  expect(low.quality).toBe("low");
  expect(low.clouds).toBe(false);
  expect(low.particleScale).toBeLessThan(high.particleScale);
  const reduced = resolveGlobeQuality({ preference: "high", systemReduced: true });
  expect(reduced.quality).toBe("low");
  expect(resolveGlobeQuality({ preference: "auto", systemReduced: false }).quality).toBe("medium");
});

test("sun direction is a unit vector", () => {
  expect(Math.hypot(...SUN_DIRECTION)).toBeCloseTo(1, 9);
});
