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
  expect(normalizeVisualization({ type: "radar", theme: { color: "javascript:alert(1)" } }).theme?.color).toBeUndefined();
  expect(normalizeVisualization({ type: "radar", theme: { color: "#38E8FF" } }).theme?.color).toBe("#38E8FF");
  expect(normalizeVisualization({ type: "radar", scale: 99 }).scale).toBe(4);
  expect(normalizeVisualization({ type: "radar", scale: -1 }).scale).toBe(0.25);
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
  const base = { count: 3, index: 0, viewportWidth: 1440, hasCore: true } as const;
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
