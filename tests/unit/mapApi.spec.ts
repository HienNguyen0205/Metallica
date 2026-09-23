import { test, expect } from "@playwright/test";
import {
  avoidForProfile,
  defaultAvoid,
  formatClock,
  formatDistance,
  formatDuration,
  maneuverCoordinate,
  nextQuarterHourLocal,
  stepCoordinates,
  styleUrl,
  toOffsetIso,
  trafficSegments,
  weatherLine,
  weatherSegments,
  withTomTomKey,
  type Route,
} from "@/components/friday/map/mapApi";

const route: Route = {
  distance_m: 2412,
  duration_s: 545,
  traffic_delay_s: 0,
  traffic_sections: [],
  coordinates: [
    [105.8525, 21.0288],
    [105.843, 21.033],
    [105.8346, 21.0368],
  ],
  maneuvers: [
    { instruction: "a", maneuver: "DEPART", distance_m: 1100, duration_s: 250, begin_shape_index: 0 },
    { instruction: "b", maneuver: "TURN_RIGHT", distance_m: 1312, duration_s: 295, begin_shape_index: 1 },
    { instruction: "c", maneuver: "ARRIVE", distance_m: 0, duration_s: 0, begin_shape_index: 2 },
  ],
};

test("maneuvers resolve to their point and the stretch up to the next one", () => {
  expect(maneuverCoordinate(route, 1)).toEqual([105.843, 21.033]);
  expect(maneuverCoordinate(route, 9)).toBeNull();
  expect(stepCoordinates(route, 0)).toEqual([[105.8525, 21.0288], [105.843, 21.033]]);
  expect(stepCoordinates(route, 1)).toEqual([[105.843, 21.033], [105.8346, 21.0368]]);
  expect(stepCoordinates(route, 2)).toEqual([[105.8346, 21.0368]]);
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
  const traffic = decodeURIComponent(styleUrl("dark", true));
  expect(traffic).toContain("traffic_flow=2/flow_relative-dark");
  expect(traffic).toContain("traffic_incidents=2/incidents_dark");
  expect(decodeURIComponent(styleUrl("light", true))).toContain("traffic_incidents=2/incidents_light");
  expect(styleUrl("dark")).not.toContain("traffic_incidents");
});

test("TomTom resource URLs get the map key; others are untouched", () => {
  expect(withTomTomKey("https://api.tomtom.com/map/1/tile/basic/main/1/0/0.pbf")).toMatch(/\?key=/);
  expect(withTomTomKey("https://api.tomtom.com/x.json?a=1")).toMatch(/&key=/);
  expect(withTomTomKey("https://api.tomtom.com/x.json?key=abc")).toBe("https://api.tomtom.com/x.json?key=abc");
  expect(withTomTomKey("https://example.com/x.png")).toBe("https://example.com/x.png");
});

test("local datetime input values get an explicit offset", () => {
  expect(toOffsetIso("2026-09-24T08:00", 420)).toBe("2026-09-24T08:00:00+07:00");
  expect(toOffsetIso("2026-09-24T08:00", -330)).toBe("2026-09-24T08:00:00-05:30");
  expect(toOffsetIso("2026-09-24T08:00:30", 0)).toBe("2026-09-24T08:00:30+00:00");
  expect(formatClock("2026-09-24T07:52:00+07:00")).toBe("07:52");
  expect(nextQuarterHourLocal(new Date(2026, 8, 24, 8, 1))).toBe("2026-09-24T08:15");
  expect(nextQuarterHourLocal(new Date(2026, 8, 24, 23, 50))).toBe("2026-09-25T00:00");
});

test("motorbikes avoid motorways by default and the rule moves with the mode", () => {
  expect(defaultAvoid("motor_scooter")).toEqual(["motorways"]);
  expect(defaultAvoid("auto")).toEqual([]);
  expect(avoidForProfile(["motorways", "tolls"], "motor_scooter", "auto")).toEqual(["tolls"]);
  expect(avoidForProfile(["tolls"], "auto", "motor_scooter")).toEqual(["tolls", "motorways"]);
  expect(avoidForProfile(["tolls"], "auto", "bicycle")).toEqual(["tolls"]);
});

test("traffic sections become coloured segments of the route line", () => {
  const withTraffic = {
    ...route,
    traffic_sections: [
      { start: 0, end: 1, category: "jam" as const, delay_s: 360, magnitude: 3 },
      { start: 1, end: 2, category: "road_closure" as const, delay_s: 0, magnitude: 4 },
    ],
  };
  const fc = trafficSegments(withTraffic);
  expect(fc.features.map((f) => f.geometry.coordinates)).toEqual([
    [[105.8525, 21.0288], [105.843, 21.033]],
    [[105.843, 21.033], [105.8346, 21.0368]],
  ]);
  expect(fc.features.map((f) => f.properties)).toEqual([{ magnitude: 3, closure: false }, { magnitude: 4, closure: true }]);
});

test("rain on the route becomes dashed segments and one panel line", () => {
  const wet: Route = {
    ...route,
    weather: {
      status: "ok",
      sections: [
        { start: 0, end: 1, category: "rain", probability: 80, precip_mm: 1.2, from_time: "07:52", to_time: "07:57" },
        { start: 2, end: 2, category: "thunderstorm", probability: 90.4, precip_mm: 5, from_time: "08:01", to_time: "08:01" },
      ],
    },
  };
  const fc = weatherSegments(wet);
  expect(fc.features.map((f) => f.geometry.coordinates)).toEqual([[[105.8525, 21.0288], [105.843, 21.033]]]);
  expect(fc.features.map((f) => f.properties)).toEqual([{ category: "rain" }]);
  expect(weatherLine(wet)).toBe("Mưa 07:52–07:57 (80%) · dông 08:01 (90%)");
  expect(weatherLine({ ...route, weather: { status: "ok", sections: [] } })).toBe("Không mưa trên đường");
  for (const weather of [undefined, { status: "unavailable" as const }, { status: "out_of_range" as const }]) {
    expect(weatherLine({ ...route, weather })).toBeNull();
    expect(weatherSegments({ ...route, weather }).features).toEqual([]);
  }
});
