import { test, expect } from "@playwright/test";
import {
  computeGlobeFocusAngles,
  globeFocusFor,
  isGlobeTag,
} from "@/components/friday/visualization/globe/geo";

test("globeFocusFor builds store focus from marker (label/detail/position)", () => {
  const f = globeFocusFor(
    { lat: 21.03, lon: 105.85, id: "HAN", label: "HAN" },
    0,
    [1, 2, 3],
  );
  expect(f.label).toBe("HAN");
  expect(f.detail).toContain("EDGE REGION");
  expect(f.position).toEqual([1, 2, 3]);
  expect(f.globe).toBe(true);
});

test("computeGlobeFocusAngles clamps high latitude tilt", () => {
  const a = computeGlobeFocusAngles(50.11, 8.68, 0);
  expect(a.pitch).toBeLessThanOrEqual(0.85);
  expect(Number.isFinite(a.yaw)).toBe(true);
});

test("computeGlobeFocusAngles wraps antimeridian yaw delta", () => {
  const a = computeGlobeFocusAngles(0, 179.9, 0);
  const b = computeGlobeFocusAngles(0, -179.9, 0);
  expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(0.05);
});

test("isGlobeTag is data-driven, not label denylist", () => {
  expect(isGlobeTag({ label: "CUSTOM-CITY", detail: "x", globe: true })).toBe(true);
  expect(isGlobeTag({ label: "SFO", detail: "x" })).toBe(false);
  expect(isGlobeTag({ label: "MY-NEW-NODE", detail: "x" })).toBe(false);
});
