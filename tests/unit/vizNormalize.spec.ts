import { test, expect } from "@playwright/test";
import { normalizeVisualization } from "@/lib/visualization/normalization";
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
