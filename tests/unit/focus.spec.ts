import { test, expect } from "@playwright/test";
import {
  makeNativeFocus,
  makeDrilldownFocus,
  toggleFocus,
  releaseFocus,
  isFocusedBy,
  anyFocusedBy,
} from "@/lib/visualization/focus";
import type { VizFocus } from "@/lib/visualization/types";

const GAUGE_A = makeNativeFocus("gauge", "CPU", "CPU", "73%");
const GAUGE_B = makeNativeFocus("gauge", "RAM", "RAM", "61%");
const NET_A = makeNativeFocus("network", "api", "API", "2 LINKS");

test("makeNativeFocus builds a chrome-free selection", () => {
  expect(GAUGE_A).toEqual({
    owner: "gauge",
    key: "CPU",
    label: "CPU",
    detail: "73%",
    native: true,
    position: undefined,
  });
});

test("makeDrilldownFocus wraps the legacy reticle shape", () => {
  const f = makeDrilldownFocus("SFO-03", "48", [1, 2, 3]);
  expect(f.owner).toBe("drilldown");
  expect(f.key).toBe("SFO-03");
  expect(f.native).toBe(false);
  expect(f.position).toEqual([1, 2, 3]);
});

test("toggleFocus: same owner+key releases, anything else replaces", () => {
  expect(toggleFocus(GAUGE_A, GAUGE_A)).toBeNull();
  expect(toggleFocus(null, GAUGE_A)).toEqual(GAUGE_A);
  expect(toggleFocus(GAUGE_A, GAUGE_B)).toEqual(GAUGE_B);
  // a network node with the SAME key is a different owner — never a release
  expect(toggleFocus(makeNativeFocus("network", "CPU", "C", "D"), GAUGE_A)).toEqual(GAUGE_A);
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

test("helpers tolerate the legacy shape lacking new fields (cast)", () => {
  const legacy = { label: "X", detail: "y", position: [0, 0, 0] } as VizFocus;
  expect(isFocusedBy(legacy, "gauge", "X")).toBe(false);
  expect(anyFocusedBy(legacy, "gauge")).toBe(false);
});
