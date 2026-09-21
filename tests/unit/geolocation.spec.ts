import { test, expect } from "@playwright/test";
import { useFridayStore } from "@/lib/store";
import { refreshIfStale, stopSharing } from "@/lib/geolocation";

type Ok = (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void;
type Fail = (e: { code: number; PERMISSION_DENIED: number }) => void;
let pending: { ok: Ok; fail: Fail } | null = null;

test.beforeAll(() => {
  Object.defineProperty(globalThis.navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition: (ok: Ok, fail: Fail) => (pending = { ok, fail }) },
  });
});

const GOOD = { lat: 10.776889, lon: 106.700806, accuracy: 12 };
const fix = (lat: number, lon: number) => ({ coords: { latitude: lat, longitude: lon, accuracy: 8 } });

test.beforeEach(() => {
  pending = null;
  useFridayStore.getState().setLocation({ ...GOOD }, "on");
});

test("a failed refresh keeps the last good fix and sharing on", () => {
  refreshIfStale(-1);
  // mid-refresh the old fix stays usable: queries and the globe keep it
  expect(useFridayStore.getState().location).toEqual(GOOD);
  expect(useFridayStore.getState().locationStatus).toBe("on");
  pending!.fail({ code: 3, PERMISSION_DENIED: 1 }); // TIMEOUT
  expect(useFridayStore.getState().location).toEqual(GOOD);
  expect(useFridayStore.getState().locationStatus).toBe("on");
});

test("a revoked permission during refresh does stop sharing", () => {
  refreshIfStale(-1);
  pending!.fail({ code: 1, PERMISSION_DENIED: 1 });
  expect(useFridayStore.getState().location).toBeNull();
  expect(useFridayStore.getState().locationStatus).toBe("denied");
});

test("a successful refresh replaces the fix", () => {
  refreshIfStale(-1);
  pending!.ok(fix(21.0285, 105.8542));
  expect(useFridayStore.getState().location).toEqual({ lat: 21.0285, lon: 105.8542, accuracy: 8 });
});

test("turning sharing off mid-refresh is not undone by the late fix", () => {
  refreshIfStale(-1);
  stopSharing();
  pending!.ok(fix(21.0285, 105.8542));
  expect(useFridayStore.getState().location).toBeNull();
  expect(useFridayStore.getState().locationStatus).toBe("off");
});
