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
