import { test, expect } from "@playwright/test";
import {
  CORE_ANCHOR_NDC,
  CORE_ANCHOR_DISTANCE,
  CORE_HIDE_NEAR,
  CORE_HIDE_RELEASE,
  decideCoreHidden,
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

test("anchor NDC is in the bottom-left quadrant", () => {
  // Unprojecting this NDC each frame pins the core to a fixed pixel corner, so
  // it no longer drifts when the camera dollies/tilts (the zoom bug).
  expect(CORE_ANCHOR_NDC[0]).toBeLessThan(0);
  expect(CORE_ANCHOR_NDC[1]).toBeLessThan(0);
  // Inside the frustum, with margin from the very edge.
  expect(CORE_ANCHOR_NDC[0]).toBeGreaterThan(-1);
  expect(CORE_ANCHOR_NDC[1]).toBeGreaterThan(-1);
});

test("anchor sits a finite positive distance in front of the camera", () => {
  expect(CORE_ANCHOR_DISTANCE).toBeGreaterThan(0);
  expect(Number.isFinite(CORE_ANCHOR_DISTANCE)).toBe(true);
});

test("core hides near the viz and releases only past a wider distance (hysteresis)", () => {
  // Idle framing keeps it visible; a zoom-in close to the content hides it so
  // the corner widget never overlaps the hologram being inspected.
  expect(decideCoreHidden(7.2, false)).toBe(false);
  expect(decideCoreHidden(5.5, false)).toBe(true); // crossed the near gate
  // Once hidden, it must not flick back until past the release gate.
  expect(decideCoreHidden(5.9, true)).toBe(true);
  expect(decideCoreHidden(CORE_HIDE_RELEASE + 0.1, true)).toBe(false);
});

test("hide gate is strictly inside the release gate", () => {
  expect(CORE_HIDE_NEAR).toBeLessThan(CORE_HIDE_RELEASE);
});

test("decideCoreHidden is stable on a non-finite distance", () => {
  expect(decideCoreHidden(NaN, false)).toBe(false);
  expect(decideCoreHidden(NaN, true)).toBe(true);
});
