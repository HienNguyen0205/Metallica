import { test, expect } from "@playwright/test";
import {
  dockPosition,
  shouldDockCore,
} from "@/lib/visualization/layoutResolver";
import type { VisualizationSpec } from "@/lib/visualization/types";

function entry(spec: Partial<VisualizationSpec> & { type: VisualizationSpec["type"] }) {
  return { spec: { animation: "materialize", ...spec } as VisualizationSpec };
}

test("no visualizations — core stays centered", () => {
  expect(shouldDockCore([])).toBe(false);
});

test("single centered viz — core docks aside", () => {
  expect(shouldDockCore([entry({ type: "globe" })])).toBe(true);
  expect(shouldDockCore([entry({ type: "radial_gauge" })])).toBe(true);
});

test("single explicitly off-center viz — core stays", () => {
  expect(shouldDockCore([entry({ type: "globe", position: [3, 0, 0] })])).toBe(false);
  expect(shouldDockCore([entry({ type: "globe", position: [0, 2, 0] })])).toBe(false);
});

test("explicitly near-center position still docks (boundary inclusive)", () => {
  expect(shouldDockCore([entry({ type: "globe", position: [1.5, -1.5, 0] })])).toBe(true);
  expect(shouldDockCore([entry({ type: "globe", position: [1.51, 0, 0] })])).toBe(false);
});

test("multi-viz fan decides by the latest entry", () => {
  // latest fans out to x≈-2.25 — off-center, core stays for the fan composition
  const fanned = [
    entry({ type: "radar" }),
    entry({ type: "radar" }),
    entry({ type: "radar" }),
  ];
  expect(shouldDockCore(fanned)).toBe(false);
  // latest fans to the top/bottom of the center column — core still yields
  const column = [entry({ type: "radar" }), entry({ type: "radar" })];
  expect(shouldDockCore(column)).toBe(true);
});

test("dock target hugs the screen corner inside both edges", () => {
  // receded scale 0.4 on desktop 9.0 x 5.6: extent 1.1, margin 0.35
  const [x, y, z] = dockPosition(4.5, 2.8, 0.4);
  expect(x).toBeCloseTo(-3.05, 5);
  expect(y).toBeCloseTo(-1.35, 5);
  expect(z).toBe(0);
});

test("ultrawide viewports dock further out", () => {
  const [x] = dockPosition(8, 2.8, 0.4);
  expect(x).toBeLessThan(-3.05);
});

test("too-small frames center instead of clipping", () => {
  expect(dockPosition(1.3, 2.8, 0.4)).toEqual([0, 0, 0]);
  expect(dockPosition(4.5, 1.0, 0.4)).toEqual([0, 0, 0]);
  expect(dockPosition(NaN, 2.8, 0.4)).toEqual([0, 0, 0]);
});
