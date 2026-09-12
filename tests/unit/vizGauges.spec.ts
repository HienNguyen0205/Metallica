import { test, expect } from "@playwright/test";
import { gaugeNodeScale } from "@/components/friday/visualization/vizRadial";

test("small counts render full size", () => {
  expect(gaugeNodeScale(0)).toBe(1);
  expect(gaugeNodeScale(1)).toBe(1);
  expect(gaugeNodeScale(4)).toBe(1);
  expect(gaugeNodeScale(6)).toBe(1);
});

test("large counts shrink instead of colliding", () => {
  expect(gaugeNodeScale(7)).toBeLessThan(1);
  expect(gaugeNodeScale(12)).toBeCloseTo(0.5, 5);
});

test("shrinkage floors instead of vanishing", () => {
  expect(gaugeNodeScale(100)).toBe(0.45);
  expect(gaugeNodeScale(1000)).toBe(0.45);
});
