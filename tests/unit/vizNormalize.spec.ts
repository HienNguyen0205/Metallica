import { test, expect } from "@playwright/test";
import { normalizeVisualization, sanitizeMapView } from "@/lib/visualization/normalization";
import { resolveVisualizationLayout } from "@/lib/visualization/layoutResolver";

test("normalize does not mutate the caller's data object", () => {
  const input = { type: "radial_gauge" as const, data: { metrics: [{ label: "CPU", value: 1000 }] } };
  const out = normalizeVisualization(input);
  expect(out.data?.metrics?.[0]?.value).toBe(100);
  // input must be untouched — clamping wrote into a copy
  expect(input.data.metrics[0]?.value).toBe(1000);
});

test("normalize coerces non-finite metrics and drops bad series entries", () => {
  const out = normalizeVisualization({
    type: "radial_gauge",
    data: {
      metrics: [{ label: "CPU", value: NaN }, { label: "MEM", value: 42 }],
      series: [
        { label: "ok", points: [1, Number.NaN, 3] },
        // a series with no renderable points would crash max()/min() later
        { label: "junk", points: [] },
      ],
    },
  });
  expect(out.data?.metrics?.[0]?.value).toBe(0);
  expect(out.data?.metrics?.[1]?.value).toBe(42);
  expect(out.data?.series?.map((s) => s.label)).toEqual(["ok"]);
});

test("normalize sanitizes theme colors and clamps scale", () => {
  expect(normalizeVisualization({ type: "bar_3d", theme: { color: "javascript:alert(1)" } }).theme?.color).toBeUndefined();
  expect(normalizeVisualization({ type: "bar_3d", theme: { color: "#38E8FF" } }).theme?.color).toBe("#38E8FF");
  expect(normalizeVisualization({ type: "bar_3d", scale: 99 }).scale).toBe(4);
  expect(normalizeVisualization({ type: "bar_3d", scale: -1 }).scale).toBe(0.25);
});

test("normalize drops out-of-range network links", () => {
  const out = normalizeVisualization({
    type: "network",
    data: {
      nodes: [{ id: "a" }, { id: "b" }],
      // 99 points past the last node — used to draw a line to the origin
      links: [[0, 1], [0, 99], [-1, 1], [0, 1]],
    },
  });
  expect(out.data?.links).toEqual([[0, 1], [0, 1]]);
});

test("layout respects partial position/scale overrides", () => {
  const base = { count: 3, index: 0 } as const;
  const onlyPos = resolveVisualizationLayout(
    { type: "network", position: [1, 2, 3] },
    { ...base },
  );
  expect(onlyPos.position).toEqual([1, 2, 3]);
  expect(onlyPos.scale).toBe(0.78);

  const onlyScale = resolveVisualizationLayout({ type: "network", scale: 2 }, { ...base });
  expect(onlyScale.scale).toBe(2);
  expect(onlyScale.position).not.toEqual([0, 0, 0]);
});

test("normalize coerces non-string labels so canvas labels cannot crash", () => {
  const out = normalizeVisualization({
    type: "radial_gauge",
    data: {
      metrics: [
        { label: 123 as unknown as string, value: 50 },
        { label: "", value: 10 },
      ],
    },
  });
  expect(out.data?.metrics?.map((m) => m.label)).toEqual(["123"]);
});

test("normalize coerces node ids and timeline labels", () => {
  const out = normalizeVisualization({
    type: "network",
    data: {
      nodes: [{ id: 7 as unknown as string }, { id: "b", label: null as unknown as string }],
      links: [[0, 1]],
    },
  });
  expect(out.data?.nodes?.map((n) => n.id)).toEqual(["7", "b"]);
  const tl = normalizeVisualization({
    type: "timeline",
    data: { events: [{ label: 42 as unknown as string, at: 0.5 }] },
  });
  expect(tl.data?.events?.[0]?.label).toBe("42");
});

test("timeline events: non-finite `at` dropped, rest clamped to [0,1] and sorted", () => {
  const out = normalizeVisualization({
    type: "timeline",
    data: {
      events: [
        { label: "LATE", at: 4 },
        { label: "BAD", at: Number.NaN },
        { label: "MID", at: 0.5 },
        { label: "EARLY", at: -1 },
        { label: "STR", at: "0.3" as unknown as number },
      ],
    },
  });
  expect(out.data?.events).toEqual([
    { label: "EARLY", at: 0 },
    { label: "MID", at: 0.5 },
    { label: "LATE", at: 1 },
  ]);
});

test("series points below zero clamp to 0 — charts draw up from a zero baseline", () => {
  const out = normalizeVisualization({
    type: "bar_3d",
    data: { series: [{ label: "P&L", points: [-5, 3, -0.1] }] },
  });
  expect(out.data?.series?.[0]?.points).toEqual([0, 3, 0]);
});

test("duplicate series labels get a suffix — charts key and legend by label", () => {
  const out = normalizeVisualization({
    type: "line_3d",
    data: {
      series: [
        { label: "CPU", points: [1] },
        { label: "CPU", points: [2] },
        { label: "CPU", points: [3] },
      ],
    },
  });
  expect(out.data?.series?.map((s) => s.label)).toEqual(["CPU", "CPU-2", "CPU-3"]);
});

test("map view keeps valid center, zoom, bbox and route", () => {
  const view = sanitizeMapView({
    center: { lat: 21.03, lon: 105.85 },
    zoom: 15,
    bbox: [105.8, 21.0, 105.9, 21.1],
    route: {
      profile: "bicycle",
      waypoints: [
        { lat: 21.0288, lon: 105.8525, label: "HỒ GƯƠM" },
        { lat: 21.0368, lon: 105.8346 },
      ],
    },
  });
  expect(view).toEqual({
    center: { lat: 21.03, lon: 105.85 },
    zoom: 15,
    bbox: [105.8, 21.0, 105.9, 21.1],
    route: {
      profile: "bicycle",
      waypoints: [
        { lat: 21.0288, lon: 105.8525, label: "HỒ GƯƠM" },
        { lat: 21.0368, lon: 105.8346 },
      ],
    },
  });
});

test("map view drops out-of-range and malformed fields", () => {
  expect(sanitizeMapView(null)).toBeUndefined();
  expect(sanitizeMapView({ center: { lat: 91, lon: 0 }, zoom: 30 })).toBeUndefined();
  expect(sanitizeMapView({ bbox: [0, 10, 1, 5] })).toBeUndefined(); // south above north
  // a route needs 2-5 valid waypoints; an unknown profile falls back to the default (motorbike)
  expect(sanitizeMapView({ route: { profile: "rocket", waypoints: [{ lat: 1, lon: 1 }] } })).toBeUndefined();
  expect(
    sanitizeMapView({ route: { profile: "rocket", waypoints: [{ lat: 1, lon: 1 }, { lat: 2, lon: "x" }, { lat: 3, lon: 3 }] } }),
  ).toEqual({ route: { profile: "motor_scooter", waypoints: [{ lat: 1, lon: 1 }, { lat: 3, lon: 3 }] } });
});

test("normalizeVisualization sanitizes data.map", () => {
  const spec = normalizeVisualization({ type: "map", data: { map: { zoom: 99, center: { lat: 1, lon: 2 } } } });
  expect(spec.data?.map).toEqual({ center: { lat: 1, lon: 2 } });
});
