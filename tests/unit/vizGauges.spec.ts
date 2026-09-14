import { test, expect } from "@playwright/test";
import { gaugeNodeScale, gaugeVisual } from "@/components/friday/visualization/vizRadial";

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

test("resting gauge: no emphasis, no highlight, not dimmed", () => {
  expect(gaugeVisual({})).toEqual({ emphasis: 1, dimmed: false, highlighted: false });
});

test("hovered gauge enlarges and highlights but does not dim itself", () => {
  const v = gaugeVisual({ hovered: true });
  expect(v.emphasis).toBeCloseTo(1.15, 5);
  expect(v.highlighted).toBe(true);
  expect(v.dimmed).toBe(false);
});

test("selected gauge enlarges/highlights and is never the dimmed one", () => {
  const v = gaugeVisual({ selected: true, anySelected: true });
  expect(v.emphasis).toBeCloseTo(1.15, 5);
  expect(v.highlighted).toBe(true);
  expect(v.dimmed).toBe(false);
});

test("sibling of a focused gauge dims at rest (hover alone never dims)", () => {
  const dimmed = gaugeVisual({ anySelected: true });
  expect(dimmed.dimmed).toBe(true);
  expect(dimmed.emphasis).toBe(1);
  expect(dimmed.highlighted).toBe(false);
  // hover must not dim the other gauges — only selection does
  expect(gaugeVisual({ hovered: true, anySelected: false }).dimmed).toBe(false);
});
