import { test, expect } from "@playwright/test";
import {
  computeGlobeFocusAngles,
  globeFocusFor,
} from "@/components/friday/visualization/globe/geo";

test("globeFocusFor builds a native spine focus", () => {
  const f = globeFocusFor({ id: "HAN", lat: 21.03, lon: 105.85, label: "HAN" }, 0);
  expect(f.owner).toBe("globe");
  expect(f.key).toBe("HAN");
  expect(f.label).toBe("HAN");
  expect(f.detail).toContain("EDGE REGION");
  expect(f.native).toBe(true);
  expect(f.position).toBeUndefined();
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
