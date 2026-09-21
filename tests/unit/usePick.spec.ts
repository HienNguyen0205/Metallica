import { test, expect } from "@playwright/test";
import { CLICK_SLOP_PX, isClick } from "@/components/friday/visualization/usePick";

test("a click that barely moved still counts; a drag past the slop does not", () => {
  expect(isClick([100, 100], 100, 100)).toBe(true);
  expect(isClick([100, 100], 100 + CLICK_SLOP_PX, 100)).toBe(true);
  expect(isClick([100, 100], 100 + CLICK_SLOP_PX, 101)).toBe(false);
});

test("no recorded press (keyboard / synthetic click) is accepted", () => {
  expect(isClick(null, 0, 0)).toBe(true);
});
