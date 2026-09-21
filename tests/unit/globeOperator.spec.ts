import { test, expect } from "@playwright/test";
import { withOperator } from "@/components/friday/visualization/globe/operator";

const POINTS = [
  { id: "sg", label: "SG", lat: 1.3, lon: 103.8 },
  { id: "fra", label: "FRA", lat: 50.1, lon: 8.7 },
];

test("no shared location leaves the points untouched", () => {
  expect(withOperator(POINTS, null)).toBe(POINTS);
});

test("the operator is appended last, so route indices never shift", () => {
  const out = withOperator(POINTS, { lat: 10.78, lon: 106.7 });
  expect(out.slice(0, 2)).toEqual(POINTS);
  expect(out[2]).toMatchObject({ id: "you", label: "YOU", lat: 10.78, lon: 106.7 });
});

test("a spec that already marks the operator is not doubled", () => {
  const spec = [...POINTS, { id: "you", label: "YOU", lat: 10.78, lon: 106.7 }];
  expect(withOperator(spec, { lat: 10.78, lon: 106.7 })).toBe(spec);
});
