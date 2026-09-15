import { test, expect } from "@playwright/test";
import { railXFor, TL_RAIL_SPAN } from "@/components/friday/visualization/vizCharts";

test("rail centers time: t=0.5 sits at x=0, endpoints mirror", () => {
  expect(railXFor(0.5)).toBeCloseTo(0, 9);
  expect(railXFor(0)).toBeCloseTo(-TL_RAIL_SPAN / 2, 9);
  expect(railXFor(1)).toBeCloseTo(TL_RAIL_SPAN / 2, 9);
});

test("x is linear and monotonic in time", () => {
  expect(railXFor(0.75) - railXFor(0.5)).toBeCloseTo(railXFor(0.5) - railXFor(0.25), 9);
  for (let i = 1; i <= 10; i++) {
    expect(railXFor(i / 10)).toBeGreaterThan(railXFor((i - 1) / 10));
  }
});

test("out-of-range and non-finite time clamp to the rail", () => {
  expect(railXFor(-3)).toBe(railXFor(0));
  expect(railXFor(4)).toBe(railXFor(1));
  expect(railXFor(Number.NaN)).toBeCloseTo(0, 9);
  expect(Number.isFinite(railXFor(Number.POSITIVE_INFINITY))).toBe(true);
});
