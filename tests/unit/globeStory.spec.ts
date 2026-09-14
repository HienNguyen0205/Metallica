import { test, expect } from "@playwright/test";
import { markerWhy, resolveGlobeRoute } from "@/components/friday/visualization/globe/geo";
import {
  GLOBE_DEMO_POINTS,
  GLOBE_DEMO_ROUTES,
} from "@/lib/visualization/globeDemo";
import type { GeoPoint } from "@/lib/store";

test("markerWhy explains critical latency with the ms value", () => {
  const why = markerWhy({
    lat: 0,
    lon: 0,
    label: "TYO",
    status: "critical",
    metadata: { latencyMs: 210 },
  });
  expect(why).toBe("LATENCY ABOVE THRESHOLD · 210MS");
});

test("markerWhy degrades gracefully without telemetry", () => {
  expect(markerWhy({ lat: 0, lon: 0, status: "warning" })).toBe("HEALTH DEGRADED");
});

test("markerWhy flags high request volume on healthy nodes", () => {
  const why = markerWhy({
    lat: 0,
    lon: 0,
    status: "healthy",
    metadata: { requestsPerSecond: 15400 },
  });
  expect(why).toBe("HIGH REQUEST VOLUME · 15.4K REQUESTS/S");
});

test("markerWhy stays silent for healthy quiet nodes", () => {
  expect(markerWhy({ lat: 0, lon: 0, status: "healthy" })).toBeNull();
  expect(
    markerWhy({
      lat: 0,
      lon: 0,
      status: "healthy",
      metadata: { requestsPerSecond: 11999 },
    }),
  ).toBeNull();
});

test("demo points are valid single-source globe data", () => {
  expect(GLOBE_DEMO_POINTS.length).toBeGreaterThanOrEqual(6);
  const ids = new Set<string>();
  for (const p of GLOBE_DEMO_POINTS) {
    expect(p.lat).toBeGreaterThanOrEqual(-90);
    expect(p.lat).toBeLessThanOrEqual(90);
    expect(p.lon).toBeGreaterThanOrEqual(-180);
    expect(p.lon).toBeLessThanOrEqual(180);
    const key = (p as GeoPoint).id ?? (p as GeoPoint).label ?? "";
    expect(key).not.toBe("");
    expect(ids.has(key)).toBe(false);
    ids.add(key);
  }
});

test("every demo route resolves against the demo points", () => {
  expect(GLOBE_DEMO_ROUTES.length).toBeGreaterThan(0);
  for (const r of GLOBE_DEMO_ROUTES) {
    expect(resolveGlobeRoute(GLOBE_DEMO_POINTS, r)).not.toBeNull();
  }
});
