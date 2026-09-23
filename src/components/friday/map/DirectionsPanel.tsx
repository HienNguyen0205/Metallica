"use client";

import { useEffect, useState } from "react";
import { Marker, type GeoJSONSource, type LineLayerSpecification, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import type { MapAvoid, MapProfile } from "@/lib/visualization/types";
import type { DirectionsValue } from "./MapLayer";
import { MapSearch } from "./MapSearch";
import {
  AVOID_LABELS,
  AVOID_ORDER,
  PROFILE_LABELS,
  avoidForProfile,
  fetchRoute,
  formatClock,
  formatDistance,
  formatDuration,
  maneuverCoordinate,
  nextQuarterHourLocal,
  stepCoordinates,
  toOffsetIso,
  trafficSegments,
  type Endpoint,
  type Route,
  type RouteTime,
} from "./mapApi";

const ROUTE_SRC = "friday-route";
const STEP_SRC = "friday-route-step";
const TRAFFIC_SRC = "friday-route-traffic";

type Status = "idle" | "loading" | "ok" | "unavailable" | "no_route" | "unsupported" | "quota" | "error";
const STATUS_TEXT: Partial<Record<Status, string>> = {
  loading: "Đang tìm đường…",
  unavailable: "Chỉ đường chưa được cấu hình",
  no_route: "Không tìm thấy đường đi",
  unsupported: "Gói chỉ đường hiện tại không hỗ trợ phương tiện này",
  quota: "Chỉ đường tạm hết hạn mức",
  error: "Không tính được đường đi",
};

type Line = GeoJSON.Feature<GeoJSON.LineString, { i: number; selected: boolean }>;

function routeData(routes: Route[], selected: number): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  return {
    type: "FeatureCollection",
    features: routes.map<Line>((r, i) => ({
      type: "Feature",
      properties: { i, selected: i === selected },
      geometry: { type: "LineString", coordinates: r.coordinates },
    })),
  };
}

/** Add or refresh the route layers — also after a style swap, which drops them. */
function drawRoutes(map: MlMap, routes: Route[], selected: number, step: [number, number][]) {
  const data = routeData(routes, selected);
  const stepData: GeoJSON.Feature<GeoJSON.LineString> = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: step } };
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  const trafficData = routes[selected] ? trafficSegments(routes[selected]) : empty;
  const src = map.getSource(ROUTE_SRC) as GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    (map.getSource(STEP_SRC) as GeoJSONSource).setData(stepData);
    (map.getSource(TRAFFIC_SRC) as GeoJSONSource).setData(trafficData);
    return;
  }
  map.addSource(ROUTE_SRC, { type: "geojson", data });
  map.addSource(TRAFFIC_SRC, { type: "geojson", data: trafficData });
  map.addSource(STEP_SRC, { type: "geojson", data: stepData });
  const layout: LineLayerSpecification["layout"] = { "line-join": "round", "line-cap": "round", "line-sort-key": ["case", ["get", "selected"], 1, 0] };
  map.addLayer({ id: "friday-route-casing", type: "line", source: ROUTE_SRC, layout, paint: { "line-color": ["case", ["get", "selected"], "#0b3d4a", "#1f2a33"], "line-width": 10 } });
  map.addLayer({ id: "friday-route-line", type: "line", source: ROUTE_SRC, layout, paint: { "line-color": ["case", ["get", "selected"], "#38e8ff", "#6b7c8a"], "line-width": 5 } });
  // Congestion on the selected route (spec 2026-09-23 §5.2): 0–1 yellow, 2 orange, 3–4 red; closures dark red, dashed.
  map.addLayer({
    id: "friday-route-traffic", type: "line", source: TRAFFIC_SRC, filter: ["!", ["get", "closure"]],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": ["match", ["get", "magnitude"], [0, 1], "#fbbf24", 2, "#fb923c", "#f87171"], "line-width": 5 },
  });
  map.addLayer({
    id: "friday-route-closure", type: "line", source: TRAFFIC_SRC, filter: ["get", "closure"],
    paint: { "line-color": "#7f1d1d", "line-width": 5, "line-dasharray": [1.5, 1] },
  });
  map.addLayer({ id: "friday-route-step", type: "line", source: STEP_SRC, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#eafcff", "line-width": 7 } });
}

function clearRoutes(map: MlMap) {
  // The map may already be removed when the panel unmounts with it.
  try {
    for (const id of ["friday-route-step", "friday-route-closure", "friday-route-traffic", "friday-route-line", "friday-route-casing"]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [STEP_SRC, TRAFFIC_SRC, ROUTE_SRC]) if (map.getSource(id)) map.removeSource(id);
  } catch {
    /* map gone */
  }
}

function fitRoute(map: MlMap, route: Route) {
  const coords = route.coordinates;
  if (coords.length === 0) return;
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  map.fitBounds(
    [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ],
    // Left padding clears the 380px panel on desktop.
    { padding: { top: 90, bottom: 90, left: window.innerWidth >= 768 ? 440 : 40, right: 80 }, duration: 1200, maxZoom: 17 },
  );
}

export function DirectionsPanel({
  map,
  value,
  profiles,
  onChange,
  onClose,
  getNear,
}: {
  map: MlMap;
  value: DirectionsValue;
  /** Modes the routing plan allows (GET /geo/profiles), default first. */
  profiles: MapProfile[];
  onChange: (v: DirectionsValue) => void;
  onClose: () => void;
  getNear: () => { lat: number; lon: number } | null;
}) {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState<[number, number][]>([]);

  // Fetch whenever the stops or the mode change (spec §4.2).
  useEffect(() => {
    const stops = value.stops;
    if (!stops.every((s): s is Endpoint => s !== null)) {
      // Synchronous reset is intentional: incomplete stops mean no route to show.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRoutes([]);
      setStatus("idle");
      return;
    }
    const ctrl = new AbortController();
    setStatus("loading");
    fetchRoute(stops, value.profile, { avoid: value.avoid, time: value.time }, ctrl.signal)
      .then((r) => {
        if (!r.ok) {
          setRoutes([]);
          setStatus(r.reason);
          return;
        }
        setRoutes(r.routes);
        setSelected(0);
        setStatus(r.routes.length > 0 ? "ok" : "no_route");
        if (r.routes[0]) fitRoute(map, r.routes[0]);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setStatus("error");
      });
    return () => ctrl.abort();
  }, [map, value]);

  // Route layers, redrawn after style swaps; removed with the panel.
  useEffect(() => {
    const draw = () => drawRoutes(map, routes, selected, step);
    if (map.isStyleLoaded()) draw();
    map.on("style.load", draw);
    return () => {
      map.off("style.load", draw);
    };
  }, [map, routes, selected, step]);
  useEffect(() => () => clearRoutes(map), [map]);

  // Click a grey alternative to select it.
  useEffect(() => {
    const onClick = (e: MapLayerMouseEvent) => {
      const i = e.features?.[0]?.properties?.i;
      if (typeof i === "number") setSelected(i);
    };
    map.on("click", "friday-route-line", onClick);
    return () => {
      map.off("click", "friday-route-line", onClick);
    };
  }, [map]);

  // Draggable stops: drop to reroute.
  useEffect(() => {
    const last = value.stops.length - 1;
    const markers = value.stops.flatMap((s, i) => {
      if (!s) return [];
      const el = document.createElement("div");
      el.className = "friday-map-stop";
      el.textContent = i === 0 ? "A" : i === last ? "B" : String(i);
      const m = new Marker({ element: el, draggable: true }).setLngLat([s.lon, s.lat]).addTo(map);
      m.on("dragend", () => {
        const ll = m.getLngLat();
        const stops = [...value.stops];
        stops[i] = { lat: ll.lat, lon: ll.lng, label: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}` };
        onChange({ ...value, stops });
      });
      return [m];
    });
    return () => markers.forEach((m) => m.remove());
  }, [map, value, onChange]);

  const setStop = (i: number, e: Endpoint) => {
    const stops = [...value.stops];
    stops[i] = e;
    onChange({ ...value, stops });
  };
  const swap = () => onChange({ ...value, stops: [...value.stops].reverse() });
  const best = routes[selected];
  // An agent may ask for a mode the plan lacks; show its tab so the state is honest.
  const tabs = profiles.includes(value.profile) ? profiles : [...profiles, value.profile];
  const last = value.stops.length - 1;

  const at = value.time.kind === "now" ? null : value.time.at;
  const setTime = (kind: RouteTime["kind"]) =>
    onChange({ ...value, time: kind === "now" ? { kind } : { kind, at: at ?? toOffsetIso(nextQuarterHourLocal()) } });
  const toggleAvoid = (a: MapAvoid, on: boolean) =>
    onChange({ ...value, avoid: on ? [...value.avoid, a] : value.avoid.filter((x) => x !== a) });

  return (
    <section
      data-testid="directions-panel"
      aria-label="Chỉ đường"
      className="friday-map-panel absolute bottom-24 left-4 z-10 flex max-h-[calc(100dvh-12rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col p-4 md:bottom-auto md:top-32"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-cyan-50">Chỉ đường</h2>
        <button type="button" aria-label="Đóng chỉ đường" className="text-slate-400 hover:text-cyan-100" onClick={onClose}>
          ✕
        </button>
      </div>

      <div role="tablist" aria-label="Phương tiện" className="mb-3 flex gap-1">
        {tabs.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={value.profile === p}
            className={`flex-1 rounded-full px-2 py-1 text-xs ${value.profile === p ? "bg-cyan-400 text-slate-950" : "hover:bg-cyan-400/10"}`}
            onClick={() => onChange({ ...value, profile: p, avoid: avoidForProfile(value.avoid, value.profile, p) })}
          >
            {PROFILE_LABELS[p]}
          </button>
        ))}
      </div>

      <div className="mb-2 flex items-center gap-2">
        <select
          aria-label="Thời gian"
          value={value.time.kind}
          onChange={(e) => setTime(e.target.value as RouteTime["kind"])}
          className="friday-map-chip !rounded-lg !px-2 !py-1 text-xs"
        >
          <option value="now">Đi ngay</option>
          <option value="depart">Khởi hành lúc</option>
          <option value="arrive">Đến lúc</option>
        </select>
        {at && (
          <input
            type="datetime-local"
            aria-label="Chọn giờ"
            value={at.slice(0, 16)}
            onChange={(e) => e.target.value && onChange({ ...value, time: { kind: value.time.kind as "depart" | "arrive", at: toOffsetIso(e.target.value) } })}
            className="friday-map-chip !rounded-lg !px-2 !py-1 text-xs"
          />
        )}
      </div>

      <details className="mb-2 text-xs">
        <summary className="cursor-pointer text-slate-300">Tùy chọn{value.avoid.length ? ` (${value.avoid.length})` : ""}</summary>
        <div className="mt-1 grid grid-cols-2 gap-1">
          {AVOID_ORDER.map((a) => (
            <label key={a} className="flex items-center gap-1.5">
              <input type="checkbox" checked={value.avoid.includes(a)} onChange={(e) => toggleAvoid(a, e.target.checked)} />
              {AVOID_LABELS[a]}
            </label>
          ))}
        </div>
      </details>

      <div className="flex items-center gap-2">
        <div className="flex flex-1 flex-col gap-2">
          <MapSearch label="Điểm đi" placeholder="Chọn điểm đi" value={value.stops[0]?.label} getNear={getNear} offerMyLocation onPick={(p) => setStop(0, p)} />
          <MapSearch label="Điểm đến" placeholder="Chọn điểm đến" value={value.stops[last]?.label} getNear={getNear} offerMyLocation onPick={(p) => setStop(last, p)} />
        </div>
        <button type="button" aria-label="Đổi điểm đi và điểm đến" className="friday-map-fab !h-9 !w-9" onClick={swap}>
          ⇅
        </button>
      </div>

      {STATUS_TEXT[status] && (
        <p data-testid="directions-status" role="status" className="mt-3 text-sm text-amber-200">
          {STATUS_TEXT[status]}
        </p>
      )}

      {status === "ok" && best && (
        <>
          <div data-testid="directions-summary" className="mt-3 flex items-baseline gap-2">
            <span className="text-xl font-semibold text-cyan-200">{formatDuration(best.duration_s)}</span>
            <span className="text-sm text-slate-300">{formatDistance(best.distance_m)}</span>
            {best.traffic_delay_s >= 60 && (
              <span className="text-sm text-amber-200">chậm {formatDuration(best.traffic_delay_s)} do kẹt xe</span>
            )}
          </div>
          {best.departure_time && best.arrival_time && (
            <div data-testid="directions-times" className="mt-1 text-xs text-slate-300">
              {/* With "Đến lúc" the departure time is the answer (spec 2026-09-23 §5.2). */}
              <span className={value.time.kind === "arrive" ? "font-semibold text-cyan-200" : undefined}>
                Khởi hành {formatClock(best.departure_time)}
              </span>{" "}
              → Đến {formatClock(best.arrival_time)}
            </div>
          )}
          {routes.length > 1 && (
            <div className="mt-2 flex gap-2">
              {routes.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={i === selected}
                  className={`rounded-lg px-2 py-1 text-xs ${i === selected ? "bg-cyan-400/20 text-cyan-100" : "text-slate-400 hover:bg-cyan-400/10"}`}
                  onClick={() => setSelected(i)}
                >
                  {formatDuration(r.duration_s)} · {formatDistance(r.distance_m)}
                </button>
              ))}
            </div>
          )}
          <ol className="mt-3 flex-1 overflow-auto border-t border-cyan-400/15 pt-2">
            {best.maneuvers.map((m, i) => (
              <li
                key={i}
                className="cursor-pointer rounded px-2 py-1.5 text-sm hover:bg-cyan-400/10"
                onMouseEnter={() => setStep(stepCoordinates(best, i))}
                onMouseLeave={() => setStep([])}
                onClick={() => {
                  const at = maneuverCoordinate(best, i);
                  if (at) map.flyTo({ center: at, zoom: Math.max(map.getZoom(), 17) });
                }}
              >
                <div className="text-slate-100">{m.instruction}</div>
                {m.distance_m > 0 && <div className="text-xs text-slate-400">{formatDistance(m.distance_m)}</div>}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
