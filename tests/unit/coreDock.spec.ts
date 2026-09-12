import { test, expect } from "@playwright/test";
import {
  CORE_DOCK_OFFSET,
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
    entry({ type: "network" }),
    entry({ type: "network" }),
    entry({ type: "network" }),
  ];
  expect(shouldDockCore(fanned)).toBe(false);
  // latest fans to the top/bottom of the center column — core still yields
  const column = [entry({ type: "network" }), entry({ type: "network" })];
  expect(shouldDockCore(column)).toBe(true);
});

test("dock offset is a fixed, in-frame lower-left anchor", () => {
  expect(CORE_DOCK_OFFSET).toEqual([-2.9, -1.1, 0]);
});
