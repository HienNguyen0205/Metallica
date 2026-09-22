import { test, expect } from "@playwright/test";
import {
  formatDistance,
  formatDuration,
  maneuverCoordinate,
  parseGeocoding,
  stepCoordinates,
  styleUrl,
  withTomTomKey,
  type Route,
} from "@/components/friday/map/mapApi";

const route: Route = {
  distance_m: 2412,
  duration_s: 545,
  coordinates: [
    [105.8525, 21.0288],
    [105.843, 21.033],
    [105.8346, 21.0368],
  ],
  maneuvers: [
    { instruction: "a", sign: 0, distance_m: 1100, duration_s: 250, begin_shape_index: 0 },
    { instruction: "b", sign: 2, distance_m: 1312, duration_s: 295, begin_shape_index: 1 },
    { instruction: "c", sign: 4, distance_m: 0, duration_s: 0, begin_shape_index: 2 },
  ],
};

test("maneuvers resolve to their point and the stretch up to the next one", () => {
  expect(maneuverCoordinate(route, 1)).toEqual([105.843, 21.033]);
  expect(maneuverCoordinate(route, 9)).toBeNull();
  expect(stepCoordinates(route, 0)).toEqual([[105.8525, 21.0288], [105.843, 21.033]]);
  expect(stepCoordinates(route, 1)).toEqual([[105.843, 21.033], [105.8346, 21.0368]]);
  expect(stepCoordinates(route, 2)).toEqual([[105.8346, 21.0368]]);
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

test("style URLs point at TomTom Map Styles v2, with traffic on demand", () => {
  const dark = styleUrl("dark");
  expect(dark).toContain("https://api.tomtom.com/style/1/style/");
  expect(decodeURIComponent(dark)).toContain("map=2/basic_street-dark");
  expect(dark).not.toContain("traffic_flow");
  expect(decodeURIComponent(styleUrl("light", true))).toContain("traffic_flow=2/flow_relative-light");
});

test("TomTom resource URLs get the map key; others are untouched", () => {
  expect(withTomTomKey("https://api.tomtom.com/map/1/tile/basic/main/1/0/0.pbf")).toMatch(/\?key=/);
  expect(withTomTomKey("https://api.tomtom.com/x.json?a=1")).toMatch(/&key=/);
  expect(withTomTomKey("https://api.tomtom.com/x.json?key=abc")).toBe("https://api.tomtom.com/x.json?key=abc");
  expect(withTomTomKey("https://example.com/x.png")).toBe("https://example.com/x.png");
});
