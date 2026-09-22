"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Map as MlMap, Marker, NavigationControl, ScaleControl, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { useFridayStore } from "@/lib/store";
import { shareLocation } from "@/lib/geolocation";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { ARRIVAL_ZOOM, HANDOFF_ZOOM, LEAVE_ZOOM } from "@/lib/mapView";
import type { MapProfile } from "@/lib/visualization/types";
import { STATUS_COLORS, markerLabel, statusOf } from "../visualization/globe/geo";
import { devRailsEnabled } from "../hud/devRails";
import { DEFAULT_PROFILES, fetchProfiles, styleUrl, withTomTomKey, type Endpoint, type MapStyleId, type Place } from "./mapApi";
import { MapSearch } from "./MapSearch";
import { DirectionsPanel } from "./DirectionsPanel";
import { ContextMenu, PlacePanel, myLocationEndpoint, type MenuState } from "./PlacePanel";

const ENTER_MS = 900;
const LEAVE_MS = 500;
const REDUCED_MS = 150;
/** Past this the globe holds and a "loading" chip shows (spec §3.3). */
const SLOW_MS = 1500;
/** A failed style load shows its message this long, then hands back. */
const FAIL_MS = 2500;

export interface DirectionsValue {
  profile: MapProfile;
  /** First is "from", last is "to"; null = not chosen yet. */
  stops: (Endpoint | null)[];
}

const STYLE_OPTIONS: { id: MapStyleId; label: string }[] = [
  { id: "dark", label: "Tối" },
  { id: "light", label: "Sáng" },
  { id: "satellite", label: "Vệ tinh" },
];

/** Toggle the style's own 3D building layers (the switch only shows when it has some). */
function setBuildings3d(map: MlMap, on: boolean) {
  for (const layer of map.getStyle().layers) {
    if (layer.type === "fill-extrusion") map.setLayoutProperty(layer.id, "visibility", on ? "visible" : "none");
  }
  map.easeTo({ pitch: on ? 55 : 0, duration: 600 });
}

export default function MapStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [failed, setFailed] = useState(false);
  const [styleId, setStyleId] = useState<MapStyleId>("dark");
  const [layersOpen, setLayersOpen] = useState(false);
  const [buildings, setBuildings] = useState(false);
  const [traffic, setTraffic] = useState(false);
  const [has3d, setHas3d] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const [directions, setDirections] = useState<DirectionsValue | null>(null);
  // Modes the routing plan allows, default first (all four on TomTom).
  const [profiles, setProfiles] = useState<MapProfile[]>(DEFAULT_PROFILES);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const mode = useFridayStore((s) => s.mapView.mode);
  const rev = useFridayStore((s) => s.mapView.rev);
  const points = useFridayStore((s) => s.mapView.points);
  const location = useFridayStore((s) => s.location);
  const reduced = useReducedMotion();
  const wantLocate = useRef(false);

  // One MapLibre instance per open; removed on close to free its WebGL context.
  useEffect(() => {
    const { center } = useFridayStore.getState().mapView;
    const m = new MlMap({
      container: containerRef.current!,
      style: styleUrl("dark"),
      center: [center.lon, center.lat],
      zoom: HANDOFF_ZOOM,
      attributionControl: { compact: true },
      transformRequest: (url) => ({ url: withTomTomKey(url) }),
    });
    m.addControl(new NavigationControl({ visualizePitch: true }), "bottom-right");
    m.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    let loaded = false;
    const slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    m.on("style.load", () => {
      m.setProjection({ type: "globe" });
      setHas3d(m.getStyle().layers.some((l) => l.type === "fill-extrusion"));
    });
    m.once("load", () => {
      loaded = true;
      clearTimeout(slowTimer);
      setSlow(false);
      setReady(true);
    });
    // After load, tile hiccups are MapLibre's to retry; before it, the map is unusable.
    m.on("error", () => {
      if (!loaded) setFailed(true);
    });
    setMap(m);
    if (devRailsEnabled()) (window as unknown as { __fridayMap?: MlMap }).__fridayMap = m;
    return () => {
      clearTimeout(slowTimer);
      m.remove();
    };
  }, []);

  const leave = useCallback(() => {
    const c = map?.getCenter();
    useFridayStore.getState().closeMap(c ? { lat: c.lat, lon: c.lng } : undefined);
  }, [map]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchProfiles(ctrl.signal).then(setProfiles).catch(() => {});
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => useFridayStore.getState().closeMap(), FAIL_MS);
    return () => clearTimeout(t);
  }, [failed]);

  // Settle the transition once it has played (spec §3.3/§3.4).
  useEffect(() => {
    const ms = reduced ? REDUCED_MS : mode === "leaving" ? LEAVE_MS : ENTER_MS;
    if (mode === "leaving" || (mode === "entering" && ready)) {
      const t = setTimeout(() => useFridayStore.getState().settleMap(), ms);
      return () => clearTimeout(t);
    }
  }, [mode, ready, reduced]);

  // Apply each accepted open request: camera, or directions when it carries a route.
  useEffect(() => {
    if (!map || !ready) return;
    const { view, center, zoom, source } = useFridayStore.getState().mapView;
    if (view?.route) {
      // Synchronous apply is intentional: the open request and its route state land on the same commit.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlace(null);
      setDirections({
        profile: view.route.profile,
        stops: view.route.waypoints.map((w) => ({
          lat: w.lat,
          lon: w.lon,
          label: w.label ?? `${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`,
        })),
      });
      return; // DirectionsPanel frames the route once it arrives
    }
    const duration = reduced ? 0 : 2200;
    if (view?.bbox) {
      map.fitBounds(
        [
          [view.bbox[0], view.bbox[1]],
          [view.bbox[2], view.bbox[3]],
        ],
        { padding: 80, duration, maxZoom: 16 },
      );
    } else {
      map.flyTo({ center: [center.lon, center.lat], zoom: source === "zoom" ? ARRIVAL_ZOOM : zoom, duration });
    }
  }, [map, ready, rev, reduced]);

  // Zooming out past the limit hands back to the globe (spec §3.4).
  useEffect(() => {
    if (!map) return;
    const onZoomEnd = () => {
      if (map.getZoom() < LEAVE_ZOOM && useFridayStore.getState().mapView.mode === "map") leave();
    };
    map.on("zoomend", onZoomEnd);
    return () => {
      map.off("zoomend", onZoomEnd);
    };
  }, [map, leave]);

  // Esc closes the innermost thing first: panel, then the map itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (menu) setMenu(null);
      else if (directions) setDirections(null);
      else if (place) setPlace(null);
      else leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, directions, place, leave]);

  // Markers carried over from the globe / spec. Hidden while directions draw their own A/B.
  useEffect(() => {
    if (!map || directions) return;
    const markers = (points ?? []).map((p, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "friday-map-pin";
      el.style.setProperty("--pin", p.color ?? STATUS_COLORS[statusOf(p)]);
      el.setAttribute("aria-label", markerLabel(p, i));
      el.title = markerLabel(p, i);
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setPlace({ label: p.label ?? markerLabel(p, i), address: "", lat: p.lat, lon: p.lon });
      });
      return new Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
    });
    return () => markers.forEach((m) => m.remove());
  }, [map, points, directions]);

  // POI click → place card; right click → context menu; empty click closes both.
  useEffect(() => {
    if (!map) return;
    const onClick = (e: MapMouseEvent) => {
      setMenu(null);
      const hit = map
        .queryRenderedFeatures(e.point)
        .find((f) => f.layer.type === "symbol" && typeof f.properties?.name === "string");
      if (!hit) return;
      const props = hit.properties as Record<string, unknown>;
      const at = hit.geometry.type === "Point" ? (hit.geometry.coordinates as [number, number]) : [e.lngLat.lng, e.lngLat.lat];
      setPlace({
        label: String(props["name:vi"] ?? props.name),
        address: "",
        category: typeof props.class === "string" ? props.class : undefined,
        lat: at[1],
        lon: at[0],
      });
    };
    const onContext = (e: MapMouseEvent) => setMenu({ x: e.point.x, y: e.point.y, lat: e.lngLat.lat, lon: e.lngLat.lng });
    const onMove = (e: MapMouseEvent) => {
      const over = map.queryRenderedFeatures(e.point).some((f) => f.layer.type === "symbol" && f.properties?.name);
      map.getCanvas().style.cursor = over ? "pointer" : "";
    };
    map.on("click", onClick);
    map.on("contextmenu", onContext);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onClick);
      map.off("contextmenu", onContext);
      map.off("mousemove", onMove);
    };
  }, [map]);

  const getNear = useCallback(() => {
    const c = map?.getCenter();
    return c ? { lat: c.lat, lon: c.lng } : null;
  }, [map]);
  const directionsTo = (to: Endpoint) => {
    setPlace(null);
    setDirections((d) => ({ profile: d?.profile ?? profiles[0], stops: [d?.stops[0] ?? myLocationEndpoint(), to] }));
  };
  const directionsFrom = (from: Endpoint) => {
    setPlace(null);
    setDirections((d) => ({ profile: d?.profile ?? profiles[0], stops: [from, d?.stops.at(-1) ?? null] }));
  };

  // My location: blue dot, halo sized to the browser's accuracy radius.
  useEffect(() => {
    if (!map || !location) return;
    const el = document.createElement("div");
    el.className = "friday-map-me";
    el.setAttribute("aria-label", "Vị trí của bạn");
    const marker = new Marker({ element: el }).setLngLat([location.lon, location.lat]).addTo(map);
    const sizeHalo = () => {
      // MapLibre's world is 512 px wide at zoom 0.
      const metersPerPx = (78271.517 * Math.cos((location.lat * Math.PI) / 180)) / 2 ** map.getZoom();
      const px = (2 * (location.accuracy ?? 0)) / metersPerPx;
      el.style.setProperty("--halo", `${Math.min(400, Math.max(18, px))}px`);
    };
    sizeHalo();
    map.on("zoom", sizeHalo);
    if (wantLocate.current) {
      wantLocate.current = false;
      map.flyTo({ center: [location.lon, location.lat], zoom: Math.max(map.getZoom(), 15) });
    }
    return () => {
      map.off("zoom", sizeHalo);
      marker.remove();
    };
  }, [map, location]);

  const locate = () => {
    const loc = useFridayStore.getState().location;
    if (loc && map) map.flyTo({ center: [loc.lon, loc.lat], zoom: Math.max(map.getZoom(), 15) });
    else {
      wantLocate.current = true;
      shareLocation();
    }
  };

  const chooseStyle = (id: MapStyleId) => {
    setStyleId(id);
    setLayersOpen(false);
    setBuildings(false);
    map?.setStyle(styleUrl(id, traffic));
  };

  const toggleTraffic = (on: boolean) => {
    setTraffic(on);
    setBuildings(false);
    map?.setStyle(styleUrl(styleId, on));
  };

  const visible = ready && (mode === "entering" || mode === "map");
  const duration = reduced ? REDUCED_MS : mode === "leaving" ? LEAVE_MS : ENTER_MS;

  // Right-clicks on markers never reach the canvas, so the layer catches them
  // too (anything outside the map container, e.g. the search box, is ignored).
  const onLayerContextMenu = (e: React.MouseEvent) => {
    if (!map || !containerRef.current?.contains(e.target as Node)) return;
    e.preventDefault();
    const r = containerRef.current.getBoundingClientRect();
    let lat: number;
    let lon: number;
    try {
      const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
      lat = ll.lat;
      lon = ll.lng;
    } catch {
      lat = map.getCenter().lat; // transform not ready; the click is near the middle anyway
      lon = map.getCenter().lng;
    }
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, lat, lon });
  };

  return (
    <div
      data-testid="map-layer"
      data-mode={mode}
      className="friday-map absolute inset-0"
      onContextMenu={onLayerContextMenu}
      style={{
        opacity: visible ? 1 : 0,
        filter: visible || reduced ? "none" : "blur(12px)",
        transform: visible || reduced ? "none" : "scale(1.04)",
        transitionDuration: `${duration}ms`,
        pointerEvents: mode === "leaving" ? "none" : "auto",
      }}
    >
      <div ref={containerRef} className="absolute inset-0" style={{ position: "absolute", inset: 0 }} />

      <div className="absolute left-4 top-16 z-10 flex items-start gap-2">
        <button type="button" className="friday-map-chip" aria-label="Quay lại địa cầu" onClick={leave}>
          ← Địa cầu
        </button>
        <MapSearch
          label="Tìm kiếm địa điểm"
          placeholder="Tìm kiếm địa điểm…"
          getNear={getNear}
          onPick={(p) => {
            setMenu(null);
            setPlace(p);
            map?.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 16) });
          }}
        />
        <button
          type="button"
          className="friday-map-fab"
          aria-label="Chỉ đường"
          onClick={() => {
            const to = place ? { lat: place.lat, lon: place.lon, label: place.label } : null;
            setPlace(null);
            setDirections({ profile: profiles[0], stops: [myLocationEndpoint(), to] });
          }}
        >
          ↱
        </button>
      </div>

      {place && !directions && (
        <PlacePanel place={place} onClose={() => setPlace(null)} onDirectionsTo={directionsTo} onDirectionsFrom={directionsFrom} />
      )}
      {map && directions && (
        <DirectionsPanel map={map} value={directions} profiles={profiles} onChange={setDirections} onClose={() => setDirections(null)} getNear={getNear} />
      )}
      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onFrom={directionsFrom}
          onTo={directionsTo}
          onWhatsHere={(lat, lon) => setPlace({ label: "Vị trí đã ghim", address: "", lat, lon })}
        />
      )}

      <button type="button" className="friday-map-fab absolute bottom-40 right-3 z-10" aria-label="Vị trí của tôi" onClick={locate}>
        ◎
      </button>

      <div className="absolute bottom-10 left-3 z-10">
        <button type="button" className="friday-map-chip" aria-expanded={layersOpen} onClick={() => setLayersOpen((v) => !v)}>
          ▦ Lớp
        </button>
        {layersOpen && (
          <div className="friday-map-panel absolute bottom-10 left-0 w-44 p-2" role="menu">
            {STYLE_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={styleId === o.id}
                className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-cyan-400/10"
                onClick={() => chooseStyle(o.id)}
              >
                {styleId === o.id ? "● " : "○ "}
                {o.label}
              </button>
            ))}
            <label className="mt-1 flex items-center gap-2 px-2 py-1 text-sm">
              <input type="checkbox" checked={traffic} onChange={(e) => toggleTraffic(e.target.checked)} />
              Giao thông
            </label>
            {has3d && (
              <label className="mt-1 flex items-center gap-2 px-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={buildings}
                  onChange={(e) => {
                    setBuildings(e.target.checked);
                    if (map) setBuildings3d(map, e.target.checked);
                  }}
                />
                Tòa nhà 3D
              </label>
            )}
          </div>
        )}
      </div>

      {(slow || failed) && (
        <div role="status" className="friday-map-chip pointer-events-none absolute left-1/2 top-24 -translate-x-1/2">
          {failed ? "Không tải được bản đồ" : "Đang tải bản đồ…"}
        </div>
      )}
    </div>
  );
}
