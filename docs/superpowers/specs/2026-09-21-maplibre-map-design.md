# MapLibre street map (globe → map handoff, search, directions) — design

Status: **approved** · Date: 2026-09-21 · Revised 2026-09-22: routing moved from self-hosted Valhalla to GraphHopper Cloud

## 1. Problem

The globe (`Globe3D`, R3F on WebGPU) stops at `MIN_DIST = 4.4`: it can show
where something is on Earth, never what is around it. There is no street-level
view, no place search and no directions — neither in the UI nor as agent tools.

Goal: zooming the globe past its limit hands off to a full-screen MapLibre map
with a smooth, modern transition; requests about a specific area or a route
open that map directly; the map behaves like Google Maps (search, place card,
context menu, directions with alternatives and draggable endpoints).

## 2. Decisions already made

- **Tiles/geocoding: MapTiler** (API key). **Routing: GraphHopper Cloud**
  (hosted API, key; free plan). **Default travel mode: the first the plan
  allows** — car on the free plan (it has no motorbike); motorbike
  (`motor_scooter`) becomes the default once the plan includes `scooter`.
- **Full-screen map layer** between the R3F canvas and the HUD.
- **Approach A** — DOM layer with MapLibre's own `projection: "globe"` for a
  seamless crossfade. Rejected: MapLibre rendered to a texture inside the 3D
  scene (per-frame copy into WebGPU, hand-forwarded input, no DOM UI), and
  replacing the R3F globe with MapLibre's (loses the hologram look).
- **Dark skin by default** (MapTiler `streets-v2-dark`, cyan `#38e8ff` accent,
  frosted panels); Google Maps layout and interactions. Layer switcher offers
  light / satellite (hybrid) / terrain.
- **Map specs carry route *intent*, not geometry** (§5).
- **Routing is optional**: without `GRAPHHOPPER_API_KEY` everything but
  directions works. Nothing to host, so it deploys on Render as is.

## 3. State and handoff mechanics

### 3.1 Store slice (in `src/lib/store.ts`)

```ts
mapView: {
  mode: "globe" | "entering" | "map" | "leaving";
  center: { lat: number; lon: number };
  zoom: number;                 // MapLibre zoom
  source: "zoom" | "agent" | "user";
  view?: MapView;               // §5 — bbox / route from an agent spec
  points?: GeoPoint[];          // markers carried over from the globe / spec
}
openMap(center, zoom, source, extra?: { view?: MapView; points?: GeoPoint[] })
closeMap()
settleMap()                     // entering → map, leaving → globe
```

The store holds intent only. Camera, easing and per-frame values stay in refs
(§36 convention) — no React state per frame.

### 3.2 Trigger from the globe

- `useGlobeInteraction` gains an **over-zoom accumulator**: once `distTarget`
  is pinned at `MIN_DIST`, further wheel / pinch / `+` input accumulates; past a
  threshold it calls `openMap(..., "zoom")`. A single stray scroll never
  triggers; 600 ms without input decays the accumulator to 0. The accumulator
  is a pure function (unit-testable without R3F).
- **Map center** = the surface point facing the camera, from a new
  `viewCenterFromAngles(yaw, pitch)` in `geo.ts` — the inverse of
  `computeGlobeFocusAngles`. If a globe marker is focused, its lat/lon wins.
- Globe carries its current `points` into `openMap` so markers survive the
  handoff.

### 3.3 Transition timeline (~900 ms, both sides in parallel)

| t | Globe (R3F) | Map layer (DOM) |
|---|---|---|
| 0 | `mode=entering`; camera dollies `MIN_DIST` → ~3.2 (allowed past min only while entering); atmosphere/bloom ramps up | MapLibre mounts at `opacity:0`, `projection:"globe"`, zoom ~2.2, same center |
| ~250 ms | dolly continues | after style `load`: opacity 0→1, blur 12→0 px, scale 1.04→1 |
| ~500 ms | 3D markers/labels fade | `flyTo` zoom ~5 (or the spec's view) |
| ~900 ms | `mode=map`; canvas `frameloop="demand"` | map owns all input |

- Zoom 2.2 vs distance 3.2 is chosen so both spheres have the same on-screen
  diameter during the crossfade; tuned visually and kept as named constants
  with a comment.
- Style/tiles slower than ~1.5 s: globe holds its bright state with a thin
  "loading map" indicator — never a black frame. Load failure (bad key,
  offline): back to `globe` with an error toast.
- Reduced motion: no dolly, a 150 ms fade only.

### 3.4 Leaving the map

Zoom below ~1.8, the "← Địa cầu" button, or `Esc` (only when no search box or
panel has focus): `mode=leaving`, map fades/blurs out in reverse, globe turns
to the map's current center and the camera eases back to `HOME_DIST`; then
MapLibre is removed (`map.remove()`) to free its WebGL context.

### 3.5 Agent-opened map

`openMap(..., "agent")` skips the globe dolly. With a globe on screen the
crossfade still runs; without one the map simply fades in.

### 3.6 Keyboard ownership

While `mode !== "globe"` the globe's key handler (arrows, `R`, `F`, Space,
`+/-`) is disabled so it never fights MapLibre's keyboard handling.

## 4. Map UI

### 4.1 Layout (desktop; left panels become a bottom sheet on mobile)

```
┌──────────────────────────────────────────────────────────────┐
│ [← Địa cầu] [🔍 Tìm kiếm địa điểm…        ] [↱]   TopHud  ToolHud │
│ ┌───────────────┐                                            │
│ │ Place card /  │                                   [🧭]     │
│ │ Directions    │              MAP                  [◎]      │
│ │ panel (380px) │                                   [+]      │
│ └───────────────┘                                   [−]      │
│ [▦ Lớp]   ─── 1 km                 [ InputBar FRIDAY ]        │
└──────────────────────────────────────────────────────────────┘
```

In map mode the decorative HUD layers (scanlines, vignette, EdgeTelemetry,
VizRail, StateRail) are hidden; TopHud, ToolHud, InputBar and ConfirmPrompt
stay, so the operator can keep talking to FRIDAY over the map. Labels prefer
`name:vi`, then `name`.

### 4.2 Interactions

| Area | Behaviour |
|---|---|
| Controls | MapLibre's built-in Navigation / Scale / Attribution controls, restyled in CSS. Right-drag or Ctrl+drag rotates/tilts. 3D buildings toggle (MapTiler extrusions). |
| My location | ◎ uses the **existing opt-in geolocation flow** (`store.location`), no separate GeolocateControl. Blue dot + halo sized by `accuracy`. |
| Search | MapTiler Geocoding autocomplete, 250 ms debounce, proximity-biased to the map center. ARIA combobox, ↑↓ / Enter / Esc. Picking a result flies there and opens the place card. |
| Place card | From a POI click or a search pick: name, category, address (reverse geocode), coordinates; buttons **Chỉ đường**, **Từ đây**, **Sao chép tọa độ**. |
| Context menu | Right-click: "Chỉ đường từ đây", "Chỉ đường đến đây", "Đây là đâu?", "Sao chép tọa độ". |
| Directions | From/To inputs (autocomplete, "Vị trí của tôi"), ⇅ swap, mode tabs for the modes the plan allows (`GET /geo/profiles`, default first): 🚗 Ô tô · 🚲 Xe đạp · 🚶 Đi bộ on the free plan, plus 🛵 Xe máy (then default) with `scooter`. Primary route + up to 2 grey alternatives, click to select. Distance/time summary; step list — hover highlights the segment, click flies to the maneuver. **A/B markers are draggable**; drop reroutes. |
| Globe data | The globe viz's `points` / `routes` render on the map with the same status colors. |

### 4.3 Files (`src/components/friday/map/`)

- `MapLayer.tsx` — mount/unmount, transition, data layers, watches
  `visualizations` for map specs (§5).
- `MapSearch.tsx` — autocomplete box, reused for the From/To inputs.
- `PlacePanel.tsx` — place card + context menu.
- `DirectionsPanel.tsx` — directions panel, route layers, step list.
- `mapApi.ts` — style URLs, MapTiler geocoding client, `/geo/route` and
  `/geo/profiles` clients, step-geometry helpers, formatting.
- `map.css` — control and panel styling.

### 4.4 Infrastructure

- New dependency: `maplibre-gl` only (no React wrapper), loaded lazily via
  `next/dynamic` so the main bundle does not grow.
- `NEXT_PUBLIC_MAPTILER_KEY` in `.env.example`; the key is client-visible by
  design and must be origin-restricted in the MapTiler dashboard.
- CSP (`src/proxy.ts`): `connect-src` already allows `https:`; add
  `img-src https://api.maptiler.com` and `worker-src blob:` (MapLibre's
  worker). Missing either produces a blank map with no obvious error.

## 5. Contract: `map` visualization type

Updated in all three places — `src/lib/visualization/types.ts`,
`backend/friday/schemas/visualization.py`,
`contracts/visualization/visualization.v1.json` — with the parity tests.

```ts
type VisualizationType = ... | "map";

interface VizData {
  ...
  points?: GeoPoint[];     // reused: map markers
  map?: MapView;           // new
}

interface MapView {
  center?: { lat: number; lon: number };
  zoom?: number;                        // 0–20; default 14 when center given
  bbox?: [number, number, number, number]; // [west, south, east, north]; wins over center/zoom (fitBounds)
  route?: {
    profile: "auto" | "motor_scooter" | "bicycle" | "pedestrian";
    waypoints: { lat: number; lon: number; label?: string }[]; // 2–5
  };
}
```

**Route intent, not geometry.** The spec carries `profile` + `waypoints`;
`DirectionsPanel` fetches the geometry from `/geo/route` — the same call it
makes for user-driven directions, drags and mode switches. One route-drawing
path; no multi-KB polylines in the event stream or memory. The agent tool
computes its own distance/time for the spoken answer; the router answers the
same question the same way, so the drawn route matches.

**Rendering flow**

- `REGISTRY.map` is an empty renderer (`() => null`) — nothing in the 3D scene.
- `resolveVisualizationLayout` skips `map` specs when counting slots.
- `MapLayer` watches `visualizations`; a new `map` entry (by `id`) calls
  `openMap(..., "agent")`: not open → enter transition; already open →
  `flyTo` / `fitBounds`, and opens `DirectionsPanel` when `route` is present.
- A new **non-map** visualization while the map is open closes the map, so the
  operator sees the chart they asked for. No new visualization → the map stays
  until the user closes it.
- Globe → map by zooming is UI state only; it creates no spec.

**Planner** (`backend/friday/planner/prompts.py`, `src/lib/vizPlanner.ts`):
`map` — a specific area, address, street or route (city scale and below);
`globe` — country or world scale. `get_client_location`'s preview stays
`globe`.

## 6. Backend

### 6.1 Routing provider — GraphHopper Cloud

Hosted Routing API (`https://graphhopper.com/api/1/route`), keyed; nothing to
run or host. Decided 2026-09-22 over self-hosted Valhalla (needs its own
server; Render's free plan cannot host it) and public OSRM (no Vietnamese
instruction text, no SLA).

- `GRAPHHOPPER_API_KEY` (backend only — the browser never sees it). Unset →
  everything but directions works.
- **Free plan: 500 credits/day, car/bike/foot only, non-commercial use.**
  Alternative routes cost extra credits; the backend cache (§6.3) exists
  largely to protect this budget.
- `GRAPHHOPPER_PROFILES` (default `car,bike,foot`) lists what the key's plan
  allows. Adding `scooter` (paid plan) turns the motorbike mode on everywhere
  with no code change.
- Turn instructions in Vietnamese via `locale=vi` (GraphHopper ships `vi` /
  `vi_VN` translations), so no frontend translation table.

### 6.2 Client — `backend/friday/geo/graphhopper.py`

`urllib` + `asyncio.to_thread`, the `fetch.py` pattern (no `httpx`).

- Contract profile → GraphHopper profile: `auto → car`, `motor_scooter →
  scooter`, `bicycle → bike`, `pedestrian → foot`.
- **Default profile** = the first the plan allows in the order
  `motor_scooter, auto, bicycle, pedestrian` → `auto` on the free plan.
- Request: one `point=lat,lon` per waypoint, `profile`, `locale=vi`,
  `instructions=true`, `points_encoded=false`; with exactly two points also
  `algorithm=alternative_route&alternative_route.max_paths=3`.

```python
async def route(waypoints, profile=None, locale="vi") -> dict
# → {"routes": [{"distance_m", "duration_s",
#                "coordinates": [[lon, lat], ...],
#                "maneuvers": [{"instruction", "sign", "distance_m",
#                               "duration_s", "begin_shape_index"}]}]}
```

`points_encoded=false` returns plain `[lon, lat]` pairs, so the frontend needs
no polyline decoder; `begin_shape_index` is GraphHopper's `interval[0]`.

### 6.3 Proxy — `POST /geo/route`, `GET /geo/profiles`

- Both behind `require_known_origin`, like the other routes.
- `/geo/route` validation → 422: 2–5 waypoints, lat ∈ [-90, 90],
  lon ∈ [-180, 180], `profile` in the enum (omitted = plan default).
- 10 s timeout; LRU cache (256 entries) keyed on inputs rounded to 5 decimals,
  so drags and mode toggles do not spend credits twice.
- Errors: no key, 401, 429 (credits used up), 5xx or unreachable →
  `503 {"error": "routing_unavailable"}` (UI: "Chỉ đường chưa được cấu hình");
  GraphHopper 400 (no connection / point not near a road) →
  `422 {"error": "no_route"}` (UI: "Không tìm thấy đường đi"); a mode the plan
  lacks → `422 {"error": "unsupported_profile"}`, refused before any credit is
  spent (UI: "Gói chỉ đường hiện tại không hỗ trợ phương tiện này").
- `/geo/profiles` → `{"profiles": [...]}` (contract names, default first). The
  directions panel shows only these tabs.

### 6.4 Agent tools (capability `geo.read`, `risk="low"` — read-only)

| Tool | Input | Model output | Preview spec |
|---|---|---|---|
| `find_place` | `query`, `near?` (`"my_location"` or a place name) | ≤5 `{label, category, address, lat, lon}` | `map` with `points` + `bbox` over results |
| `get_directions` | `from`, `to` (place name or `"my_location"`), `profile` (default = plan default, `auto` on free), `via?` (≤3) | `{from, to, distance_km, duration_min, steps: first 8}` | `map` with `route: {profile, waypoints}` + A/B `points` |

- Server-side geocoding uses MapTiler with a separate `MAPTILER_SERVER_KEY`
  (the frontend key is origin-locked).
- `"my_location"` reads `CLIENT`; unshared location → the same error dict as
  `get_client_location`.
- A mode the plan lacks (e.g. motorbike on the free plan) → error dict saying
  so, before any geocoding.
- No `show_map` tool: "show me Hoàn Kiếm" is `find_place`, whose preview opens
  the map.
- Without `GRAPHHOPPER_API_KEY`, `get_directions` returns an error dict saying
  routing is not configured.
- A `map` preview is the final visualization: the orchestrator passes it
  through instead of re-planning, so the model never rewrites waypoints.

### 6.5 Privacy

- Operator coordinates sent to MapTiler (external) for proximity bias are
  rounded to 2 decimals (~1 km).
- Routing needs the real stops, so full-precision coordinates go to
  GraphHopper (external) — only for a route the operator asked for, and a
  `"my_location"` stop only when they already shared their location.
- The existing memory coordinate guard (`shared_coordinates`) still covers the
  new tools' outputs.

## 7. Testing

No test touches the real network.

**Frontend unit (`tests/unit/`)**

- `globeGeo.spec.ts` (extend): `viewCenterFromAngles` round-trips with
  `computeGlobeFocusAngles`, including tilt-clamped high latitudes.
- `mapView.spec.ts` (new): `globe → entering → map → leaving → globe`;
  `openMap` while `map` updates the view without re-entering; non-map viz
  closes, map viz opens.
- `overZoom.spec.ts` (new): single scroll does not trigger; sustained scroll
  does; 600 ms idle decays.
- `mapApi.spec.ts` (new): step geometry from `begin_shape_index`; MapTiler
  geocoding response parsing; Vietnamese distance/duration formatting.
- `contracts.spec.ts` (extend): `map` / `MapView` parity; minimal `{type:"map"}`
  valid.
- Layout: `map` specs take no slot in `resolveVisualizationLayout`.

**Frontend UI (`tests/ui/map.spec.ts`, new)**

`page.route` intercepts `api.maptiler.com` and serves a minimal style JSON
(background + one GeoJSON layer, no tiles), so real MapLibre runs offline in
Chromium; `/geo/route` and `/geo/profiles` are stubbed with `page.route`.

1. Globe zoomed to `MIN_DIST` + more scroll → map layer visible, `mode=map`;
   `Esc` → back to globe.
2. Agent `map` spec with `route` → map opens, directions panel shows the stubbed
   distance/time, route layer exists; free-plan profiles → car selected, no
   motorbike tab; switching mode re-asks with the new profile.
3. Search: autocomplete appears, ↑↓/Enter selects, place card opens.
4. `/geo/route` 503 → "Chỉ đường chưa được cấu hình", map still usable.
5. `prefers-reduced-motion` → short fade (timed via `mode` changes).

DOM/state assertions only — no map screenshots (fonts/tiles make them flaky).

**Backend (`backend/tests/`)**

- `unit/test_graphhopper.py`: against a local fake of the GraphHopper API
  (the `fetch` test pattern): request shape (points, profile mapping,
  `locale=vi`, alternatives only for two points), normalization, plan profiles
  and default, unsupported profile refused without a call, error mapping
  (400 → no route; 401/429/5xx/unreachable/no key → unavailable), cache hits.
- `integration/test_geo_route.py`: `/geo/route` 422 validation, error mapping,
  `/geo/profiles`, origin guard.
- `unit/test_geo_tools.py`: `find_place` / `get_directions` with fake geocoder
  and router; unshared `"my_location"` errors; default profile = plan default
  (`auto` on free); motorbike on the free plan refused; MapTiler proximity
  rounded to 2 decimals; preview specs validate as `VisualizationPlan`.
- `integration/test_map_preview_pin.py`: a `map` preview is streamed as the
  final spec without calling the planner.
- `test_contracts`: Python schema ↔ JSON contract parity.

**Manual checks at implementation (browser preview):** sphere-size match during
the crossfade; repeated enter/leave frees the WebGL context (no leak).

**Done when** `npm run verify` is green; the map UI tests need neither
GraphHopper nor a real MapTiler key.

## 8. Out of scope

- A paid GraphHopper plan (motorbike); it is a config change when wanted.
- Self-hosted routing.
- Traffic, transit, offline tiles, saved places, Street View.
