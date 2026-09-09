import { test, expect } from "@playwright/test";
import {
  BAR_GROUP_MAX,
  BAR_WIDTH,
  barGroupPosition,
  barGroupWidth,
} from "@/components/friday/visualization/vizCharts";

test("single series is ungrouped: full width, centered on the category", () => {
  expect(BAR_GROUP_MAX).toBe(4);
  expect(barGroupWidth(1)).toBe(BAR_WIDTH);
  const [x1, , z1] = barGroupPosition(2, 7, 0, 1);
  const [x2, , z2] = barGroupPosition(2, 7, 0, 1);
  expect([x1, z1]).toEqual([x2, z2]);
});

test("grouped bars spread symmetrically around the category center", () => {
  const left = barGroupPosition(3, 7, 0, 2);
  const right = barGroupPosition(3, 7, 1, 2);
  const center = barGroupPosition(3, 7, 0, 1);
  // symmetric: midpoint of the pair is the single-bar position
  expect((left[0] + right[0]) / 2).toBeCloseTo(center[0], 5);
  expect((left[2] + right[2]) / 2).toBeCloseTo(center[2], 5);
  // distinct and ordered along the spread
  expect(left[0]).not.toBeCloseTo(right[0], 5);
  expect(barGroupWidth(2)).toBeCloseTo(BAR_WIDTH / 2, 10);
});

test("four series stay within one category slot", () => {
  const pts = [0, 1, 2, 3].map((si) => barGroupPosition(3, 7, si, 4));
  const xs = pts.map((p) => p[0]);
  const slot = Math.abs(barGroupPosition(4, 7, 0, 1)[0] - barGroupPosition(3, 7, 0, 1)[0]);
  expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(slot);
});
