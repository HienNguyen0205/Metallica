import { test, expect } from "@playwright/test";
import {
  timelineArcPoint,
  TL_RADIUS,
  TL_DEPTH,
  TL_Z0,
} from "@/components/friday/visualization/vizCharts";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("x increases monotonically along the arc", () => {
  let prev = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const [x] = timelineArcPoint(i / 20);
    expect(x).toBeGreaterThan(prev);
    prev = x;
  }
});

test("endpoints are mirror-symmetric about the center", () => {
  const a = timelineArcPoint(0.15);
  const b = timelineArcPoint(0.85);
  expect(close(a[0], -b[0]) && close(a[2], b[2])).toBe(true);
});

test("the middle of time is the point closest to the camera", () => {
  const mid = timelineArcPoint(0.5);
  expect(mid[0]).toBeCloseTo(0, 9);
  expect(mid[2]).toBeCloseTo(TL_Z0, 9);
  for (const t of [0, 0.2, 0.8, 1]) {
    expect(timelineArcPoint(t)[2]).toBeLessThan(mid[2]);
  }
});

test("every point lies on the elliptical arc", () => {
  for (const t of [0, 0.13, 0.5, 0.87, 1]) {
    const [x, y, z] = timelineArcPoint(t);
    expect(y).toBe(0);
    const e = (x / TL_RADIUS) ** 2 + ((z - (TL_Z0 - TL_DEPTH)) / TL_DEPTH) ** 2;
    expect(e).toBeCloseTo(1, 9);
  }
});

test("out-of-range and non-finite time are clamped, never NaN", () => {
  expect(timelineArcPoint(-2)).toEqual(timelineArcPoint(0));
  expect(timelineArcPoint(3)).toEqual(timelineArcPoint(1));
  expect(timelineArcPoint(Number.NaN)).toEqual(timelineArcPoint(0.5));
  for (const v of timelineArcPoint(Number.POSITIVE_INFINITY)) {
    expect(Number.isFinite(v)).toBe(true);
  }
});
