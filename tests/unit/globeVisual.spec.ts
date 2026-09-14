import { test, expect } from "@playwright/test";
import {
  SUN_DIRECTION,
  SUN_CYCLE_SECONDS,
  sunDirectionAt,
  buildGraticule,
} from "@/components/friday/visualization/globe/geo";

const R = 1.8;
const sum = (d: readonly number[]) => Math.hypot(...d);

test("sunDirectionAt at phase 0 is the base direction", () => {
  expect(sunDirectionAt(0)).toEqual([...SUN_DIRECTION]);
});

test("sunDirectionAt stays unit-length with constant latitude (Y) across the cycle", () => {
  for (const p of [0, 0.7, 2, Math.PI, 5.5, Math.PI * 2]) {
    const d = sunDirectionAt(p);
    expect(sum(d)).toBeCloseTo(1, 9);
    expect(d[1]).toBeCloseTo(SUN_DIRECTION[1], 9);
  }
});

test("sunDirectionAt is 2π-periodic", () => {
  const a = sunDirectionAt(0.5);
  const b = sunDirectionAt(0.5 + Math.PI * 2);
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 6);
});

test("sun cycle period is a positive, slow duration", () => {
  expect(SUN_CYCLE_SECONDS).toBeGreaterThan(30);
  expect(SUN_CYCLE_SECONDS).toBeLessThan(600);
});

test("buildGraticule yields radius-accurate segment pairs", () => {
  const segs = buildGraticule(R, 12, 6, 32);
  expect(segs.length % 2).toBe(0);
  expect(segs.length).toBeGreaterThan(0);
  for (const p of segs) expect(sum(p)).toBeCloseTo(R, 6);
});

test("graticule passes through both poles and the equator", () => {
  const segs = buildGraticule(R, 4, 3, 24);
  expect(segs.some((p) => Math.abs(p[1] - R) < 1e-6)).toBe(true);
  expect(segs.some((p) => Math.abs(p[1] + R) < 1e-6)).toBe(true);
  expect(segs.some((p) => Math.abs(p[1]) < 1e-6)).toBe(true);
});
