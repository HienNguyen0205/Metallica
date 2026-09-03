import { test, expect } from "@playwright/test";
import { useFridayStore } from "@/lib/store";

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
