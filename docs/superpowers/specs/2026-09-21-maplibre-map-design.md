# MapLibre street map (globe → map handoff, search, directions) — design

Status: **approved** · Date: 2026-09-21 · Revised 2026-09-22: Valhalla → GraphHopper Cloud → **TomTom for tiles, search and routing** (current)

## 1. Problem

The globe (`Globe3D`, R3F on WebGPU) stops at `MIN_DIST = 4.4`: it can show
where something is on Earth, never what is around it. There is no street-level
view, no place search and no directions — neither in the UI nor as agent tools.

Goal: zooming the globe past its limit hands off to a full-screen MapLibre map
with a smooth, modern transition; requests about a specific area or a route
open that map directly; the map behaves like Google Maps (search, place card,
context menu, directions with alternatives and draggable endpoints).

## 2. Decisions already made

- **TomTom for everything**: Map Display (tiles/styles), Search/Places
  (autocomplete, place details, reverse geocoding) and Routing. Chosen over
  MapTiler + GraphHopper for one vendor, **motorbike routing on the free
  plan** and real-time traffic; accepted costs: TomTom has no Vietnamese
  turn instructions (built by us, §6.2) and a tight search budget (§6.1).
  **Default travel mode: motorbike** (`motor_scooter`).
- **Full-screen map layer** between the R3F canvas and the HUD.
- **Approach A** — DOM layer with MapLibre's own `projection: "globe"` for a
  seamless crossfade. Rejected: MapLibre rendered to a texture inside the 3D
  scene (per-frame copy into WebGPU, hand-forwarded input, no DOM UI), and
  replacing the R3F globe with MapLibre's (loses the hologram look).
- **Dark skin by default** (TomTom `2/basic_street-dark`, cyan `#38e8ff`
  accent, frosted panels); Google Maps layout and interactions. Layer switcher
  offers dark / light / satellite, plus a **traffic** overlay toggle.
- **Map specs carry route *intent*, not geometry** (§5).
- **Search and routing are optional**: without `TOMTOM_API_KEY` the map
  still shows; search and directions say they are unconfigured. Nothing to
  host, so it deploys on Render as is.

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
stay, so the operator can keep talking to FRIDAY over the map. Labels are
TomTom's local names — Vietnamese inside Vietnam — with no rewriting.

### 4.2 Interactions

| Area | Behaviour |
|---|---|
| Controls | MapLibre's built-in Navigation / Scale / Attribution controls, restyled in CSS. Right-drag or Ctrl+drag rotates/tilts. 3D buildings toggle, shown only when the current style has extrusion layers. Traffic toggle overlays TomTom traffic flow. |
| My location | ◎ uses the **existing opt-in geolocation flow** (`store.location`), no separate GeolocateControl. Blue dot + halo sized by `accuracy`. |
| Search | TomTom Places Suggest through `GET /geo/suggest` (≥3 chars, 400 ms debounce, proximity-biased to the map center); picking a suggestion resolves its position through `GET /geo/place`. ARIA combobox, ↑↓ / Enter / Esc. Picking flies there and opens the place card. Quota exhausted → "Tìm kiếm tạm hết hạn mức". |
| Place card | From a POI click or a search pick: name, category, address (reverse geocode via `GET /geo/reverse`), coordinates; buttons **Chỉ đường**, **Từ đây**, **Sao chép tọa độ**. |
| Context menu | Right-click: "Chỉ đường từ đây", "Chỉ đường đến đây", "Đây là đâu?", "Sao chép tọa độ". |
| Directions | From/To inputs (autocomplete, "Vị trí của tôi"), ⇅ swap, mode tabs from `GET /geo/profiles` (default first): 🛵 Xe máy · 🚗 Ô tô · 🚲 Xe đạp · 🚶 Đi bộ — all on TomTom's free plan. Summary shows the traffic delay when there is one ("chậm 6 phút do kẹt xe"). Primary route + up to 2 grey alternatives, click to select. Distance/time summary; step list — hover highlights the segment, click flies to the maneuver. **A/B markers are draggable**; drop reroutes. |
| Globe data | The globe viz's `points` / `routes` render on the map with the same status colors. |

### 4.3 Files (`src/components/friday/map/`)

- `MapLayer.tsx` — mount/unmount, transition, data layers, watches
  `visualizations` for map specs (§5).
- `MapSearch.tsx` — autocomplete box, reused for the From/To inputs.
- `PlacePanel.tsx` — place card + context menu.
- `DirectionsPanel.tsx` — directions panel, route layers, step list.
- `mapApi.ts` — TomTom style URLs + key injection, clients for the
  orchestrator's `/geo/*` endpoints, step-geometry helpers, formatting.
- `map.css` — control and panel styling.

### 4.4 Infrastructure

- New dependency: `maplibre-gl` only (no React wrapper), loaded lazily via
  `next/dynamic` so the main bundle does not grow.
- `NEXT_PUBLIC_TOMTOM_MAP_KEY` in `.env.example`; client-visible by design,
  enabled for Map Display only in the TomTom dashboard.
- CSP (`src/proxy.ts`): `connect-src` already allows `https:`; add
  `img-src https://api.tomtom.com` and `worker-src blob:` (MapLibre's
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

### 6.1 Provider — TomTom for everything

One vendor for tiles, search and routing (decided 2026-09-22, replacing
MapTiler + GraphHopper). Two keys, each enabled only for the products it
needs in the TomTom dashboard:

- `NEXT_PUBLIC_TOMTOM_MAP_KEY` — browser; **Map Display only**. Client-visible
  by necessity (the browser fetches tiles and styles itself).
- `TOMTOM_API_KEY` — backend; Search, Places, Reverse Geocoding, Routing.
  Never reaches the browser. Unset → the map still shows, search and
  directions say they are unconfigured.

Free allowances are **per API, per month** (TomTom pricing, 2026-09-22):

| API | Free / month | Used for |
|---|---|---|
| Map Display vector tiles | 200K | the map |
| Traffic Flow vector tiles | 200K | the traffic layer |
| Routing | 20K | `/geo/route`, `get_directions` |
| Reverse Geocoding | 20K | place card, "Đây là đâu?" |
| Places Search Suggest | 10K | autocomplete as you type |
| Places Search Details | 5K | resolving the picked suggestion to a position |
| Search (fuzzy) | 2.5K | agent `find_place` and stop resolution in `get_directions` |

The fuzzy-search budget (~80/day) is the tight one; everything that can use
a cheaper API does, and every call is cached (§6.3).

### 6.2 Client — `backend/friday/geo/tomtom.py`

`urllib` + `asyncio.to_thread`, the `fetch.py` pattern (no `httpx`). One
module, one error vocabulary:

- `TomTomUnavailable` — no key, 403, 5xx, unreachable.
- `QuotaExceeded` — 429 (the month's free allowance is used up).
- `NoRoute` — Routing 400 ("points … are not connected by the road network").
- `UnsupportedProfile` — a travel mode outside the contract enum.

Functions:

- `suggest(query, near)` → Places Suggest (`POST /maps/orbis/places/suggest`,
  headers `TomTom-Api-Key`, `TomTom-Api-Version: 3`) → `[{ref, title,
  subtitle, type}]`, where `ref` = the result's `more.pathParameters` joined
  with `/` (e.g. `pois/<id>`); `discoverAction` results are dropped.
- `place(ref)` → Places Details (`GET /maps/orbis/places/details/{ref}`,
  `Attributes: position`) → `{lat, lon}`. `ref` must match
  `^[a-z]+/[A-Za-z0-9_-]+$` (no path injection).
- `reverse(lat, lon)` → Reverse Geocoding
  (`/search/2/reverseGeocode/{lat},{lon}.json?language=vi-VN`) → the first
  `address.freeformAddress` or `None`.
- `search(query, near, limit)` → fuzzy search
  (`/search/2/search/{q}.json?language=vi-VN&limit=…`) → `[{label, address,
  category, lat, lon}]` — agent tools only.
- `route(waypoints, profile)` → Calculate Route
  (`/routing/1/calculateRoute/{lat,lon:lat,lon…}/json`) with
  `travelMode` = `auto→car`, `motor_scooter→motorcycle`, `bicycle→bicycle`,
  `pedestrian→pedestrian`; `instructionsType=coded`, `traffic=true`,
  `maxAlternatives=2` (two stops only). **All four modes are on the free
  plan**, so the default is `motor_scooter` again and `available_profiles()`
  returns all four (the existing `GET /geo/profiles` and plan-driven tabs stay
  and simply show everything).

Route wire shape (unchanged from the GraphHopper round, plus traffic delay):

```python
{"routes": [{"distance_m", "duration_s", "traffic_delay_s",
             "coordinates": [[lon, lat], ...],
             "maneuvers": [{"instruction", "maneuver", "distance_m",
                            "duration_s", "begin_shape_index"}]}]}
```

- `coordinates` = every leg's `points` in order; `begin_shape_index` = the
  instruction's `pointIndex`; per-step distance/time = the difference of
  consecutive `routeOffsetInMeters` / `travelTimeInSeconds`.
- **Vietnamese instructions are built here**, because TomTom's guidance has
  no `vi-VN`: `geo/maneuvers.py` maps the 33 maneuver codes to Vietnamese
  and appends the street ("Rẽ phải vào Hùng Vương", "Vào vòng xuyến, đi lối
  ra thứ 2"). The UI step list and the tool's `steps` share it.

### 6.3 Proxy endpoints (all behind `require_known_origin`)

| Endpoint | Calls | Notes |
|---|---|---|
| `GET /geo/suggest?q=&lat=&lon=` | `suggest` | `q` 3–120 chars; → `{"suggestions": [...]}` |
| `GET /geo/place?ref=` | `place` | → `{"lat", "lon"}`; bad `ref` → 422 |
| `GET /geo/reverse?lat=&lon=` | `reverse` | → `{"address": str \| null}` |
| `POST /geo/route` | `route` | unchanged contract; 422 `no_route` |
| `GET /geo/profiles` | `available_profiles` | unchanged; now all four modes |

- Errors: `TomTomUnavailable` → `503 {"error": "unavailable"}` (routing keeps
  its existing `routing_unavailable` code); `QuotaExceeded` →
  `429 {"error": "quota_exceeded"}` (UI: "Tìm kiếm tạm hết hạn mức" /
  "Chỉ đường tạm hết hạn mức").
- One LRU cache per function (256 entries; suggest 512), keyed on inputs
  with coordinates rounded (5 decimals for route stops, 2 for proximity).

### 6.4 Agent tools (capability `geo.read`, `risk="low"` — read-only)

| Tool | Input | Model output | Preview spec |
|---|---|---|---|
| `find_place` | `query`, `near?` (`"my_location"` or a place name) | ≤5 `{label, category, address, lat, lon}` (fuzzy search, 1 request) | `map` with `points` + `bbox` over results |
| `get_directions` | `from`, `to` (place name or `"my_location"`), `profile` (default `motor_scooter`), `via?` (≤3) | `{from, to, distance_km, duration_min, traffic_delay_min, steps: first 8}` | `map` with `route: {profile, waypoints}` + A/B `points` |

- Stops named by the model are resolved with fuzzy search (limit 1); a
  `"my_location"` stop costs no search.
- `QuotaExceeded` → an error dict saying the month's free allowance is used up.
- A `map` preview is the final visualization (orchestrator passes it
  through; unchanged).

### 6.5 Privacy

- Proximity sent to TomTom search/suggest is rounded to 2 decimals (~1 km).
- Routing needs the real stops, so full-precision coordinates go to TomTom
  — only for a route the operator asked for, and a `"my_location"` stop only
  when they already shared their location.
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
- `mapApi.spec.ts` (new): step geometry from `begin_shape_index`; TomTom
  style URLs and key injection; Vietnamese distance/duration formatting.
- `contracts.spec.ts` (extend): `map` / `MapView` parity; minimal `{type:"map"}`
  valid.
- Layout: `map` specs take no slot in `resolveVisualizationLayout`.

**Frontend UI (`tests/ui/map.spec.ts`, new)**

`page.route` intercepts `api.tomtom.com` and serves a minimal style JSON
(background only, no tiles), so real MapLibre runs offline in Chromium; the
orchestrator's `/geo/*` endpoints are stubbed with `page.route`.

1. Globe zoomed to `MIN_DIST` + more scroll → map layer visible, `mode=map`;
   `Esc` → back to globe.
2. Agent `map` spec with `route` → map opens, directions panel shows the stubbed
   distance/time and traffic delay, route layer exists; motorbike selected
   by default; switching mode re-asks with the new profile.
3. Search: suggestions appear after 3 characters, ↑↓/Enter selects, the pick
   is resolved through `/geo/place`, place card opens; a 429 shows the quota
   message.
4. `/geo/route` 503 → "Chỉ đường chưa được cấu hình", map still usable.
5. `prefers-reduced-motion` → short fade (timed via `mode` changes).

DOM/state assertions only — no map screenshots (fonts/tiles make them flaky).

**Backend (`backend/tests/`)**

- `unit/test_tomtom.py`: against a local fake of the TomTom APIs (the
  `fetch` test pattern): suggest/details/reverse/search/route request shapes
  (headers, travel-mode mapping, alternatives only for two stops, proximity
  rounded to 2 decimals), normalization (legs joined, per-step distance and
  time, traffic delay), `ref` validation, error mapping (400 → no route,
  429 → quota, 403/5xx/unreachable/no key → unavailable), cache hits.
- `unit/test_maneuvers.py`: all 33 maneuver codes have Vietnamese text;
  street joining; roundabout exit numbers; unknown code fallback.
- `integration/test_geo_route.py`: every `/geo/*` endpoint — validation,
  error mapping, origin guard.
- `unit/test_geo_tools.py`: `find_place` / `get_directions` with a fake
  TomTom module; unshared `"my_location"` errors; default profile
  `motor_scooter`; quota errors; preview specs validate as
  `VisualizationPlan`.
- `integration/test_map_preview_pin.py`: a `map` preview is streamed as the
  final spec without calling the planner.
- `test_contracts`: Python schema ↔ JSON contract parity.

**Manual checks at implementation (browser preview):** sphere-size match during
the crossfade; repeated enter/leave frees the WebGL context (no leak).

**Done when** `npm run verify` is green; the map UI tests need no TomTom key
and no network.

## 8. Out of scope

- Paid TomTom tiers; raising limits is a key/plan change, not code.
- Self-hosted routing or tiles.
- Transit, offline tiles, saved places, Street View.
