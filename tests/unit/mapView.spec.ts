import { test, expect } from "@playwright/test";
import {
  INITIAL_MAP_VIEW,
  OVERZOOM_DECAY_MS,
  closeMapState,
  mapViewAfterSpec,
  openMapState,
  pushOverZoom,
  requestFromSpec,
  settleMapState,
  type OverZoom,
} from "@/lib/mapView";
import { useFridayStore } from "@/lib/store";

const HANOI = { lat: 21.03, lon: 105.85 };

test("walks globe → entering → map → leaving → globe", () => {
  let s = openMapState(INITIAL_MAP_VIEW, { center: HANOI, zoom: 2.2, source: "zoom" });
  expect(s.mode).toBe("entering");
  expect(s.rev).toBe(1);
  s = settleMapState(s);
  expect(s.mode).toBe("map");
  s = closeMapState(s, { lat: 10.77, lon: 106.7 });
  expect(s.mode).toBe("leaving");
  expect(s.center).toEqual({ lat: 10.77, lon: 106.7 });
  s = settleMapState(s);
  expect(s.mode).toBe("globe");
});

test("opening while open updates the view without re-entering; identical requests are no-ops", () => {
  const open = settleMapState(openMapState(INITIAL_MAP_VIEW, { center: HANOI, zoom: 14, source: "agent" }));
  const moved = openMapState(open, { center: { lat: 10.77, lon: 106.7 }, zoom: 14, source: "agent" });
  expect(moved.mode).toBe("map");
  expect(moved.rev).toBe(open.rev + 1);
  expect(openMapState(moved, { center: { lat: 10.77, lon: 106.7 }, zoom: 14, source: "agent" })).toBe(moved);
});

test("close and settle are no-ops from the wrong mode", () => {
  expect(closeMapState(INITIAL_MAP_VIEW)).toBe(INITIAL_MAP_VIEW);
  expect(settleMapState(INITIAL_MAP_VIEW)).toBe(INITIAL_MAP_VIEW);
});

test("a spec's center comes from bbox, then center, then first waypoint, then first point", () => {
  expect(requestFromSpec({ type: "map", data: { map: { bbox: [100, 10, 102, 12] } } })?.center).toEqual({ lat: 11, lon: 101 });
  expect(requestFromSpec({ type: "map", data: { map: { center: HANOI, zoom: 16 } } })).toMatchObject({ center: HANOI, zoom: 16, source: "agent" });
  expect(
    requestFromSpec({ type: "map", data: { map: { route: { profile: "auto", waypoints: [HANOI, { lat: 1, lon: 1 }] } } } })?.center,
  ).toEqual(HANOI);
  expect(requestFromSpec({ type: "map", data: { points: [{ ...HANOI, label: "HN" }] } })?.zoom).toBe(14);
  expect(requestFromSpec({ type: "map" })).toBeNull();
});

test("a map spec opens the map, any other spec closes it", () => {
  const opened = mapViewAfterSpec(INITIAL_MAP_VIEW, { type: "map", data: { map: { center: HANOI } } });
  expect(opened.mode).toBe("entering");
  expect(mapViewAfterSpec(settleMapState(opened), { type: "radial_gauge" }).mode).toBe("leaving");
  expect(mapViewAfterSpec(INITIAL_MAP_VIEW, { type: "globe" })).toBe(INITIAL_MAP_VIEW);
});

test("one wheel notch past the limit never fires; a sustained push does; pauses reset it", () => {
  let acc: OverZoom = { amount: 0, at: 0 };
  let r = pushOverZoom(acc, 0.25, 1000);
  expect(r.fire).toBe(false);
  acc = r.next;
  for (const t of [1100, 1200]) {
    r = pushOverZoom(acc, 0.25, t);
    expect(r.fire).toBe(false);
    acc = r.next;
  }
  r = pushOverZoom(acc, 0.25, 1300);
  expect(r.fire).toBe(true);
  expect(r.next.amount).toBe(0);

  acc = { amount: 0, at: 0 };
  for (let i = 0; i < 10; i++) {
    r = pushOverZoom(acc, 0.25, 5000 + i * (OVERZOOM_DECAY_MS + 1));
    expect(r.fire).toBe(false);
    acc = r.next;
  }
  expect(pushOverZoom({ amount: 0, at: 0 }, -5, 10).next.amount).toBe(0);
});

test("store: map specs open the map, other visualizations close it, reset returns to globe", () => {
  const api = useFridayStore;
  api.getState().reset();
  api.getState().addVisualization({ type: "map", data: { map: { center: HANOI } } });
  expect(api.getState().mapView.mode).toBe("entering");
  api.getState().settleMap();
  expect(api.getState().mapView.mode).toBe("map");
  api.getState().setVisualizations([{ type: "bar_3d" }]);
  expect(api.getState().mapView.mode).toBe("leaving");
  api.getState().reset();
  expect(api.getState().mapView).toEqual(INITIAL_MAP_VIEW);
});
