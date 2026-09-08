import { test, expect } from "@playwright/test";
import { resolveLabelCapacity } from "@/components/friday/effects/textTexture";

test("without a capacity the texture fits the text exactly", () => {
  expect(resolveLabelCapacity(5)).toBe(5);
  expect(resolveLabelCapacity(18)).toBe(18);
});

test("a fixed capacity wins while the text fits inside it", () => {
  // readout "FRAME SYNC · 100HZ" stays 18 chars whether fps reads 9 or 100 —
  // the canvas must not realloc as the digits change
  expect(resolveLabelCapacity(3, 18)).toBe(18);
  expect(resolveLabelCapacity(18, 18)).toBe(18);
});

test("grows past the capacity rather than clipping the text", () => {
  expect(resolveLabelCapacity(40, 18)).toBe(40);
});
