import { test, expect } from "@playwright/test";
import { useFridayStore } from "@/lib/store";
import { resolveHeavy, resolveReduced } from "@/lib/gpu";

const api = useFridayStore;

test.beforeEach(() => {
  api.getState().reset();
});

test("quality defaults to auto", () => {
  expect(api.getState().quality).toBe("auto");
});

test("quality can be set to high and low", () => {
  api.getState().setQuality("high");
  expect(api.getState().quality).toBe("high");
  api.getState().setQuality("low");
  expect(api.getState().quality).toBe("low");
});

test("reset keeps user quality preference", () => {
  api.getState().setQuality("low");
  api.getState().reset();
  expect(api.getState().quality).toBe("low");
});

test("heavy truth table: low never, high only on confirmed hardware", () => {
  expect(resolveHeavy({ quality: "low", gpuClass: "hardware", reduced: false })).toBe(false);
  expect(resolveHeavy({ quality: "high", gpuClass: "hardware", reduced: false })).toBe(true);
  expect(resolveHeavy({ quality: "high", gpuClass: "unknown", reduced: false })).toBe(false);
  expect(resolveHeavy({ quality: "high", gpuClass: "software", reduced: false })).toBe(false);
  expect(resolveHeavy({ quality: "auto", gpuClass: "hardware", reduced: false })).toBe(true);
  expect(resolveHeavy({ quality: "auto", gpuClass: "hardware", reduced: true })).toBe(false);
  expect(resolveHeavy({ quality: "auto", gpuClass: "unknown", reduced: false })).toBe(false);
});

test("reduced follows quality override, else system", () => {
  expect(resolveReduced({ quality: "low", systemReduced: false })).toBe(true);
  expect(resolveReduced({ quality: "high", systemReduced: true })).toBe(false);
  expect(resolveReduced({ quality: "auto", systemReduced: true })).toBe(true);
  expect(resolveReduced({ quality: "auto", systemReduced: false })).toBe(false);
});
