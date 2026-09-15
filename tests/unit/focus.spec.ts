import { test, expect } from "@playwright/test";
import {
  makeFocus,
  toggleFocus,
  releaseFocus,
  isFocusedBy,
  anyFocusedBy,
} from "@/lib/visualization/focus";

const GAUGE_A = makeFocus("gauge", "CPU", "CPU", "73%");
const GAUGE_B = makeFocus("gauge", "RAM", "RAM", "61%");
const NET_A = makeFocus("network", "api", "API", "2 LINKS");

test("makeFocus builds a selection record", () => {
  expect(GAUGE_A).toEqual({ owner: "gauge", key: "CPU", label: "CPU", detail: "73%" });
});

test("toggleFocus: same owner+key releases, anything else replaces", () => {
  expect(toggleFocus(GAUGE_A, GAUGE_A)).toBeNull();
  expect(toggleFocus(null, GAUGE_A)).toEqual(GAUGE_A);
  expect(toggleFocus(GAUGE_A, GAUGE_B)).toEqual(GAUGE_B);
  // a network node with the SAME key is a different owner — never a release
  expect(toggleFocus(makeFocus("network", "CPU", "C", "D"), GAUGE_A)).toEqual(GAUGE_A);
});

test("releaseFocus only clears this owner's selection", () => {
  expect(releaseFocus(GAUGE_A, "gauge")).toBeNull();
  expect(releaseFocus(NET_A, "gauge")).toEqual(NET_A);
  expect(releaseFocus(null, "gauge")).toBeNull();
});

test("isFocusedBy / anyFocusedBy isolate owners", () => {
  expect(isFocusedBy(GAUGE_A, "gauge", "CPU")).toBe(true);
  expect(isFocusedBy(GAUGE_A, "network", "CPU")).toBe(false);
  expect(isFocusedBy(GAUGE_A, "gauge", "RAM")).toBe(false);
  expect(isFocusedBy(null, "gauge", "CPU")).toBe(false);
  expect(anyFocusedBy(GAUGE_B, "gauge")).toBe(true);
  expect(anyFocusedBy(NET_A, "gauge")).toBe(false);
  expect(anyFocusedBy(null, "gauge")).toBe(false);
});
