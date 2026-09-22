import { test, expect } from "@playwright/test";
import {
  decodePolyline6,
  formatDistance,
  formatDuration,
  maneuverCoordinate,
  parseGeocoding,
  routeCoordinates,
  stepCoordinates,
  styleUrl,
  type Route,
} from "@/components/friday/map/mapApi";

const HANOI_SHAPE = "_{nbg@gdv{hEoeGvpQolF~kO"; // Hồ Gươm → Lăng Bác, 3 points

test("decodes Valhalla polyline6 into [lon, lat]", () => {
  expect(decodePolyline6(HANOI_SHAPE)).toEqual([
    [105.8525, 21.0288],
    [105.843, 21.033],
    [105.8346, 21.0368],
  ]);
  // Google's reference string, read at precision 6 instead of 5 (values /10).
  const ref = decodePolyline6("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  expect(ref[0][0]).toBeCloseTo(-12.02, 9);
  expect(ref[2][1]).toBeCloseTo(4.3252, 9);
  expect(decodePolyline6("")).toEqual([]);
});

test("route geometry spans legs and resolves maneuvers per leg", () => {
  const route: Route = {
    distance_m: 2400,
    duration_s: 540,
    legs: [
      { shape: HANOI_SHAPE, maneuvers: [
        { instruction: "a", type: 1, distance_m: 1, duration_s: 1, begin_shape_index: 0 },
        { instruction: "b", type: 1, distance_m: 1, duration_s: 1, begin_shape_index: 1 },
      ] },
      { shape: HANOI_SHAPE, maneuvers: [{ instruction: "c", type: 4, distance_m: 0, duration_s: 0, begin_shape_index: 2 }] },
    ],
  };
  expect(routeCoordinates(route)).toHaveLength(6);
  expect(maneuverCoordinate(route, 0, 1)).toEqual([105.843, 21.033]);
  expect(maneuverCoordinate(route, 1, 0)).toEqual([105.8346, 21.0368]);
  // a step runs from its maneuver to the next one (or the end of the leg)
  expect(stepCoordinates(route, 0, 0)).toEqual([[105.8525, 21.0288], [105.843, 21.033]]);
  expect(stepCoordinates(route, 0, 1)).toEqual([[105.843, 21.033], [105.8346, 21.0368]]);
});

test("parses MapTiler features and skips ones without a center", () => {
  expect(
    parseGeocoding({
      features: [
        { text: "Hồ Gươm", place_name: "Hồ Gươm, Hoàn Kiếm, Hà Nội", center: [105.8525, 21.0288], place_type: ["poi"] },
        { text: "broken" },
        { place_name: "Chỉ có địa chỉ", center: [106.7, 10.77] },
      ],
    }),
  ).toEqual([
    { label: "Hồ Gươm", address: "Hồ Gươm, Hoàn Kiếm, Hà Nội", category: "poi", lat: 21.0288, lon: 105.8525 },
    { label: "Chỉ có địa chỉ", address: "Chỉ có địa chỉ", category: undefined, lat: 10.77, lon: 106.7 },
  ]);
  expect(parseGeocoding(null)).toEqual([]);
});

test("formats distance and duration the Vietnamese way", () => {
  expect(formatDistance(430)).toBe("430 m");
  expect(formatDistance(2412)).toBe("2,4 km");
  expect(formatDuration(30)).toBe("1 phút");
  expect(formatDuration(545)).toBe("9 phút");
  expect(formatDuration(5400)).toBe("1 giờ 30 phút");
});

test("style URLs point at MapTiler maps", () => {
  expect(styleUrl("dark")).toContain("https://api.maptiler.com/maps/streets-v2-dark/style.json?key=");
  expect(styleUrl("satellite")).toContain("/maps/hybrid/");
});
