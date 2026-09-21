# MapLibre Street Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zooming the globe past its limit hands off to a full-screen, Google-Maps-like MapLibre map (search, place card, context menu, directions), and agent tools can open that map directly for places and routes.

**Architecture:** A DOM map layer sits between the R3F canvas and the HUD; a small `mapView` slice in the zustand store holds intent (`globe → entering → map → leaving`) and both the globe and the map react to it. A new `map` visualization type carries route *intent* (profile + waypoints); geometry always comes from `POST /geo/route`, a thin FastAPI proxy over a self-hosted, optional Valhalla. Agent tools `find_place` / `get_directions` geocode with MapTiler and emit `map` previews, which the orchestrator passes through without re-planning.

**Tech Stack:** Next 16 / React 19 / zustand 5 / R3F 9 (existing), `maplibre-gl@^6.10` (new, the only new dependency), MapTiler (tiles + geocoding), Valhalla (`ghcr.io/valhalla/valhalla-scripted`), FastAPI + pydantic (existing), Playwright (unit + ui projects), plain-python backend tests (`python backend/runtests.py`).

**Spec:** `docs/superpowers/specs/2026-09-21-maplibre-map-design.md`

## Global Constraints

- Only new npm dependency: `maplibre-gl` (named imports: `Map`, `Marker`, `NavigationControl`, `ScaleControl`, `GeoJSONSource`, `MapMouseEvent`). No React wrapper. No new Python dependency (`urllib` + `asyncio.to_thread`, like `backend/friday/tools/integrations/fetch.py`).
- maplibre-gl loads lazily (`next/dynamic`, `ssr: false`) — never in the main bundle.
- Env: `NEXT_PUBLIC_MAPTILER_KEY` (browser, origin-restricted), `MAPTILER_SERVER_KEY` (backend), `VALHALLA_URL` (backend, optional; unset = directions off, everything else works).
- Default travel profile: `motor_scooter`. Profiles: `"auto" | "motor_scooter" | "bicycle" | "pedestrian"`.
- Valhalla narrative language `vi-VN` (verified: `valhalla/locales/vi-VN.json` exists).
- Coordinates sent to MapTiler for proximity bias are rounded to 2 decimals. Full precision only goes to Valhalla.
- UI copy is Vietnamese (strings are given verbatim in the tasks). Map titles in specs follow the existing all-caps convention.
- Visualization contract changes land in all three places at once: `src/lib/visualization/types.ts`, `backend/friday/schemas/visualization.py`, `contracts/visualization/visualization.v1.json`.
- No test touches the real network. Map UI tests stub `api.maptiler.com` with `page.route` and need neither Valhalla nor a real key.
- Commits: conventional prefix (`feat(map): …`, `feat(geo): …`, `test(...)`), and **no `Co-Authored-By` trailer** (user preference).
- Done = `npm run verify` green.

## Deviations from the spec (decided while planning — flag in review)

1. **Valhalla has `vi-VN`**, so the frontend maneuver→Vietnamese template table (spec §6.2/§7) is dropped; instructions arrive translated.
2. **`/geo/route` returns `legs`**, not one `shape`: Valhalla returns one polyline per leg when there are via points, and encoded polylines cannot be concatenated as strings. Route = `{distance_m, duration_s, legs: [{shape, maneuvers}]}`.
3. **Globe→flat happens at zoom ~10–12**, not ~5: that is MapLibre's built-in `"globe"` preset. The map is still curved right after handoff (reads like Google Earth), which is fine.
4. **A `map` preview skips the planner** (`backend/friday/api/routes.py`): re-planning would let the model rewrite waypoints it never measured. Not in the spec; required for correctness.
5. **No backend evals for the geo tools**: the eval harness scripts the model, so an eval would only restate the policy unit test (low risk → no confirm). Tool behavior is covered by `test_geo_tools.py`.
6. **No separate 3D marker fade** during the handoff: the opaque map crossfading over the canvas already covers it.

## File Structure

**Frontend — new**
- `src/lib/mapView.ts` — pure map state: types, reducers (`openMapState`, `closeMapState`, `settleMapState`, `mapViewAfterSpec`), over-zoom accumulator, handoff zoom constants.
- `src/components/friday/map/MapIsland.tsx` — tiny always-mounted client component: sets `html[data-map]`, lazy-mounts the map stage.
- `src/components/friday/map/MapLayer.tsx` — the map stage (MapLibre instance, transition, markers, my location, controls, layer switcher, 3D, Esc / zoom-out leave).
- `src/components/friday/map/MapSearch.tsx` — ARIA combobox with MapTiler autocomplete (top bar + directions inputs).
- `src/components/friday/map/PlacePanel.tsx` — place card + right-click context menu.
- `src/components/friday/map/DirectionsPanel.tsx` — directions panel, route layers, draggable stops, step list.
- `src/components/friday/map/mapApi.ts` — style URLs, geocoding client + parser, `/geo/route` client, polyline6 decoder, formatting.
- `src/components/friday/map/map.css` — MapLibre control restyle, pins, transition.
- `tests/unit/mapView.spec.ts`, `tests/unit/mapApi.spec.ts`, `tests/ui/map.spec.ts`.

**Frontend — modified**
- `src/lib/visualization/types.ts` (MapView, `"map"`), `src/lib/visualization/normalization.ts` (sanitize `map`), `src/lib/visualization/layoutResolver.ts` (`sceneEntries`), `src/lib/agent/events.ts` (KNOWN_VIZ), `src/lib/vizPlanner.ts` (map rule/sample/clone/summary), `src/lib/store.ts` (mapView slice), `src/components/friday/visualization/FridayVisualization.tsx` (REGISTRY + scene filter), `src/components/friday/visualization/globe/geo.ts` (`viewCenterFromAngles`), `src/components/friday/visualization/globe/useGlobeInteraction.ts` (over-zoom, entering dolly, key gating, leaving focus), `src/components/friday/visualization/globe/GlobeVisualization.tsx` (pass points), `src/components/friday/Scene.tsx` (frameloop), `src/components/friday/SceneIsland.tsx` (deep link), `src/components/friday/hud/{VizRail,StateRail,EdgeTelemetry}.tsx` (`data-map-hide`), `src/app/page.tsx`, `src/app/globals.css`, `src/proxy.ts` (CSP), `.env.example`, `playwright.config.ts`, `tests/ui/stubOrchestrator.ts` (MAP_FLOW), `tests/unit/{contracts,vizNormalize,coreDock,globeGeo,store}.spec.ts`.

**Backend — new**
- `backend/friday/geo/__init__.py`, `backend/friday/geo/valhalla.py`, `backend/friday/geo/maptiler.py`, `backend/friday/geo/tools.py`.
- `docker/valhalla/compose.yml`.
- `backend/tests/unit/test_valhalla.py`, `backend/tests/unit/test_geo_tools.py`, `backend/tests/integration/test_geo_route.py`, `backend/tests/integration/test_map_preview_pin.py`.

**Backend — modified**
- `backend/friday/schemas/visualization.py`, `backend/friday/schema.py` (re-export), `backend/friday/api/schemas.py` (RouteRequest), `backend/friday/api/routes.py` (`/geo/route`, map pin), `backend/friday/tools/registry.py`, `backend/friday/planner/prompts.py`, `backend/.env.example`, `backend/tests/unit/test_contracts.py`, `package.json` (`dev:valhalla`), `README.md`, `backend/README.md`, `docs/ARCHITECTURE.md`.

---

### Task 1: `map` visualization contract, end to end

**Files:**
- Modify: `src/lib/visualization/types.ts`, `src/lib/visualization/normalization.ts`, `src/lib/visualization/layoutResolver.ts`, `src/lib/agent/events.ts`, `src/lib/vizPlanner.ts`, `src/components/friday/visualization/FridayVisualization.tsx`, `src/components/friday/SceneIsland.tsx`, `src/components/friday/hud/VizRail.tsx`, `contracts/visualization/visualization.v1.json`, `backend/friday/schemas/visualization.py`, `backend/friday/schema.py`, `backend/friday/planner/prompts.py`
- Test: `tests/unit/contracts.spec.ts`, `tests/unit/vizNormalize.spec.ts`, `tests/unit/coreDock.spec.ts`, `backend/tests/unit/test_contracts.py`

**Interfaces:**
- Produces (TS, `@/lib/visualization/types`): `type MapProfile = "auto" | "motor_scooter" | "bicycle" | "pedestrian"`; `interface MapWaypoint { lat: number; lon: number; label?: string }`; `interface MapView { center?: {lat:number; lon:number}; zoom?: number; bbox?: [number, number, number, number]; route?: { profile: MapProfile; waypoints: MapWaypoint[] } }`; `VizData.map?: MapView`; `"map"` in `VisualizationType`.
- Produces (TS, `@/lib/visualization/normalization`): `export function sanitizeMapView(value: unknown): MapView | undefined`.
- Produces (TS, `@/lib/visualization/layoutResolver`): `export function sceneEntries<T extends Pick<VisualizationEntry, "spec">>(entries: T[]): T[]`.
- Produces (Python, `friday.schemas.visualization`): `LatLon`, `MapWaypoint`, `MapRoute`, `MapView`, `VizData.map`.

- [ ] **Step 1: Write the failing frontend tests**

Append to `tests/unit/contracts.spec.ts`:

```ts
test("visualization schema declares the map type and MapView on VizData", () => {
  expect(viz.properties.type.enum).toContain("map");
  expect(viz.definitions.VizData.properties.map).toEqual({ $ref: "#/definitions/MapView" });
  const mv = viz.definitions.MapView;
  expect(Object.keys(mv.properties).sort()).toEqual(["bbox", "center", "route", "zoom"]);
  expect(viz.definitions.MapRoute.properties.profile.enum).toEqual(["auto", "motor_scooter", "bicycle", "pedestrian"]);
  expect(viz.definitions.MapRoute.properties.waypoints.minItems).toBe(2);
  expect(viz.definitions.MapRoute.properties.waypoints.maxItems).toBe(5);
});
```

Also add `"map"` to the literal list in the existing test `"visualization schema type universe matches the FE parser"`.

Append to `tests/unit/vizNormalize.spec.ts`:

```ts
import { sanitizeMapView } from "@/lib/visualization/normalization";

test("map view keeps valid center, zoom, bbox and route", () => {
  const view = sanitizeMapView({
    center: { lat: 21.03, lon: 105.85 },
    zoom: 15,
    bbox: [105.8, 21.0, 105.9, 21.1],
    route: {
      profile: "bicycle",
      waypoints: [
        { lat: 21.0288, lon: 105.8525, label: "HỒ GƯƠM" },
        { lat: 21.0368, lon: 105.8346 },
      ],
    },
  });
  expect(view).toEqual({
    center: { lat: 21.03, lon: 105.85 },
    zoom: 15,
    bbox: [105.8, 21.0, 105.9, 21.1],
    route: {
      profile: "bicycle",
      waypoints: [
        { lat: 21.0288, lon: 105.8525, label: "HỒ GƯƠM" },
        { lat: 21.0368, lon: 105.8346 },
      ],
    },
  });
});

test("map view drops out-of-range and malformed fields", () => {
  expect(sanitizeMapView(null)).toBeUndefined();
  expect(sanitizeMapView({ center: { lat: 91, lon: 0 }, zoom: 30 })).toBeUndefined();
  expect(sanitizeMapView({ bbox: [0, 10, 1, 5] })).toBeUndefined(); // south above north
  // a route needs 2-5 valid waypoints; an unknown profile falls back to motorbike
  expect(sanitizeMapView({ route: { profile: "rocket", waypoints: [{ lat: 1, lon: 1 }] } })).toBeUndefined();
  expect(
    sanitizeMapView({ route: { profile: "rocket", waypoints: [{ lat: 1, lon: 1 }, { lat: 2, lon: "x" }, { lat: 3, lon: 3 }] } }),
  ).toEqual({ route: { profile: "motor_scooter", waypoints: [{ lat: 1, lon: 1 }, { lat: 3, lon: 3 }] } });
});

test("normalizeVisualization sanitizes data.map", () => {
  const spec = normalizeVisualization({ type: "map", data: { map: { zoom: 99, center: { lat: 1, lon: 2 } } } });
  expect(spec.data?.map).toEqual({ center: { lat: 1, lon: 2 } });
});
```

Append to `tests/unit/coreDock.spec.ts` (reuse the file's existing `entry()` helper):

```ts
import { sceneEntries } from "@/lib/visualization/layoutResolver";

test("a map spec takes no scene slot and never docks the core", () => {
  expect(sceneEntries([entry({ type: "map" }), entry({ type: "globe" })]).map((e) => e.spec.type)).toEqual(["globe"]);
  expect(shouldDockCore([entry({ type: "map" })])).toBe(false);
  // globe + map: the globe is alone on stage, so it is centered and docks the core
  expect(shouldDockCore([entry({ type: "globe" }), entry({ type: "map" })])).toBe(true);
});
```

- [ ] **Step 2: Write the failing backend test**

Append to `backend/tests/unit/test_contracts.py`:

```python
def test_map_view_matches_canonical_schema() -> None:
    from friday.schemas.visualization import MapRoute, MapView, VizData

    schema = load("visualization", "visualization.v1.json")
    assert "map" in set(get_args(VisualizationType))
    assert "map" in schema["properties"]["type"]["enum"]
    assert set(MapView.model_fields) == set(schema["definitions"]["MapView"]["properties"])
    assert "map" in VizData.model_fields
    profiles = schema["definitions"]["MapRoute"]["properties"]["profile"]["enum"]
    assert list(get_args(MapRoute.model_fields["profile"].annotation)) == profiles
    assert MapRoute.model_fields["profile"].default == "motor_scooter"
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx playwright test --project=unit tests/unit/contracts.spec.ts tests/unit/vizNormalize.spec.ts tests/unit/coreDock.spec.ts`
Expected: FAIL — `sanitizeMapView`/`sceneEntries` not exported, `map` not in the enum.

Run: `python backend/runtests.py test_contracts`
Expected: FAIL — `ImportError: cannot import name 'MapRoute'`.

- [ ] **Step 4: Frontend types**

In `src/lib/visualization/types.ts` add `| "map"` to `VisualizationType` (after `"sankey_flow"`), then add below `GlobeRoute`:

```ts
/** Travel mode for a map route — Valhalla costing names (spec §5). */
export type MapProfile = "auto" | "motor_scooter" | "bicycle" | "pedestrian";

export interface MapWaypoint {
  lat: number;
  lon: number;
  label?: string;
}

/**
 * Where a `map` visualization looks and what it routes. A route is intent
 * only — the map fetches the geometry from `/geo/route` itself, the same call
 * user-driven directions make (spec §5).
 */
export interface MapView {
  center?: { lat: number; lon: number };
  /** 0–20; defaults to 14 when only `center` is given. */
  zoom?: number;
  /** [west, south, east, north]; wins over center/zoom. */
  bbox?: [number, number, number, number];
  route?: { profile: MapProfile; waypoints: MapWaypoint[] };
}
```

and in `VizData` add after `routes?`:

```ts
  /** `map` visualizations only — camera and route intent. */
  map?: MapView;
```

- [ ] **Step 5: Normalization**

In `src/lib/visualization/normalization.ts` add the import `type MapProfile, type MapView` from `./types` (extend the existing import) and add above `sanitizeData`:

```ts
const MAP_PROFILES: ReadonlySet<string> = new Set(["auto", "motor_scooter", "bicycle", "pedestrian"]);

function finiteIn(value: unknown, lo: number, hi: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= lo && value <= hi;
}

function sanitizeLatLon(value: unknown): { lat: number; lon: number } | undefined {
  const p = value as { lat?: unknown; lon?: unknown } | null | undefined;
  return p && finiteIn(p.lat, -90, 90) && finiteIn(p.lon, -180, 180) ? { lat: p.lat, lon: p.lon } : undefined;
}

/** `data.map` arrives off the wire like everything else — keep only what the map can use. */
export function sanitizeMapView(value: unknown): MapView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const out: MapView = {};
  const center = sanitizeLatLon(v.center);
  if (center) out.center = center;
  if (finiteIn(v.zoom, 0, 20)) out.zoom = v.zoom;
  const b = v.bbox;
  if (
    Array.isArray(b) &&
    b.length === 4 &&
    finiteIn(b[0], -180, 180) &&
    finiteIn(b[1], -90, 90) &&
    finiteIn(b[2], -180, 180) &&
    finiteIn(b[3], -90, 90) &&
    b[1] < b[3]
  ) {
    out.bbox = [b[0], b[1], b[2], b[3]];
  }
  const r = v.route as { profile?: unknown; waypoints?: unknown } | null | undefined;
  if (r && Array.isArray(r.waypoints)) {
    const waypoints = r.waypoints.flatMap((w) => {
      const p = sanitizeLatLon(w);
      if (!p) return [];
      const label = sanitizeLabel((w as { label?: unknown }).label);
      return [label ? { ...p, label } : p];
    });
    if (waypoints.length >= 2 && waypoints.length <= 5) {
      const profile = MAP_PROFILES.has(r.profile as string) ? (r.profile as MapProfile) : "motor_scooter";
      out.route = { profile, waypoints };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
```

and inside `sanitizeData`, just before the `out.rate` line:

```ts
  out.map = sanitizeMapView(out.map);
```

- [ ] **Step 6: Layout, registry, parser**

In `src/lib/visualization/layoutResolver.ts` add above `resolveVisualizationLayout`:

```ts
/** Entries drawn in the 3D scene — a `map` spec renders in the DOM map layer, never here. */
export function sceneEntries<T extends Pick<VisualizationEntry, "spec">>(entries: T[]): T[] {
  return entries.filter((e) => e.spec.type !== "map");
}
```

and replace the body of `shouldDockCore` with:

```ts
  const scene = sceneEntries(entries);
  const latest = scene.at(-1);
  if (!latest) return false;
  const { position } = resolveVisualizationLayout(latest.spec, {
    count: scene.length,
    index: scene.length - 1,
  });
  return (
    Math.abs(position[0]) <= CENTER_STAGE_HALF && Math.abs(position[1]) <= CENTER_STAGE_HALF
  );
```

In `src/components/friday/visualization/FridayVisualization.tsx`:
- import `sceneEntries` from `@/lib/visualization/layoutResolver` (extend the existing import);
- add to `REGISTRY`: `map: () => null, // drawn by the DOM map layer (spec §5)`;
- in `FridayVisualization`, keep `vizKey` computed from all `entries`, then replace `if (entries.length === 0) return null;` and the render map with:

```tsx
  const scene = sceneEntries(entries);
  if (scene.length === 0) return null;

  // §13/§14 — multiple visualizations coexist with deterministic spatial layout
  return (
    <group>
      {scene.map((entry, i) => (
        <VizNode
          key={entry.id}
          id={entry.id}
          spec={entry.spec}
          lifecycle={entry.lifecycle}
          count={scene.length}
          index={i}
          color={entry.spec.theme?.color ?? look.color}
          accent={entry.spec.theme?.accent ?? look.accent}
        />
      ))}
    </group>
  );
```

Note: a `map` entry never settles through `Entrance` — that is fine, `lifecycle` is only read by the 3D entrance.

In `src/lib/agent/events.ts` add `"map",` to `KNOWN_VIZ`.

- [ ] **Step 7: Offline planner, deep link, dev rail**

In `src/lib/vizPlanner.ts`, insert this rule into `RULES` **directly before** the `globe` rule:

```ts
  {
    type: "map",
    // Street-level asks. Must precede the globe rule, whose bare \bmap\b
    // would otherwise swallow "street map" / "bản đồ".
    match: /directions|how do i get|chỉ đường|đường đi|đường tới|bản đồ|street map/i,
    build: () => ({
      type: "map",
      title: "HOÀN KIẾM",
      animation: "materialize",
      data: {
        points: [{ id: "hg", label: "HỒ GƯƠM", lat: 21.0288, lon: 105.8525 }],
        map: { center: { lat: 21.0288, lon: 105.8525 }, zoom: 15 },
      },
    }),
  },
```

In `cloneSpec`, inside the `data` object, add `map: spec.data.map ? structuredClone(spec.data.map) : undefined,`.
In `SAMPLES` add `map: () => RULE_BY_TYPE.map.build(),`.
In `summarize` add before `default:`:

```ts
    case "map":
      return "Map is open.";
```

In `src/components/friday/SceneIsland.tsx` add `"map"` to `KNOWN`. In `src/components/friday/hud/VizRail.tsx` add `"map"` to `VIZ_OPTIONS` (last).

- [ ] **Step 8: JSON contract**

In `contracts/visualization/visualization.v1.json`: add `"map"` to `properties.type.enum` (after `"sankey_flow"`); add to `definitions.VizData.properties` (after `"routes"`):

```json
        "map": { "$ref": "#/definitions/MapView" },
```

and add these definitions (before `"VizData"`):

```json
    "LatLon": {
      "type": "object",
      "required": ["lat", "lon"],
      "properties": {
        "lat": { "type": "number", "minimum": -90, "maximum": 90 },
        "lon": { "type": "number", "minimum": -180, "maximum": 180 }
      }
    },
    "MapRoute": {
      "type": "object",
      "required": ["waypoints"],
      "properties": {
        "profile": { "type": "string", "enum": ["auto", "motor_scooter", "bicycle", "pedestrian"], "default": "motor_scooter" },
        "waypoints": {
          "type": "array",
          "minItems": 2,
          "maxItems": 5,
          "items": {
            "type": "object",
            "required": ["lat", "lon"],
            "properties": {
              "lat": { "type": "number", "minimum": -90, "maximum": 90 },
              "lon": { "type": "number", "minimum": -180, "maximum": 180 },
              "label": { "type": "string" }
            }
          }
        }
      }
    },
    "MapView": {
      "type": "object",
      "description": "Camera and route intent for a `map` visualization. A route carries waypoints only; the map fetches geometry from /geo/route.",
      "properties": {
        "center": { "$ref": "#/definitions/LatLon" },
        "zoom": { "type": "number", "minimum": 0, "maximum": 20 },
        "bbox": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4, "description": "[west, south, east, north]" },
        "route": { "$ref": "#/definitions/MapRoute" }
      }
    },
```

- [ ] **Step 9: Python schema + planner prompt**

In `backend/friday/schemas/visualization.py`: add `"map",` to `VisualizationType`; add above `class VizData`:

```python
class LatLon(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class MapWaypoint(LatLon):
    label: str | None = None


class MapRoute(BaseModel):
    """Route intent: the map fetches geometry from /geo/route itself."""

    profile: Literal["auto", "motor_scooter", "bicycle", "pedestrian"] = "motor_scooter"
    waypoints: list[MapWaypoint] = Field(min_length=2, max_length=5)


class MapView(BaseModel):
    center: LatLon | None = None
    zoom: float | None = Field(default=None, ge=0, le=20)
    bbox: list[float] | None = Field(
        default=None, min_length=4, max_length=4, description="[west, south, east, north]"
    )
    route: MapRoute | None = None
```

and in `VizData` add `map: MapView | None = None` after `routes`. In `backend/friday/schema.py` add `LatLon`, `MapRoute`, `MapView`, `MapWaypoint` to the import and `__all__`.

In `backend/friday/planner/prompts.py` replace the globe line of `SYSTEM` with these two lines:

```
- globe — geography at country or world scale, regions, edge locations (use `points`)
- map — one specific place, street, address or route at city scale or below (use `map`: `center` + `zoom`, or `bbox`, or `route`; `points` for markers)
```

- [ ] **Step 10: Run everything touched**

Run: `npx playwright test --project=unit tests/unit/contracts.spec.ts tests/unit/vizNormalize.spec.ts tests/unit/coreDock.spec.ts tests/unit/vizPlanner.spec.ts tests/unit/eventContract.spec.ts`
Expected: PASS. If `vizPlanner.spec.ts` has a case asserting a street-level query maps to `globe`, update it to `map` only if the query matches the new rule's words; otherwise leave it.

Run: `python backend/runtests.py test_contracts` and `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 11: Commit**

```bash
git add src/lib/visualization src/lib/agent/events.ts src/lib/vizPlanner.ts src/components/friday/visualization/FridayVisualization.tsx src/components/friday/SceneIsland.tsx src/components/friday/hud/VizRail.tsx contracts/visualization backend/friday/schemas backend/friday/schema.py backend/friday/planner/prompts.py tests/unit backend/tests/unit/test_contracts.py
git commit -m "feat(viz): map visualization type carrying camera and route intent"
```

---

### Task 2: Map view state, over-zoom accumulator, view-center math

**Files:**
- Create: `src/lib/mapView.ts`
- Modify: `src/lib/store.ts`, `src/components/friday/visualization/globe/geo.ts`
- Test: `tests/unit/mapView.spec.ts`, `tests/unit/globeGeo.spec.ts`

**Interfaces:**
- Consumes: `MapView`, `GeoPoint`, `VisualizationSpec` from Task 1.
- Produces (`@/lib/mapView`):
  - `type MapMode = "globe" | "entering" | "map" | "leaving"`, `type MapSource = "zoom" | "agent" | "user"`
  - `interface MapViewState { mode; center: {lat;lon}; zoom: number; source: MapSource; view?: MapView; points?: GeoPoint[]; rev: number }`
  - `interface OpenMapRequest { center; zoom; source; view?; points? }`
  - `INITIAL_MAP_VIEW`, `DEFAULT_SPEC_ZOOM = 14`, `HANDOFF_ZOOM = 2.2`, `ARRIVAL_ZOOM = 5`, `LEAVE_ZOOM = 1.8`
  - `openMapState(prev, req)`, `closeMapState(prev, center?)`, `settleMapState(prev)`, `requestFromSpec(spec): OpenMapRequest | null`, `mapViewAfterSpec(prev, spec)`
  - `interface OverZoom { amount: number; at: number }`, `OVERZOOM_THRESHOLD = 1`, `OVERZOOM_DECAY_MS = 600`, `pushOverZoom(prev, push, now): { next: OverZoom; fire: boolean }`
- Produces (store): `mapView: MapViewState`, `openMap(req: OpenMapRequest)`, `closeMap(center?: {lat;lon})`, `settleMap()`.
- Produces (`geo.ts`): `viewCenterFromAngles(yaw: number, pitch: number): { lat: number; lon: number }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mapView.spec.ts`:

```ts
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
```

Append to `tests/unit/globeGeo.spec.ts` (add `computeGlobeFocusAngles, viewCenterFromAngles` to its geo import):

```ts
test("viewCenterFromAngles inverts computeGlobeFocusAngles", () => {
  for (const lat of [-40, 0, 21.03, 45]) {
    for (const lon of [-170, -90, 0, 45, 105.85, 179]) {
      const { yaw, pitch } = computeGlobeFocusAngles(lat, lon, 0);
      const c = viewCenterFromAngles(yaw, pitch);
      expect(Math.abs(c.lat - lat)).toBeLessThan(1e-9);
      const dLon = ((c.lon - lon + 540) % 360) - 180;
      expect(Math.abs(dLon)).toBeLessThan(1e-9);
    }
  }
});

test("viewCenterFromAngles wraps spun yaw and reports the clamped latitude", () => {
  const { yaw, pitch } = computeGlobeFocusAngles(80, 10, 0, 0.85);
  const c = viewCenterFromAngles(yaw + Math.PI * 6, pitch);
  expect(Math.abs(c.lat - (0.85 * 180) / Math.PI)).toBeLessThan(1e-9);
  expect(Math.abs(c.lon - 10)).toBeLessThan(1e-9);
  expect(c.lon).toBeGreaterThanOrEqual(-180);
  expect(c.lon).toBeLessThan(180);
});
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=unit tests/unit/mapView.spec.ts tests/unit/globeGeo.spec.ts`
Expected: FAIL — module `@/lib/mapView` not found, `viewCenterFromAngles` not exported.

- [ ] **Step 3: Implement `src/lib/mapView.ts`**

```ts
/**
 * Map mode state (spec §3) — pure, so the store, the globe and the map layer
 * share one set of rules and the rules are unit-testable without React.
 * The store holds intent only; camera easing lives in refs and MapLibre.
 */
import type { GeoPoint, MapView, VisualizationSpec } from "@/lib/visualization/types";

export type MapMode = "globe" | "entering" | "map" | "leaving";
export type MapSource = "zoom" | "agent" | "user";

export interface MapViewState {
  mode: MapMode;
  center: { lat: number; lon: number };
  zoom: number;
  source: MapSource;
  view?: MapView;
  points?: GeoPoint[];
  /** Bumped on every accepted open request, so the map re-applies camera and route. */
  rev: number;
}

export interface OpenMapRequest {
  center: { lat: number; lon: number };
  zoom: number;
  source: MapSource;
  view?: MapView;
  points?: GeoPoint[];
}

/** MapLibre zoom whose globe matches the R3F globe's size at ENTER_DIST (tuned by eye in Task 9). */
export const HANDOFF_ZOOM = 2.2;
/** Where a zoom handoff flies once the crossfade lands. */
export const ARRIVAL_ZOOM = 5;
/** Zooming the map out past this hands back to the globe. */
export const LEAVE_ZOOM = 1.8;
/** A spec that gives a center but no zoom (spec §5). */
export const DEFAULT_SPEC_ZOOM = 14;

export const INITIAL_MAP_VIEW: MapViewState = {
  mode: "globe",
  center: { lat: 21.0285, lon: 105.8542 },
  zoom: HANDOFF_ZOOM,
  source: "user",
  rev: 0,
};

const isOpen = (s: MapViewState) => s.mode === "entering" || s.mode === "map";

export function openMapState(prev: MapViewState, req: OpenMapRequest): MapViewState {
  // A preview followed by the identical final spec must not re-fly the camera.
  if (
    isOpen(prev) &&
    JSON.stringify([prev.center, prev.zoom, prev.view, prev.points]) ===
      JSON.stringify([req.center, req.zoom, req.view, req.points])
  ) {
    return prev;
  }
  return { ...req, mode: isOpen(prev) ? prev.mode : "entering", rev: prev.rev + 1 };
}

/** `center` is where the map was looking, so the globe turns there on the way back. */
export function closeMapState(prev: MapViewState, center?: { lat: number; lon: number }): MapViewState {
  if (!isOpen(prev)) return prev;
  return { ...prev, mode: "leaving", center: center ?? prev.center };
}

export function settleMapState(prev: MapViewState): MapViewState {
  if (prev.mode === "entering") return { ...prev, mode: "map" };
  if (prev.mode === "leaving") return { ...prev, mode: "globe" };
  return prev;
}

export function requestFromSpec(spec: VisualizationSpec): OpenMapRequest | null {
  const view = spec.data?.map;
  const points = spec.data?.points;
  const fromBbox = view?.bbox
    ? { lat: (view.bbox[1] + view.bbox[3]) / 2, lon: (view.bbox[0] + view.bbox[2]) / 2 }
    : undefined;
  const c = fromBbox ?? view?.center ?? view?.route?.waypoints[0] ?? points?.[0];
  if (!c) return null;
  return {
    center: { lat: c.lat, lon: c.lon },
    zoom: view?.zoom ?? DEFAULT_SPEC_ZOOM,
    source: "agent",
    view,
    points,
  };
}

/** Spec §5: a map spec opens (or re-aims) the map; any other visualization closes it. */
export function mapViewAfterSpec(prev: MapViewState, spec: VisualizationSpec): MapViewState {
  if (spec.type !== "map") return closeMapState(prev);
  const req = requestFromSpec(spec);
  return req ? openMapState(prev, req) : prev;
}

// ---------- over-zoom: "keep pushing past the globe's limit" (spec §3.2) ----------

export interface OverZoom {
  amount: number;
  at: number;
}

/** One wheel notch pushes 0.25, so the handoff needs ~4 notches in a row. */
export const OVERZOOM_THRESHOLD = 1;
/** A pause this long starts the push over from zero. */
export const OVERZOOM_DECAY_MS = 600;

export function pushOverZoom(prev: OverZoom, push: number, now: number): { next: OverZoom; fire: boolean } {
  const base = now - prev.at > OVERZOOM_DECAY_MS ? 0 : prev.amount;
  const amount = base + Math.max(0, push);
  if (amount >= OVERZOOM_THRESHOLD) return { next: { amount: 0, at: now }, fire: true };
  return { next: { amount, at: now }, fire: false };
}
```

- [ ] **Step 4: `viewCenterFromAngles` in `geo.ts`**

Add directly below `computeGlobeFocusAngles` in `src/components/friday/visualization/globe/geo.ts`:

```ts
/**
 * Inverse of computeGlobeFocusAngles: the lat/lon currently facing the
 * camera, used as the map's center at handoff (spec §3.2). Latitude is the
 * pitch itself (so a tilt-clamped view reports the clamped latitude); yaw
 * accumulates across spins, so longitude is wrapped to [-180, 180).
 */
export function viewCenterFromAngles(yaw: number, pitch: number): { lat: number; lon: number } {
  const lat = (pitch * 180) / Math.PI;
  const lon = -90 - (yaw * 180) / Math.PI;
  return { lat, lon: ((((lon + 180) % 360) + 360) % 360) - 180 };
}
```

- [ ] **Step 5: Store slice**

In `src/lib/store.ts`:
- import `{ INITIAL_MAP_VIEW, closeMapState, mapViewAfterSpec, openMapState, settleMapState, type MapViewState, type OpenMapRequest } from "@/lib/mapView";`
- add to `FridayStore` (after `releaseGlobeCamera`):

```ts
  /** Street map mode (spec §3). Intent only — the globe and the map layer animate from it. */
  mapView: MapViewState;
  openMap: (req: OpenMapRequest) => void;
  closeMap: (center?: { lat: number; lon: number }) => void;
  settleMap: () => void;
```

- change `addVisualization` so the returned object also carries `mapView: mapViewAfterSpec(s.mapView, spec)`;
- change `setVisualizations` to the function form:

```ts
  setVisualizations: (vizs) =>
    set((s) => {
      const last = vizs.at(-1);
      return {
        // Capped like addVisualization — one bulk set must not mount unbounded
        // CanvasTextures/Line2/labels (load-bearing on low-end GPUs).
        visualizations: vizs.slice(-3).map((spec) => ({
          id: nextVisualizationId++,
          spec,
          lifecycle: "materializing" as const,
        })),
        mapView: last ? mapViewAfterSpec(s.mapView, last) : s.mapView,
      };
    }),
```

- add the slice implementation after `releaseGlobeCamera`:

```ts
  mapView: INITIAL_MAP_VIEW,
  openMap: (req) => set((s) => ({ mapView: openMapState(s.mapView, req) })),
  closeMap: (center) => set((s) => ({ mapView: closeMapState(s.mapView, center) })),
  settleMap: () => set((s) => ({ mapView: settleMapState(s.mapView) })),
```

- add `mapView: INITIAL_MAP_VIEW,` to the object in `reset`.

- [ ] **Step 6: Run the tests**

Run: `npx playwright test --project=unit tests/unit/mapView.spec.ts tests/unit/globeGeo.spec.ts tests/unit/store.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mapView.ts src/lib/store.ts src/components/friday/visualization/globe/geo.ts tests/unit/mapView.spec.ts tests/unit/globeGeo.spec.ts
git commit -m "feat(map): map mode state, over-zoom accumulator and globe view center"
```

---

### Task 3: Valhalla client, `/geo/route` proxy, local Valhalla

**Files:**
- Create: `backend/friday/geo/__init__.py`, `backend/friday/geo/valhalla.py`, `docker/valhalla/compose.yml`
- Modify: `backend/friday/api/schemas.py`, `backend/friday/api/routes.py`, `backend/.env.example`, `package.json`
- Test: `backend/tests/unit/test_valhalla.py`, `backend/tests/integration/test_geo_route.py`

**Interfaces:**
- Consumes: `LatLon` from `friday.schemas.visualization` (Task 1).
- Produces (`friday.geo.valhalla`): `PROFILES: tuple[str, ...]`, `class RoutingUnavailable(Exception)`, `class NoRoute(Exception)`, `base_url() -> str | None`, `clear_cache() -> None`, `async def route(waypoints: list[dict], profile: str = "motor_scooter", alternates: int = 2, language: str = "vi-VN") -> dict` returning `{"routes": [{"distance_m": int, "duration_s": int, "legs": [{"shape": str, "maneuvers": [{"instruction": str, "type": int, "distance_m": int, "duration_s": int, "begin_shape_index": int}]}]}]}`.
- Produces (HTTP): `POST /geo/route` body `{"waypoints": [{"lat","lon"}×2–5], "profile"?}` → 200 route dict | 503 `{"error": "routing_unavailable"}` | 422 `{"error": "no_route"}` | 422 FastAPI validation | 403 bad origin.

- [ ] **Step 1: Write the failing unit test**

Create `backend/tests/unit/test_valhalla.py`:

```python
"""Valhalla client: normalization, error mapping, cache — local fake only.

    PYTHONPATH=. python tests/unit/test_valhalla.py
"""

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from friday.geo import valhalla

# Shaped like Valhalla's documented /route response (lengths in km, times in s).
TRIP = {
    "summary": {"length": 2.4, "time": 540.4},
    "legs": [{
        "shape": "_{nbg@gdv{hEoeGvpQolF~kO",
        "maneuvers": [
            {"instruction": "Đi về hướng tây.", "type": 2, "length": 1.1, "time": 250, "begin_shape_index": 0},
            {"instruction": "Bạn đã đến nơi.", "type": 4, "length": 0.0, "time": 0, "begin_shape_index": 2},
        ],
    }],
}
CALLS: list[dict] = []
MODE = {"status": 200}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        CALLS.append(body)
        if MODE["status"] == 400:
            payload = {"error_code": 442, "error": "No path could be found for input"}
        elif MODE["status"] == 500:
            payload = {"error": "boom"}
        else:
            payload = {"trip": TRIP, "alternates": [{"trip": TRIP}]}
        data = json.dumps(payload).encode()
        self.send_response(MODE["status"])
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def with_server(fn):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    old = os.environ.get("VALHALLA_URL")
    os.environ["VALHALLA_URL"] = f"http://127.0.0.1:{server.server_address[1]}/"
    CALLS.clear()
    MODE["status"] = 200
    valhalla.clear_cache()
    try:
        fn()
    finally:
        server.shutdown()
        server.server_close()
        if old is None:
            os.environ.pop("VALHALLA_URL", None)
        else:
            os.environ["VALHALLA_URL"] = old


A = {"lat": 21.0288, "lon": 105.8525}
B = {"lat": 21.0368, "lon": 105.8346}


def test_normalizes_trip_and_alternates() -> None:
    def run():
        out = asyncio.run(valhalla.route([A, B]))
        assert len(out["routes"]) == 2, out
        r = out["routes"][0]
        assert (r["distance_m"], r["duration_s"]) == (2400, 540), r
        leg = r["legs"][0]
        assert leg["shape"] == TRIP["legs"][0]["shape"]
        assert leg["maneuvers"][0] == {
            "instruction": "Đi về hướng tây.", "type": 2, "distance_m": 1100,
            "duration_s": 250, "begin_shape_index": 0,
        }, leg
        sent = CALLS[0]
        assert sent["costing"] == "motor_scooter" and sent["alternates"] == 2
        assert sent["directions_options"] == {"units": "kilometers", "language": "vi-VN"}
        assert sent["locations"] == [A, B]
    with_server(run)


def test_via_points_disable_alternates() -> None:
    def run():
        asyncio.run(valhalla.route([A, {"lat": 21.03, "lon": 105.84}, B], "auto"))
        assert CALLS[0]["alternates"] == 0 and CALLS[0]["costing"] == "auto"
    with_server(run)


def test_cache_hits_on_rounded_input() -> None:
    def run():
        asyncio.run(valhalla.route([A, B]))
        asyncio.run(valhalla.route([{"lat": 21.028800001, "lon": 105.8525}, B]))
        assert len(CALLS) == 1, CALLS
        asyncio.run(valhalla.route([A, B], "bicycle"))
        assert len(CALLS) == 2
    with_server(run)


def test_error_mapping() -> None:
    def run():
        MODE["status"] = 400
        try:
            asyncio.run(valhalla.route([A, B]))
        except valhalla.NoRoute:
            pass
        else:
            raise AssertionError("400 must be NoRoute")
        MODE["status"] = 500
        valhalla.clear_cache()
        try:
            asyncio.run(valhalla.route([A, B], "pedestrian"))
        except valhalla.RoutingUnavailable:
            pass
        else:
            raise AssertionError("500 must be RoutingUnavailable")
    with_server(run)


def test_unset_or_unreachable_is_unavailable() -> None:
    old = os.environ.pop("VALHALLA_URL", None)
    try:
        assert valhalla.base_url() is None
        try:
            asyncio.run(valhalla.route([A, B]))
        except valhalla.RoutingUnavailable:
            pass
        else:
            raise AssertionError("unset must be RoutingUnavailable")
        os.environ["VALHALLA_URL"] = "http://127.0.0.1:9"  # discard port, nothing listens
        valhalla.clear_cache()
        try:
            asyncio.run(valhalla.route([A, B]))
        except valhalla.RoutingUnavailable:
            pass
        else:
            raise AssertionError("unreachable must be RoutingUnavailable")
    finally:
        if old is None:
            os.environ.pop("VALHALLA_URL", None)
        else:
            os.environ["VALHALLA_URL"] = old


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

- [ ] **Step 2: Write the failing integration test**

Create `backend/tests/integration/test_geo_route.py`:

```python
"""POST /geo/route — validation, error mapping, origin guard.

    PYTHONPATH=. python tests/integration/test_geo_route.py
"""

import os

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"

from fastapi.testclient import TestClient

from friday.geo import valhalla
from friday.main import app

client = TestClient(app)
A = {"lat": 21.0288, "lon": 105.8525}
B = {"lat": 21.0368, "lon": 105.8346}
ROUTE = {"routes": [{"distance_m": 2400, "duration_s": 540, "legs": []}]}


def fake_route(result=None, exc=None):
    calls = []

    async def route(waypoints, profile="motor_scooter", alternates=2, language="vi-VN"):
        calls.append((waypoints, profile))
        if exc is not None:
            raise exc
        return result

    valhalla.route = route
    return calls


ORIGINAL = valhalla.route


def test_happy_path_defaults_to_motorbike() -> None:
    calls = fake_route(ROUTE)
    try:
        res = client.post("/geo/route", json={"waypoints": [A, B]})
    finally:
        valhalla.route = ORIGINAL
    assert res.status_code == 200 and res.json() == ROUTE, res.text
    assert calls == [([A, B], "motor_scooter")]


def test_validation() -> None:
    fake_route(ROUTE)
    try:
        for body in (
            {"waypoints": [A]},
            {"waypoints": [A, B, A, B, A, B]},
            {"waypoints": [{"lat": 91, "lon": 0}, B]},
            {"waypoints": [A, {"lat": 0, "lon": 181}]},
            {"waypoints": [A, B], "profile": "rocket"},
        ):
            assert client.post("/geo/route", json=body).status_code == 422, body
    finally:
        valhalla.route = ORIGINAL


def test_error_mapping() -> None:
    fake_route(exc=valhalla.RoutingUnavailable("VALHALLA_URL is not set"))
    try:
        res = client.post("/geo/route", json={"waypoints": [A, B]})
        assert res.status_code == 503 and res.json() == {"error": "routing_unavailable"}, res.text
        fake_route(exc=valhalla.NoRoute("No path could be found for input"))
        res = client.post("/geo/route", json={"waypoints": [A, B]})
        assert res.status_code == 422 and res.json() == {"error": "no_route"}, res.text
    finally:
        valhalla.route = ORIGINAL


def test_origin_guard() -> None:
    fake_route(ROUTE)
    try:
        res = client.post("/geo/route", json={"waypoints": [A, B]}, headers={"origin": "https://evil.example"})
    finally:
        valhalla.route = ORIGINAL
    assert res.status_code == 403


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

- [ ] **Step 3: Run to watch them fail**

Run: `python backend/runtests.py test_valhalla test_geo_route`
Expected: FAIL — `ModuleNotFoundError: No module named 'friday.geo'`.

- [ ] **Step 4: Implement the client**

Create `backend/friday/geo/__init__.py`:

```python
"""Maps: MapTiler geocoding and self-hosted Valhalla routing (spec 2026-09-21)."""
```

Create `backend/friday/geo/valhalla.py`:

```python
"""Valhalla routing client (spec §6.2) — self-hosted and optional.

An unset VALHALLA_URL means routing is off, not broken: callers get
RoutingUnavailable and say so plainly. Same urllib + to_thread shape as
tools/integrations/fetch.py; no HTTP dependency added for one POST.
"""

import asyncio
import json
import os
import urllib.error
import urllib.request
from collections import OrderedDict
from typing import Any

PROFILES = ("auto", "motor_scooter", "bicycle", "pedestrian")
TIMEOUT_S = 10.0
#: Drags and mode toggles re-ask the same question; answer those from memory.
CACHE_SIZE = 256

_CACHE: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


class RoutingUnavailable(Exception):
    """Not configured, unreachable, or failing — nothing the caller can fix."""


class NoRoute(Exception):
    """Valhalla ran and found no path (or the input is outside the extract)."""


def base_url() -> str | None:
    url = os.getenv("VALHALLA_URL", "").strip().rstrip("/")
    return url or None


def clear_cache() -> None:
    _CACHE.clear()


def _cache_key(waypoints: list[dict], profile: str, alternates: int, language: str) -> str:
    points = [(round(w["lat"], 5), round(w["lon"], 5)) for w in waypoints]
    return json.dumps([points, profile, alternates, language])


def _post(url: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        # "No path" (442) and "no edges near location" (171, i.e. outside the
        # Vietnam extract) both come back as 400 with a JSON body.
        if err.code == 400:
            raise NoRoute(_error_text(err)) from err
        raise RoutingUnavailable(f"valhalla HTTP {err.code}") from err
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        raise RoutingUnavailable(str(err)) from err


def _error_text(err: urllib.error.HTTPError) -> str:
    try:
        return str(json.loads(err.read()).get("error", "no route"))
    except (ValueError, OSError):
        return "no route"


def _normalize(trip: dict[str, Any]) -> dict[str, Any]:
    return {
        "distance_m": round(trip["summary"]["length"] * 1000),
        "duration_s": round(trip["summary"]["time"]),
        "legs": [
            {
                "shape": leg["shape"],
                "maneuvers": [
                    {
                        "instruction": m.get("instruction", ""),
                        "type": m.get("type", 0),
                        "distance_m": round(m.get("length", 0) * 1000),
                        "duration_s": round(m.get("time", 0)),
                        "begin_shape_index": m.get("begin_shape_index", 0),
                    }
                    for m in leg.get("maneuvers", [])
                ],
            }
            for leg in trip["legs"]
        ],
    }


async def route(
    waypoints: list[dict],
    profile: str = "motor_scooter",
    alternates: int = 2,
    language: str = "vi-VN",
) -> dict[str, Any]:
    url = base_url()
    if url is None:
        raise RoutingUnavailable("VALHALLA_URL is not set")
    # Valhalla only computes alternates between exactly two locations.
    if len(waypoints) > 2:
        alternates = 0
    key = _cache_key(waypoints, profile, alternates, language)
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    body = {
        "locations": [{"lat": w["lat"], "lon": w["lon"]} for w in waypoints],
        "costing": profile,
        "alternates": alternates,
        "directions_options": {"units": "kilometers", "language": language},
    }
    raw = await asyncio.to_thread(_post, f"{url}/route", body)
    trips = [raw["trip"], *(a["trip"] for a in raw.get("alternates", []))]
    result = {"routes": [_normalize(t) for t in trips]}
    _CACHE[key] = result
    if len(_CACHE) > CACHE_SIZE:
        _CACHE.popitem(last=False)
    return result
```

- [ ] **Step 5: Request schema + endpoint**

In `backend/friday/api/schemas.py` add (with `from typing import Literal` and `from friday.schemas.visualization import LatLon` if not already imported):

```python
class RouteRequest(BaseModel):
    """POST /geo/route — validated here so Valhalla only sees sane input."""

    waypoints: list[LatLon] = Field(min_length=2, max_length=5)
    profile: Literal["auto", "motor_scooter", "bicycle", "pedestrian"] = "motor_scooter"
```

In `backend/friday/api/routes.py`: add `RouteRequest` to the `friday.api.schemas` import, add `from fastapi.responses import JSONResponse` (extend the existing `fastapi.responses` import), `from friday.geo import valhalla`, and add above `@router.get("/health")`:

```python
@router.post("/geo/route", dependencies=[Depends(require_known_origin)])
async def geo_route(body: RouteRequest) -> Any:
    """Spec §6.3 — one route question for the map UI and nothing else.
    No model call behind it, so the origin gate is the only guard needed."""
    try:
        # Looked up on the module so tests can swap valhalla.route.
        return await valhalla.route([w.model_dump() for w in body.waypoints], body.profile)
    except valhalla.RoutingUnavailable:
        return JSONResponse(status_code=503, content={"error": "routing_unavailable"})
    except valhalla.NoRoute:
        return JSONResponse(status_code=422, content={"error": "no_route"})
```

- [ ] **Step 6: Local Valhalla + env**

Create `docker/valhalla/compose.yml`:

```yaml
# Local routing for the map's directions (spec §6.1). Dev only — Render's free
# plan cannot host it. First start downloads the Vietnam extract and builds
# tiles into the volume (~15–40 min, ~2–4 GB RAM peak); later starts are instant.
#   npm run dev:valhalla     then set VALHALLA_URL=http://localhost:8002 in backend/.env
services:
  valhalla:
    image: ghcr.io/valhalla/valhalla-scripted:latest
    ports:
      - "8002:8002"
    volumes:
      - valhalla-tiles:/custom_files
    environment:
      tile_urls: https://download.geofabrik.de/asia/vietnam-latest.osm.pbf
      build_elevation: "False"
      use_tiles_ignore_pbf: "True"
      serve_tiles: "True"
    restart: unless-stopped

volumes:
  valhalla-tiles:
```

In `package.json` scripts add: `"dev:valhalla": "docker compose -f docker/valhalla/compose.yml up -d"`.

Append to `backend/.env.example`:

```
# Directions (spec 2026-09-21 §6). Optional: unset = the map works but says
# "Chỉ đường chưa được cấu hình". Local: npm run dev:valhalla.
# VALHALLA_URL=http://localhost:8002

# MapTiler key for find_place / get_directions geocoding. Use a key WITHOUT an
# origin restriction — the browser key (NEXT_PUBLIC_MAPTILER_KEY) is
# origin-locked and MapTiler refuses it from a server.
# MAPTILER_SERVER_KEY=
```

- [ ] **Step 7: Run the tests**

Run: `python backend/runtests.py test_valhalla test_geo_route`
Expected: PASS (`all checks passed` twice).

- [ ] **Step 8: Commit**

```bash
git add backend/friday/geo backend/friday/api/schemas.py backend/friday/api/routes.py backend/.env.example backend/tests/unit/test_valhalla.py backend/tests/integration/test_geo_route.py docker/valhalla/compose.yml package.json
git commit -m "feat(geo): Valhalla routing client behind POST /geo/route"
```

---

### Task 4: Agent tools `find_place` / `get_directions` + map preview pinning

**Files:**
- Create: `backend/friday/geo/maptiler.py`, `backend/friday/geo/tools.py`
- Modify: `backend/friday/tools/registry.py`, `backend/friday/api/routes.py`
- Test: `backend/tests/unit/test_geo_tools.py`, `backend/tests/integration/test_map_preview_pin.py`

**Interfaces:**
- Consumes: `friday.geo.valhalla` (Task 3), `CLIENT` from `friday.tools.client.metrics`, `VisualizationPlan` (Task 1).
- Produces (`friday.geo.maptiler`): `class GeocodeUnavailable(Exception)`, `coarse(lat, lon) -> tuple[float, float]`, `async def search(query: str, near: tuple[float, float] | None = None, limit: int = 5) -> list[dict]` with items `{"label", "address", "category", "lat", "lon"}`.
- Produces (`friday.geo.tools`): `run_find_place`, `run_get_directions`, `preview_find_place`, `preview_get_directions`, `MY_LOCATION = "my_location"`, `DEFAULT_PROFILE = "motor_scooter"`.
- Produces (registry): tools `find_place`, `get_directions` (`risk="low"`, `capabilities=("geo.read",)`).

- [ ] **Step 1: Write the failing tool tests**

Create `backend/tests/unit/test_geo_tools.py`:

```python
"""find_place / get_directions with a fake geocoder and a fake Valhalla.

    PYTHONPATH=. python tests/unit/test_geo_tools.py
"""

import asyncio
import os
import urllib.parse

from friday.api.schemas import ClientContext
from friday.geo import maptiler, tools, valhalla
from friday.schemas.visualization import VisualizationPlan
from friday.tools import registry
from friday.tools.client import metrics as cm

HG = {"label": "Hồ Gươm", "address": "Hồ Hoàn Kiếm, Hà Nội", "category": "poi", "lat": 21.0288, "lon": 105.8525}
LB = {"label": "Lăng Bác", "address": "Ba Đình, Hà Nội", "category": "poi", "lat": 21.0368, "lon": 105.8346}
ROUTE = {"routes": [{"distance_m": 2412, "duration_s": 545, "legs": [{"shape": "x", "maneuvers": [
    {"instruction": f"Bước {i}", "type": 1, "distance_m": 10, "duration_s": 5, "begin_shape_index": i} for i in range(12)
]}]}]}


def run(coro, location=None):
    async def go():
        cm.CLIENT.set(ClientContext(location=location).model_dump(exclude_none=True) if location else {})
        return await coro

    return asyncio.run(go())


def fake(search_hits=None, route=None, route_exc=None):
    seen = {"search": [], "route": []}

    async def search(query, near=None, limit=5):
        seen["search"].append((query, near, limit))
        return (search_hits or {}).get(query, [])[:limit]

    async def route_fn(waypoints, profile="motor_scooter", alternates=2, language="vi-VN"):
        seen["route"].append((waypoints, profile))
        if route_exc:
            raise route_exc
        return route

    maptiler.search, valhalla.route = search, route_fn
    return seen


ORIG = (maptiler.search, valhalla.route)


def restore():
    maptiler.search, valhalla.route = ORIG


def test_find_place_returns_places_and_a_map_preview() -> None:
    seen = fake({"hồ gươm": [HG]})
    try:
        out = run(tools.run_find_place({"query": "hồ gươm"}))
    finally:
        restore()
    assert out == {"places": [HG]}, out
    assert seen["search"] == [("hồ gươm", None, 5)]
    spec = tools.preview_find_place(out)
    assert spec["type"] == "map" and spec["data"]["map"] == {"center": {"lat": 21.0288, "lon": 105.8525}, "zoom": 15}
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_find_place_many_results_frame_a_bbox() -> None:
    spec = tools.preview_find_place({"places": [HG, LB]})
    assert spec["data"]["map"] == {"bbox": [105.8346, 21.0288, 105.8525, 21.0368]}
    assert [p["label"] for p in spec["data"]["points"]] == ["Hồ Gươm", "Lăng Bác"]


def test_near_my_location_needs_a_shared_location() -> None:
    fake({"cafe": [HG]})
    try:
        assert run(tools.run_find_place({"query": "cafe", "near": "my_location"})) == tools.NO_LOCATION
        seen = fake({"cafe": [HG]})
        run(tools.run_find_place({"query": "cafe", "near": "my_location"}),
            location={"lat": 21.028812, "lon": 105.852499})
        assert seen["search"][0][1] == (21.028812, 105.852499)  # rounding happens in maptiler.search
    finally:
        restore()


def test_directions_default_to_motorbike_and_cap_steps() -> None:
    seen = fake({"hồ gươm": [HG], "lăng bác": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác"}))
    finally:
        restore()
    assert seen["route"] == [([{"lat": 21.0288, "lon": 105.8525}, {"lat": 21.0368, "lon": 105.8346}], "motor_scooter")]
    assert out["distance_km"] == 2.4 and out["duration_min"] == 9 and out["profile"] == "motor_scooter"
    assert out["steps"] == [f"Bước {i}" for i in range(8)]
    spec = tools.preview_get_directions(out)
    assert spec["data"]["map"]["route"] == {"profile": "motor_scooter", "waypoints": [
        {"lat": 21.0288, "lon": 105.8525, "label": "Hồ Gươm"},
        {"lat": 21.0368, "lon": 105.8346, "label": "Lăng Bác"},
    ]}
    assert [p["id"] for p in spec["data"]["points"]] == ["A", "B"]
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_directions_from_my_location() -> None:
    fake({"lăng bác": [LB]}, route=ROUTE)
    try:
        assert run(tools.run_get_directions({"from": "my_location", "to": "lăng bác"})) == tools.NO_LOCATION
        seen = fake({"lăng bác": [LB]}, route=ROUTE)
        out = run(tools.run_get_directions({"from": "my_location", "to": "lăng bác", "profile": "pedestrian"}),
                  location={"lat": 21.03, "lon": 105.85})
        assert out["from"]["label"] == "Vị trí của bạn" and seen["route"][0][1] == "pedestrian"
    finally:
        restore()


def test_directions_errors_are_error_dicts() -> None:
    try:
        fake({"a": [HG], "b": [LB]}, route_exc=valhalla.RoutingUnavailable("unset"))
        assert "not configured" in run(tools.run_get_directions({"from": "a", "to": "b"}))["error"]
        fake({"a": [HG], "b": [LB]}, route_exc=valhalla.NoRoute("442"))
        assert "Vietnam" in run(tools.run_get_directions({"from": "a", "to": "b"}))["error"]
        fake({"a": [HG]}, route=ROUTE)
        assert "nowhere" in run(tools.run_get_directions({"from": "a", "to": "nowhere"}))["error"]
        assert "profile" in run(tools.run_get_directions({"from": "a", "to": "a", "profile": "rocket"}))["error"]
    finally:
        restore()


def test_maptiler_sends_only_a_coarse_position() -> None:
    captured = []
    orig_get = maptiler._get
    maptiler._get = lambda url: captured.append(url) or {"features": [
        {"text": "Hồ Gươm", "place_name": "Hồ Gươm, Hà Nội", "center": [105.8525, 21.0288], "place_type": ["poi"]},
    ]}
    old = os.environ.get("MAPTILER_SERVER_KEY")
    os.environ["MAPTILER_SERVER_KEY"] = "k"
    try:
        hits = asyncio.run(maptiler.search("hồ gươm", near=(21.028812, 105.852499)))
    finally:
        maptiler._get = orig_get
        if old is None:
            os.environ.pop("MAPTILER_SERVER_KEY", None)
        else:
            os.environ["MAPTILER_SERVER_KEY"] = old
    q = urllib.parse.parse_qs(urllib.parse.urlparse(captured[0]).query)
    assert q["proximity"] == ["105.85,21.03"], q
    assert hits == [{"label": "Hồ Gươm", "address": "Hồ Gươm, Hà Nội", "category": "poi", "lat": 21.0288, "lon": 105.8525}]


def test_maptiler_without_a_key_is_unavailable() -> None:
    old = os.environ.pop("MAPTILER_SERVER_KEY", None)
    try:
        asyncio.run(maptiler.search("x"))
    except maptiler.GeocodeUnavailable:
        pass
    else:
        raise AssertionError("no key must be GeocodeUnavailable")
    finally:
        if old is not None:
            os.environ["MAPTILER_SERVER_KEY"] = old


def test_registered_low_risk_geo_read() -> None:
    for name in ("find_place", "get_directions"):
        tool = registry.get(name)
        assert tool is not None and tool.risk == "low" and tool.capabilities == ("geo.read",), name
        assert tool.preview is not None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

- [ ] **Step 2: Write the failing pin test**

Read `test_run_query_transcript_validates_against_contracts` in `backend/tests/unit/test_contracts.py` first — this test reuses its patching pattern (`agent.run`, `routes.plan`, `main.run_query`). Create `backend/tests/integration/test_map_preview_pin.py`:

```python
"""A map preview is the final visualization — the planner never re-plans it.

    PYTHONPATH=. python tests/integration/test_map_preview_pin.py
"""

import asyncio
import json

from friday import agent, main
from friday.api import routes

PREVIEW = {
    "type": "map",
    "title": "CHỈ ĐƯỜNG",
    "data": {"map": {"route": {"profile": "motor_scooter", "waypoints": [
        {"lat": 21.0288, "lon": 105.8525, "label": "Hồ Gươm"},
        {"lat": 21.0368, "lon": 105.8346, "label": "Lăng Bác"},
    ]}}},
}


def test_map_preview_skips_the_planner() -> None:
    async def fake_agent(query, approve, result, history=(), memories="", emit_steps=False):
        yield agent.AgentEvent("tool", {"tool": "get_directions", "risk": "low"})
        yield agent.AgentEvent("preview", PREVIEW)
        result.text = "Khoảng 2,4 km, chừng 9 phút đi xe máy."

    async def planner_must_not_run(*_args, **_kwargs):
        raise AssertionError("the planner re-planned a map preview")

    async def drain():
        return [c async for c in main.run_query("chỉ đường tới lăng bác")]

    original_agent, agent.run = agent.run, fake_agent
    original_plan, routes.plan = routes.plan, planner_must_not_run
    try:
        chunks = asyncio.run(drain())
    finally:
        agent.run, routes.plan = original_agent, original_plan

    text = "".join(c if isinstance(c, str) else c.decode() for c in chunks)
    vizzes = [json.loads(line[len("data: "):]) for block in text.split("\n\n")
              if "event: viz" in block for line in block.splitlines() if line.startswith("data: ")]
    assert len(vizzes) == 2, vizzes  # the preview, then the same map as the final spec
    final = vizzes[-1]
    assert final["type"] == "map" and final["interaction"] == "drill_down"
    assert final["data"] == PREVIEW["data"]
    assert "2,4 km" in text


if __name__ == "__main__":
    test_map_preview_skips_the_planner()
    print("  ok  test_map_preview_skips_the_planner\nall checks passed")
```

If `main.run_query` yields frames in a different shape than `event: …\ndata: …` blocks (check `friday/events/serializer.py`'s `sse`), adapt only the parsing lines, not the assertions.

- [ ] **Step 3: Run to watch them fail**

Run: `python backend/runtests.py test_geo_tools test_map_preview_pin`
Expected: FAIL — `ImportError` for `friday.geo.maptiler` / `tools`; the pin test fails with "the planner re-planned a map preview".

- [ ] **Step 4: Implement `backend/friday/geo/maptiler.py`**

```python
"""MapTiler geocoding for the agent tools (spec §6.4).

Server key MAPTILER_SERVER_KEY: the browser key is origin-locked and MapTiler
refuses it from a server. Only a ~1 km position ever leaves for proximity
bias (spec §6.5) — full precision stays on this side.
"""

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE = "https://api.maptiler.com/geocoding"
TIMEOUT_S = 8.0


class GeocodeUnavailable(Exception):
    """No key, network failure or a MapTiler error."""


def coarse(lat: float, lon: float) -> tuple[float, float]:
    return round(lat, 2), round(lon, 2)


def _get(url: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        raise GeocodeUnavailable(str(err)) from err


def _place(feature: dict[str, Any]) -> dict[str, Any]:
    lon, lat = feature["center"][:2]
    return {
        "label": feature.get("text") or feature.get("place_name", ""),
        "address": feature.get("place_name", ""),
        "category": (feature.get("place_type") or [None])[0],
        "lat": lat,
        "lon": lon,
    }


async def search(query: str, near: tuple[float, float] | None = None, limit: int = 5) -> list[dict[str, Any]]:
    key = os.getenv("MAPTILER_SERVER_KEY")
    if not key:
        raise GeocodeUnavailable("MAPTILER_SERVER_KEY is not set")
    params = {"key": key, "language": "vi", "limit": str(limit)}
    if near is not None:
        lat, lon = coarse(*near)
        params["proximity"] = f"{lon},{lat}"
    url = f"{BASE}/{urllib.parse.quote(query)}.json?{urllib.parse.urlencode(params)}"
    raw = await asyncio.to_thread(_get, url)
    return [_place(f) for f in raw.get("features", []) if f.get("center")][:limit]
```

- [ ] **Step 5: Implement `backend/friday/geo/tools.py`**

```python
"""find_place / get_directions (spec §6.4) — read-only: geo.read, low risk.

Each returns an error dict rather than raising, like every other tool, and a
`map` preview that the orchestrator passes through unchanged (routes.py).
"""

from typing import Any

from friday.tools.client.metrics import CLIENT

from . import maptiler, valhalla

MY_LOCATION = "my_location"
DEFAULT_PROFILE = "motor_scooter"
MAX_STEPS = 8
NO_LOCATION = {"error": "the operator has not shared their location"}


def _operator() -> tuple[float, float] | None:
    loc = (CLIENT.get() or {}).get("location")
    return (loc["lat"], loc["lon"]) if loc else None


def _is_me(ref: Any) -> bool:
    return str(ref).strip().lower() == MY_LOCATION


async def _first(query: str, near: tuple[float, float] | None) -> dict[str, Any] | None:
    # Looked up on the module so tests can swap maptiler.search.
    hits = await maptiler.search(query, near=near, limit=1)
    return hits[0] if hits else None


async def run_find_place(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("query", "")).strip()
    if not query:
        return {"error": "query is required"}
    near_ref = payload.get("near")
    near: tuple[float, float] | None = None
    try:
        if near_ref and _is_me(near_ref):
            near = _operator()
            if near is None:
                return NO_LOCATION
        elif near_ref:
            anchor = await _first(str(near_ref), None)
            if anchor is None:
                return {"error": f"no place matches '{near_ref}'"}
            near = (anchor["lat"], anchor["lon"])
        places = await maptiler.search(query, near=near)
    except maptiler.GeocodeUnavailable as err:
        return {"error": f"place search unavailable: {err}"}
    if not places:
        return {"error": f"no place matches '{query}'"}
    return {"places": places}


async def run_get_directions(payload: dict[str, Any]) -> dict[str, Any]:
    profile = payload.get("profile") or DEFAULT_PROFILE
    if profile not in valhalla.PROFILES:
        return {"error": f"unknown profile '{profile}'"}
    refs = [payload.get("from"), *list(payload.get("via") or [])[:3], payload.get("to")]
    if not refs[0] or not refs[-1]:
        return {"error": "from and to are required"}
    me = _operator()
    if me is None and any(_is_me(r) for r in refs):
        return NO_LOCATION
    stops: list[dict[str, Any]] = []
    try:
        for ref in refs:
            if _is_me(ref):
                stops.append({"label": "Vị trí của bạn", "lat": me[0], "lon": me[1]})
                continue
            place = await _first(str(ref), me)
            if place is None:
                return {"error": f"no place matches '{ref}'"}
            stops.append(place)
        result = await valhalla.route([{"lat": s["lat"], "lon": s["lon"]} for s in stops], profile)
    except maptiler.GeocodeUnavailable as err:
        return {"error": f"place search unavailable: {err}"}
    except valhalla.RoutingUnavailable:
        return {"error": "routing is not configured on this server"}
    except valhalla.NoRoute:
        return {"error": "no route found (directions cover Vietnam only)"}
    best = result["routes"][0]
    return {
        "from": stops[0],
        "to": stops[-1],
        "via": stops[1:-1],
        "profile": profile,
        "distance_km": round(best["distance_m"] / 1000, 1),
        "duration_min": round(best["duration_s"] / 60),
        "steps": [m["instruction"] for leg in best["legs"] for m in leg["maneuvers"]][:MAX_STEPS],
    }


def _point(place: dict[str, Any], point_id: str) -> dict[str, Any]:
    return {"id": point_id, "label": place["label"], "lat": place["lat"], "lon": place["lon"]}


def preview_find_place(output: dict[str, Any]) -> dict[str, Any]:
    places = output["places"]
    lats = [p["lat"] for p in places]
    lons = [p["lon"] for p in places]
    if min(lats) == max(lats) and min(lons) == max(lons):
        view: dict[str, Any] = {"center": {"lat": lats[0], "lon": lons[0]}, "zoom": 15}
    else:
        view = {"bbox": [min(lons), min(lats), max(lons), max(lats)]}
    return {
        "type": "map",
        "title": places[0]["label"].upper()[:40],
        "data": {"points": [_point(p, f"p{i}") for i, p in enumerate(places)], "map": view},
    }


def preview_get_directions(output: dict[str, Any]) -> dict[str, Any]:
    stops = [output["from"], *output["via"], output["to"]]
    last = len(stops) - 1
    ids = ["A" if i == 0 else "B" if i == last else f"V{i}" for i in range(len(stops))]
    return {
        "type": "map",
        "title": "CHỈ ĐƯỜNG",
        "data": {
            "points": [_point(s, ids[i]) for i, s in enumerate(stops)],
            "map": {"route": {
                "profile": output["profile"],
                "waypoints": [{"lat": s["lat"], "lon": s["lon"], "label": s["label"]} for s in stops],
            }},
        },
    }
```

- [ ] **Step 6: Register the tools**

In `backend/friday/tools/registry.py` add the import:

```python
from friday.geo.tools import (
    preview_find_place,
    preview_get_directions,
    run_find_place,
    run_get_directions,
)
```

and append to the `tools` list in `_build_default_registry` (after `get_client_location`):

```python
        Tool(
            name="find_place",
            description=(
                "Find a place, address or kind of place and show it on the street "
                "map. Use for 'where is X', 'show me X', 'cafes near me'. Pass "
                "near='my_location' for places around the operator."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "what to find, in the user's words"},
                    "near": {"type": "string", "description": "'my_location' or a place name to search around"},
                },
                "required": ["query"],
            },
            # Reads a public geocoder; the only operator data sent is a ~1 km
            # position, and only when they already shared their location.
            risk="low",
            run=run_find_place,
            capabilities=("geo.read",),
            preview=preview_find_place,
            timeout_s=15,
        ),
        Tool(
            name="get_directions",
            description=(
                "Directions between places in Vietnam, shown on the street map "
                "with distance and time. from/to are place names or "
                "'my_location'. profile: motor_scooter (default, xe máy), auto "
                "(car), bicycle, pedestrian."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "profile": {"type": "string", "enum": ["motor_scooter", "auto", "bicycle", "pedestrian"]},
                    "via": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
                },
                "required": ["from", "to"],
            },
            risk="low",
            run=run_get_directions,
            capabilities=("geo.read",),
            preview=preview_get_directions,
            timeout_s=25,
        ),
```

- [ ] **Step 7: Pin map previews in `routes.py`**

In the streaming function in `backend/friday/api/routes.py`:
- next to `pinned_type: str | None = None` add `last_preview: dict[str, Any] | None = None`;
- in the `if event.kind == "preview":` branch add `last_preview = event.payload` before the `yield`;
- replace `result = await plan(query, outcome.text, outcome.evidence, pinned_type)` with:

```python
        if pinned_type == "map" and last_preview is not None:
            # A map preview is already the final answer: its waypoints came
            # from the geocoder, and re-planning would let the model rewrite
            # coordinates it never measured (spec 2026-09-21 §5).
            viz_payload = {**last_preview, "animation": "materialize", "interaction": "drill_down"}
            planned_answer = "Here is the map."
        else:
            result = await plan(query, outcome.text, outcome.evidence, pinned_type)
            viz_payload = result.model_dump(exclude={"answer"}, exclude_none=True)
            planned_answer = result.answer
```

- replace `yield ("viz", result.model_dump(exclude={"answer"}, exclude_none=True))` with `yield ("viz", viz_payload)` and `answer = outcome.text or result.answer` with `answer = outcome.text or planned_answer`.

- [ ] **Step 8: Run the backend suite**

Run: `python backend/runtests.py test_geo_tools test_map_preview_pin test_contracts test_policy`
Expected: PASS. Then `python backend/runtests.py` (whole suite) — expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/friday/geo backend/friday/tools/registry.py backend/friday/api/routes.py backend/tests/unit/test_geo_tools.py backend/tests/integration/test_map_preview_pin.py
git commit -m "feat(geo): find_place and get_directions tools with pinned map previews"
```

---

### Task 5: Map foundations — dependency, CSP, env, `mapApi.ts`

**Files:**
- Create: `src/components/friday/map/mapApi.ts`
- Modify: `package.json` / `package-lock.json` (via npm), `src/proxy.ts`, `.env.example`, `playwright.config.ts`
- Test: `tests/unit/mapApi.spec.ts`

**Interfaces:**
- Consumes: `getApiBase` (`@/lib/api/session`), `MapProfile` (Task 1).
- Produces (`@/components/friday/map/mapApi`): `MAPTILER_KEY`, `type MapStyleId = "dark" | "light" | "satellite" | "terrain"`, `styleUrl(id)`, `interface Place { label; address; category?; lat; lon }`, `interface Endpoint { lat; lon; label }`, `parseGeocoding(json): Place[]`, `searchPlaces(query, near, signal?)`, `reverseGeocode(lat, lon, signal?)`, `interface Maneuver`, `interface RouteLeg { shape; maneuvers }`, `interface Route { distance_m; duration_s; legs }`, `type RouteResult = {ok:true; routes: Route[]} | {ok:false; reason: "unavailable" | "no_route" | "error"}`, `fetchRoute(stops: Endpoint[], profile, signal?)`, `decodePolyline6(encoded): [number, number][]`, `routeCoordinates(route)`, `maneuverCoordinate(route, legIndex, maneuverIndex)`, `stepCoordinates(route, legIndex, maneuverIndex)`, `formatDistance(m)`, `formatDuration(s)`, `PROFILE_LABELS`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mapApi.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run to watch it fail**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Install the dependency**

Run: `npm install maplibre-gl@^6.10.0`
Expected: `package.json` dependencies gain `"maplibre-gl": "^6.10.0"`.

- [ ] **Step 4: Implement `src/components/friday/map/mapApi.ts`**

```ts
/**
 * Everything the map talks to (spec §4.3): MapTiler styles + geocoding
 * (browser key, origin-restricted) and the orchestrator's /geo/route.
 * Pure helpers (decode, format, parse) are unit-tested.
 */
import { getApiBase } from "@/lib/api/session";
import type { MapProfile } from "@/lib/visualization/types";

export const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";

export type MapStyleId = "dark" | "light" | "satellite" | "terrain";

const STYLE_PATH: Record<MapStyleId, string> = {
  dark: "streets-v2-dark",
  light: "streets-v2",
  satellite: "hybrid",
  terrain: "outdoor-v2",
};

export function styleUrl(id: MapStyleId): string {
  return `https://api.maptiler.com/maps/${STYLE_PATH[id]}/style.json?key=${encodeURIComponent(MAPTILER_KEY)}`;
}

export const PROFILE_LABELS: Record<MapProfile, string> = {
  motor_scooter: "🛵 Xe máy",
  auto: "🚗 Ô tô",
  bicycle: "🚲 Xe đạp",
  pedestrian: "🚶 Đi bộ",
};

// ---------- geocoding ----------

export interface Place {
  label: string;
  address: string;
  category?: string;
  lat: number;
  lon: number;
}

/** A directions stop: a place with a display label. */
export interface Endpoint {
  lat: number;
  lon: number;
  label: string;
}

export function parseGeocoding(json: unknown): Place[] {
  const features = (json as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  return features.flatMap((f) => {
    const feat = f as { center?: unknown; text?: unknown; place_name?: unknown; place_type?: unknown };
    const c = feat.center;
    if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return [];
    const address = typeof feat.place_name === "string" ? feat.place_name : "";
    const label = typeof feat.text === "string" && feat.text ? feat.text : address;
    const category =
      Array.isArray(feat.place_type) && typeof feat.place_type[0] === "string" ? feat.place_type[0] : undefined;
    return [{ label, address, category, lat: c[1], lon: c[0] }];
  });
}

/** `near` is rounded to ~1 km before it leaves the browser (spec §6.5). */
export async function searchPlaces(
  query: string,
  near: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<Place[]> {
  const params = new URLSearchParams({ key: MAPTILER_KEY, language: "vi", limit: "6", autocomplete: "true" });
  if (near) params.set("proximity", `${near.lon.toFixed(2)},${near.lat.toFixed(2)}`);
  const res = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?${params}`, { signal });
  if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`);
  return parseGeocoding(await res.json());
}

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<Place | null> {
  const params = new URLSearchParams({ key: MAPTILER_KEY, language: "vi" });
  const res = await fetch(`https://api.maptiler.com/geocoding/${lon},${lat}.json?${params}`, { signal });
  if (!res.ok) return null;
  return parseGeocoding(await res.json())[0] ?? null;
}

// ---------- routing ----------

export interface Maneuver {
  instruction: string;
  type: number;
  distance_m: number;
  duration_s: number;
  begin_shape_index: number;
}

export interface RouteLeg {
  shape: string;
  maneuvers: Maneuver[];
}

export interface Route {
  distance_m: number;
  duration_s: number;
  legs: RouteLeg[];
}

export type RouteResult =
  | { ok: true; routes: Route[] }
  | { ok: false; reason: "unavailable" | "no_route" | "error" };

export async function fetchRoute(stops: Endpoint[], profile: MapProfile, signal?: AbortSignal): Promise<RouteResult> {
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}/geo/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ waypoints: stops.map(({ lat, lon }) => ({ lat, lon })), profile }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // Orchestrator offline reads the same as routing off: nothing to retry here.
    return { ok: false, reason: "unavailable" };
  }
  if (res.status === 503) return { ok: false, reason: "unavailable" };
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, reason: body?.error === "no_route" ? "no_route" : "error" };
  }
  const body = (await res.json()) as { routes?: Route[] };
  return { ok: true, routes: body.routes ?? [] };
}

/** Valhalla's encoded polyline (precision 6) → [lon, lat] pairs, GeoJSON order. */
export function decodePolyline6(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (let axis = 0; axis < 2; axis++) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

export function routeCoordinates(route: Route): [number, number][] {
  return route.legs.flatMap((leg) => decodePolyline6(leg.shape));
}

/** Where one maneuver happens — `begin_shape_index` is relative to its own leg. */
export function maneuverCoordinate(route: Route, legIndex: number, maneuverIndex: number): [number, number] | null {
  const leg = route.legs[legIndex];
  const m = leg?.maneuvers[maneuverIndex];
  if (!m) return null;
  return decodePolyline6(leg.shape)[m.begin_shape_index] ?? null;
}

/** The stretch one step covers: its maneuver up to the next one (or the leg's end). */
export function stepCoordinates(route: Route, legIndex: number, maneuverIndex: number): [number, number][] {
  const leg = route.legs[legIndex];
  const m = leg?.maneuvers[maneuverIndex];
  if (!m) return [];
  const coords = decodePolyline6(leg.shape);
  const end = leg.maneuvers[maneuverIndex + 1]?.begin_shape_index ?? coords.length - 1;
  return coords.slice(m.begin_shape_index, end + 1);
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} km`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} phút`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} giờ ${m} phút` : `${h} giờ`;
}
```

- [ ] **Step 5: CSP, env, test build env**

In `src/proxy.ts` change the CSP lines to:

```
    img-src 'self' data: blob: https://api.maptiler.com;
    worker-src 'self' blob:;
```

(`worker-src` is new; `connect-src` already allows `https:`, which covers MapTiler tiles/styles/geocoding.) Add a one-line comment above the template: `// img-src/worker-src: MapLibre sprites from MapTiler and its blob-module worker (spec §4.4).`

Append to `.env.example`:

```
# Street map (MapLibre + MapTiler). Client-visible by design: restrict the key
# to your site's origins in the MapTiler dashboard. Without it the map opens
# blank. Directions also need VALHALLA_URL on the backend (backend/.env.example).
# NEXT_PUBLIC_MAPTILER_KEY=
```

In `playwright.config.ts` `webServer.env` add:

```ts
          // Any non-empty key: the map UI tests stub api.maptiler.com with
          // page.route, so no real key (and no network) is involved.
          NEXT_PUBLIC_MAPTILER_KEY: "test-key",
```

- [ ] **Step 6: Run the tests**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts tests/unit/permissionsPolicy.spec.ts`
Expected: PASS. Then `npm run typecheck` — expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/components/friday/map/mapApi.ts src/proxy.ts .env.example playwright.config.ts tests/unit/mapApi.spec.ts
git commit -m "feat(map): maplibre-gl, MapTiler/route clients and CSP for the map"
```

---

### Task 6: Map stage and the globe handoff

**Files:**
- Create: `src/components/friday/map/MapIsland.tsx`, `src/components/friday/map/MapLayer.tsx`, `src/components/friday/map/map.css`
- Modify: `src/app/page.tsx`, `src/app/globals.css`, `src/components/friday/hud/{VizRail,StateRail,EdgeTelemetry}.tsx`, `src/components/friday/Scene.tsx`, `src/components/friday/visualization/globe/useGlobeInteraction.ts`, `src/components/friday/visualization/globe/GlobeVisualization.tsx`
- Test: `tests/ui/map.spec.ts`

**Interfaces:**
- Consumes: store `mapView/openMap/closeMap/settleMap`, `pushOverZoom`, `HANDOFF_ZOOM/ARRIVAL_ZOOM/LEAVE_ZOOM` (Task 2), `viewCenterFromAngles` (Task 2), `styleUrl`, `Place`, `Endpoint` (Task 5), `shareLocation` (`@/lib/geolocation`), `useReducedMotion` (`@/lib/useReducedMotion`), `STATUS_COLORS`, `markerLabel`, `statusOf` (`globe/geo`), `devRailsEnabled`.
- Produces: DOM contract used by Tasks 7–8 and tests — `[data-testid="map-layer"][data-mode]`, button `aria-label="Quay lại địa cầu"`; slots in `MapLayer.tsx` where Task 7 mounts `MapSearch`/`PlacePanel`/`ContextMenu` and Task 8 mounts `DirectionsPanel`; `window.__fridayMap` (dev rails only); `DirectionsValue` state `{ profile: MapProfile; stops: (Endpoint | null)[] } | null` held in `MapStage`.

- [ ] **Step 1: Write the failing UI tests**

Create `tests/ui/map.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";
import { gotoLitScene } from "./helpers";

/**
 * Street map (spec 2026-09-21). api.maptiler.com is stubbed: a background-only
 * style is enough for real MapLibre to load in Chromium without the network.
 */
const STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#0b1620" } }],
};

export async function stubMapTiler(page: Page, geocode: unknown = { features: [] }) {
  await page.route("https://api.maptiler.com/maps/**", (r) => r.fulfill({ json: STYLE }));
  await page.route("https://api.maptiler.com/geocoding/**", (r) => r.fulfill({ json: geocode }));
}

const layer = (page: Page) => page.getByTestId("map-layer");

test("an agent map spec opens the map; Esc hands back to the globe", async ({ page }) => {
  await stubMapTiler(page);
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  await expect(page.locator("html")).toHaveAttribute("data-map", "on");
  await page.keyboard.press("Escape");
  await expect(layer(page)).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator("html")).toHaveAttribute("data-map", "off");
});

test("zooming the globe past its limit hands off to the map", async ({ page }) => {
  await stubMapTiler(page);
  await gotoLitScene(page);
  await page.click(`#viz-rail button:has-text("GLOBE")`);
  await page.waitForTimeout(2000);
  const size = page.viewportSize()!;
  await page.mouse.move(size.width / 2, size.height / 2);
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(40);
  }
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 15_000 });
  await page.getByRole("button", { name: "Quay lại địa cầu" }).click();
  await expect(layer(page)).toHaveCount(0, { timeout: 5_000 });
});

test("reduced motion shortens the handoff to a quick fade", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubMapTiler(page);
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  expect(await layer(page).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.15s");
});
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts`
Expected: FAIL — `map-layer` never appears (builds the app first; takes a few minutes).

- [ ] **Step 3: `MapIsland.tsx`**

```tsx
"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useFridayStore } from "@/lib/store";

/** maplibre-gl loads only the first time the map opens (spec §4.4). */
const MapStage = dynamic(() => import("./MapLayer"), {
  ssr: false,
  loading: () => (
    <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 rounded-full bg-slate-900/80 px-3 py-1 text-xs text-cyan-100">
      Đang tải bản đồ…
    </div>
  ),
});

export default function MapIsland() {
  const mode = useFridayStore((s) => s.mapView.mode);
  useEffect(() => {
    // globals.css hides the decorative HUD layers while this is "on" (spec §4.1).
    document.documentElement.dataset.map = mode === "globe" ? "off" : "on";
  }, [mode]);
  return mode === "globe" ? null : <MapStage />;
}
```

- [ ] **Step 4: `MapLayer.tsx` (the stage)**

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Map as MlMap, Marker, NavigationControl, ScaleControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { useFridayStore } from "@/lib/store";
import { shareLocation } from "@/lib/geolocation";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { ARRIVAL_ZOOM, HANDOFF_ZOOM, LEAVE_ZOOM } from "@/lib/mapView";
import type { MapProfile } from "@/lib/visualization/types";
import { STATUS_COLORS, markerLabel, statusOf } from "../visualization/globe/geo";
import { devRailsEnabled } from "../hud/devRails";
import { styleUrl, type Endpoint, type MapStyleId, type Place } from "./mapApi";

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
  { id: "terrain", label: "Địa hình" },
];

/** Prefer `name:vi` on label layers that show a name (spec §4.1); keep refs/numbers as they are. */
function preferVietnameseLabels(map: MlMap) {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== "symbol") continue;
    const field = map.getLayoutProperty(layer.id, "text-field");
    if (!field || !JSON.stringify(field).includes("name")) continue;
    map.setLayoutProperty(layer.id, "text-field", ["coalesce", ["get", "name:vi"], ["get", "name"]]);
  }
}

/** Toggle the style's own extrusions, or add one over OpenMapTiles `building` if it has none. */
function setBuildings3d(map: MlMap, on: boolean) {
  const style = map.getStyle();
  const own = style.layers.filter((l) => l.type === "fill-extrusion").map((l) => l.id);
  if (own.length === 0 && on) {
    const vector = Object.entries(style.sources).find(([, s]) => s.type === "vector")?.[0];
    if (vector) {
      map.addLayer({
        id: "friday-buildings-3d",
        type: "fill-extrusion",
        source: vector,
        "source-layer": "building",
        minzoom: 14,
        paint: {
          "fill-extrusion-color": "#1c2b3a",
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.85,
        },
      });
    }
  } else {
    for (const id of own) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
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
  const [place, setPlace] = useState<Place | null>(null);
  const [directions, setDirections] = useState<DirectionsValue | null>(null);
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
    });
    m.addControl(new NavigationControl({ visualizePitch: true }), "bottom-right");
    m.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    let loaded = false;
    const slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    m.on("style.load", () => {
      m.setProjection({ type: "globe" });
      preferVietnameseLabels(m);
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
      if (directions) setDirections(null);
      else if (place) setPlace(null);
      else leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [directions, place, leave]);

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
    map?.setStyle(styleUrl(id));
  };

  const visible = ready && (mode === "entering" || mode === "map");
  const duration = reduced ? REDUCED_MS : mode === "leaving" ? LEAVE_MS : ENTER_MS;

  return (
    <div
      data-testid="map-layer"
      data-mode={mode}
      className="friday-map absolute inset-0"
      style={{
        opacity: visible ? 1 : 0,
        filter: visible || reduced ? "none" : "blur(12px)",
        transform: visible || reduced ? "none" : "scale(1.04)",
        transitionDuration: `${duration}ms`,
        pointerEvents: mode === "leaving" ? "none" : "auto",
      }}
    >
      <div ref={containerRef} className="absolute inset-0" />

      <div className="absolute left-4 top-16 z-10 flex items-start gap-2">
        <button type="button" className="friday-map-chip" aria-label="Quay lại địa cầu" onClick={leave}>
          ← Địa cầu
        </button>
        {/* Task 7 mounts MapSearch here; Task 8 adds the directions toggle. */}
      </div>

      {/* Task 7 mounts PlacePanel / ContextMenu here; Task 8 mounts DirectionsPanel. */}

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
```

`place` / `setPlace` / `directions` / `setDirections` are unused until Tasks 7–8 beyond what is shown; if ESLint's `no-unused-vars` flags nothing, leave as is.

- [ ] **Step 5: `map.css`**

```css
/* Street map (spec §4). Tailwind styles the panels; this file only covers
   what Tailwind cannot reach: MapLibre's own controls, DOM markers, the
   handoff transition. */

.friday-map {
  transition-property: opacity, filter, transform;
  transition-timing-function: cubic-bezier(0.2, 0.7, 0.2, 1);
  background: #02050a;
}

.friday-map-chip,
.friday-map-fab,
.friday-map-panel,
.friday-map .maplibregl-ctrl-group {
  background: rgb(8 20 30 / 0.82);
  backdrop-filter: blur(10px);
  border: 1px solid rgb(56 232 255 / 0.25);
  color: #e5f6ff;
  box-shadow: 0 4px 18px rgb(0 0 0 / 0.45);
}

.friday-map-chip {
  border-radius: 9999px;
  padding: 0.45rem 0.9rem;
  font-size: 0.8rem;
}

.friday-map-panel {
  border-radius: 12px;
}

.friday-map-fab {
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  font-size: 1.1rem;
}

.friday-map .maplibregl-ctrl-group {
  border-radius: 10px;
}
.friday-map .maplibregl-ctrl-group button + button {
  border-top-color: rgb(56 232 255 / 0.18);
}
.friday-map .maplibregl-ctrl-icon {
  filter: invert(1) hue-rotate(180deg);
}
.friday-map .maplibregl-ctrl-scale {
  background: rgb(8 20 30 / 0.7);
  color: #e5f6ff;
  border-color: #38e8ff;
}
.friday-map .maplibregl-ctrl-attrib {
  background: rgb(8 20 30 / 0.7);
  color: #9fb8c6;
}
.friday-map .maplibregl-ctrl-attrib a {
  color: #9fb8c6;
}

.friday-map-pin {
  width: 18px;
  height: 18px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--pin, #38e8ff);
  border: 2px solid #eafcff;
  box-shadow: 0 0 12px var(--pin, #38e8ff);
  cursor: pointer;
}

.friday-map-me {
  width: 16px;
  height: 16px;
  border-radius: 9999px;
  background: #4a8cff;
  border: 2px solid #fff;
  box-shadow: 0 0 0 calc(var(--halo, 18px) / 2) rgb(74 140 255 / 0.18);
}

.friday-map-stop {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 9999px;
  background: #38e8ff;
  color: #02050a;
  font-weight: 700;
  font-size: 0.8rem;
  border: 2px solid #eafcff;
  cursor: grab;
}
```

- [ ] **Step 6: Page wiring and HUD hiding**

In `src/app/page.tsx`: import `MapIsland from "@/components/friday/map/MapIsland";`, render `<MapIsland />` directly after `<SceneIsland />`, and add `data-map-hide` to both overlay divs:

```tsx
      <SceneIsland />
      <MapIsland />
      <div data-map-hide className="scan-bar pointer-events-none absolute inset-0" />
      <div data-map-hide className="vignette pointer-events-none absolute inset-0" />
```

Add `data-map-hide` to the root element returned by `VizRail` (`#viz-rail` div), `StateRail` (`#state-rail`), and `EdgeTelemetry`.

Append to `src/app/globals.css`:

```css
/* Street map mode (spec §4.1): decorative layers would sit on top of the map. */
html[data-map="on"] [data-map-hide],
html[data-map="on"] .scanlines::before {
  display: none;
}
```

- [ ] **Step 7: Canvas frameloop**

In `src/components/friday/Scene.tsx` (the component that renders `<Canvas>`), add `const mapMode = useFridayStore((s) => s.mapView.mode);` and the prop:

```tsx
      // The map covers the scene once it has landed; stop spending GPU on
      // frames nobody sees (spec §3.3). Entering/leaving keep animating.
      frameloop={mapMode === "map" ? "demand" : "always"}
```

- [ ] **Step 8: Globe side of the handoff**

In `src/components/friday/visualization/globe/useGlobeInteraction.ts`:

1. Imports: `import type { GeoPoint } from "@/lib/store";`, `import { HANDOFF_ZOOM, pushOverZoom, type OverZoom } from "@/lib/mapView";`, and add `viewCenterFromAngles` to the `./geo` import.
2. Below `MIN_DIST` add:

```ts
/** How far the camera dives while the map crossfades in — past MIN_DIST on purpose (spec §3.3). */
const ENTER_DIST = 3.2;
```

3. Add `getPoints?: () => GeoPoint[];` to the options object type (documented: `/** Points the map should keep showing after the handoff. */`) and destructure it.
4. After `const didInitDist = useRef(false);` add:

```ts
  const overZoom = useRef<OverZoom>({ amount: 0, at: 0 });
```

5. After `focusOn` is defined, add:

```ts
  /** Input that keeps pushing inward at MIN_DIST accumulates toward the map handoff (spec §3.2). */
  const pushPastLimit = useCallback(
    (push: number) => {
      const store = useFridayStore.getState();
      if (store.mapView.mode !== "globe") return;
      const { next, fire } = pushOverZoom(overZoom.current, push, performance.now());
      overZoom.current = next;
      if (!fire) return;
      const center = getFocusTarget?.() ?? viewCenterFromAngles(yaw.current, pitch.current);
      store.openMap({ center, zoom: HANDOFF_ZOOM, source: "zoom", points: getPoints?.() });
    },
    [getFocusTarget, getPoints],
  );

  // Coming back from the map: face where the map was looking.
  useEffect(
    () =>
      useFridayStore.subscribe((s, prev) => {
        if (s.mapView.mode === "leaving" && prev.mapView.mode !== "leaving") focusOn(s.mapView.center);
      }),
    [focusOn],
  );
```

6. In the keyboard handler, first line inside `onKey`: `if (useFridayStore.getState().mapView.mode !== "globe") return; // the map owns the keyboard (spec §3.6)`. In the `"+"`/`"="` case, before changing `distTarget`, add `if (distTarget.current <= MIN_DIST) pushPastLimit(0.34);`. Add `pushPastLimit` to that effect's dependency array.
7. In `useFrame`, just before the `dist.current += …` line:

```ts
    if (useFridayStore.getState().mapView.mode === "entering") distTarget.current = ENTER_DIST;
```

8. In `onWheel`, replace the body with:

```ts
        const atLimit = distTarget.current <= MIN_DIST;
        // Wheel up (negative deltaY) flies the camera in.
        distTarget.current = Math.max(
          MIN_DIST,
          Math.min(MAX_DIST, distTarget.current * (1 + e.nativeEvent.deltaY * 0.001)),
        );
        if (atLimit && e.nativeEvent.deltaY < 0) pushPastLimit(-e.nativeEvent.deltaY / 400);
        touch();
```

9. In the pinch branch of `onPointerMove`, before assigning the clamped `distTarget`, add `if (distTarget.current <= MIN_DIST && pinchNow > pinchDist.current) pushPastLimit((pinchNow / pinchDist.current - 1) * 2);` (inside the existing `if (pinchDist.current > 0 && pinchNow > 0)`).
10. Add `pushPastLimit` to the `handlers` `useMemo` dependency array.

In `GlobeVisualization.tsx`, pass the raw points (not the operator-augmented `data`, whose YOU marker the map draws itself):

```tsx
  const mapPoints = points ?? GLOBE_DEMO_POINTS;
  const getPoints = useCallback(() => mapPoints, [mapPoints]);
  const { spinRef, handlers, focusOn } = useGlobeInteraction({ getFocusTarget, getPoints });
```

- [ ] **Step 9: Run the UI tests**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts`
Expected: 3 PASS.

If the map stays blank and the console shows a failed worker load: maplibre-gl v6 spawns its worker from a blob module that imports `maplibre-gl-worker.mjs` via `new URL(…, import.meta.url)`, which the Next bundler may not emit. In that case serve the worker files from `public/`: add `"postinstall": "node scripts/copy-maplibre-worker.mjs"` to `package.json`, create `scripts/copy-maplibre-worker.mjs`

```js
// maplibre-gl's worker must be a real URL the browser can import (see Task 6).
import { copyFileSync, readdirSync } from "node:fs";
const dist = "node_modules/maplibre-gl/dist";
for (const f of readdirSync(dist)) {
  if (/^maplibre-gl-(worker|shared)\.mjs$/.test(f)) copyFileSync(`${dist}/${f}`, `public/${f}`);
}
```

add `public/maplibre-gl-*.mjs` to `.gitignore`, run `npm run postinstall`, and at the top of `MapLayer.tsx` add `import { setWorkerUrl } from "maplibre-gl"; setWorkerUrl("/maplibre-gl-worker.mjs");`. Re-run the tests.

If the handoff test does not fire, print `await page.evaluate(() => document.documentElement.dataset.map)` and the camera distance via the existing `reportCamera` telemetry before changing thresholds — the wheel must land on the globe mesh (screen center).

Then: `npm run lint && npm run typecheck` — expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/components/friday/map src/app/page.tsx src/app/globals.css src/components/friday/hud src/components/friday/Scene.tsx src/components/friday/visualization/globe tests/ui/map.spec.ts
git commit -m "feat(map): full-screen map layer with globe zoom handoff"
```

---

### Task 7: Search, place card, context menu

**Files:**
- Create: `src/components/friday/map/MapSearch.tsx`, `src/components/friday/map/PlacePanel.tsx`
- Modify: `src/components/friday/map/MapLayer.tsx`
- Test: `tests/ui/map.spec.ts`

**Interfaces:**
- Consumes: `searchPlaces`, `reverseGeocode`, `Place`, `Endpoint` (Task 5); `shareLocation`; `MapStage` state `place`, `setPlace`, `setDirections` (Task 6).
- Produces:
  - `MapSearch(props: { label: string; placeholder: string; value?: string; getNear: () => { lat: number; lon: number } | null; onPick: (p: Place) => void; offerMyLocation?: boolean; testId?: string })` — ARIA combobox; input `aria-label={label}`, options `role="option"`. Used again by Task 8.
  - `PlacePanel(props: { place: Place; onClose; onDirectionsTo: (e: Endpoint) => void; onDirectionsFrom: (e: Endpoint) => void })` with `data-testid="place-card"`.
  - `ContextMenu(props: { menu: MenuState; onClose; onFrom; onTo; onWhatsHere })`, `interface MenuState { x: number; y: number; lat: number; lon: number }`.
  - `myLocationEndpoint(): Endpoint | null` exported from `PlacePanel.tsx`.

- [ ] **Step 1: Write the failing UI test**

Append to `tests/ui/map.spec.ts`:

```ts
const GEOCODE = {
  features: [
    { text: "Hồ Gươm", place_name: "Hồ Gươm, Hoàn Kiếm, Hà Nội", center: [105.8525, 21.0288], place_type: ["poi"] },
    { text: "Hồ Tây", place_name: "Hồ Tây, Tây Hồ, Hà Nội", center: [105.8194, 21.0583], place_type: ["poi"] },
  ],
};

test("search autocompletes, picks with the keyboard and opens the place card", async ({ page }) => {
  await stubMapTiler(page, GEOCODE);
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  const box = page.getByRole("combobox", { name: "Tìm kiếm địa điểm" });
  await box.click();
  await box.pressSequentially("hồ", { delay: 20 });
  await expect(page.getByRole("option")).toHaveCount(2);
  await box.press("ArrowDown");
  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(page.getByTestId("place-card")).toContainText("Hồ Tây");
  await expect(page.getByTestId("place-card")).toContainText("21.058300, 105.819400");
  // Esc inside an input only closes its list; leave the input so Esc reaches the map.
  await box.evaluate((el) => (el as HTMLElement).blur());
  await page.keyboard.press("Escape"); // closes the card, not the map
  await expect(page.getByTestId("place-card")).toHaveCount(0);
  await expect(layer(page)).toHaveAttribute("data-mode", "map");
});

test("right-click offers directions from/to and what's here", async ({ page }) => {
  await stubMapTiler(page, GEOCODE);
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  const size = page.viewportSize()!;
  await page.mouse.click(size.width / 2, size.height / 2, { button: "right" });
  const menu = page.getByRole("menu", { name: "Tùy chọn vị trí" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Đây là đâu?" }).click();
  await expect(page.getByTestId("place-card")).toContainText("Hồ Gươm"); // reverse geocode stub answers the first feature
});
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts -g "search|right-click"`
Expected: FAIL — no combobox / menu.

- [ ] **Step 3: `MapSearch.tsx`**

```tsx
"use client";

import { useEffect, useId, useState } from "react";
import { shareLocation } from "@/lib/geolocation";
import { useFridayStore } from "@/lib/store";
import { searchPlaces, type Place } from "./mapApi";

const MY_LOCATION_LABEL = "Vị trí của bạn";

/** Google-Maps-style search box: debounced MapTiler autocomplete as an ARIA combobox. */
export function MapSearch({
  label,
  placeholder,
  value,
  getNear,
  onPick,
  offerMyLocation = false,
  testId,
}: {
  label: string;
  placeholder: string;
  value?: string;
  getNear: () => { lat: number; lon: number } | null;
  onPick: (place: Place) => void;
  offerMyLocation?: boolean;
  testId?: string;
}) {
  const [text, setText] = useState(value ?? "");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const location = useFridayStore((s) => s.location);

  useEffect(() => setText(value ?? ""), [value]);

  useEffect(() => {
    const q = text.trim();
    if (!open || q.length < 2) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchPlaces(q, getNear(), ctrl.signal)
        .then((r) => {
          setResults(r);
          setActive(-1);
        })
        .catch(() => {}); // aborted or offline: keep the last list
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // getNear is read at search time on purpose; it is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open]);

  const mine: Place | null =
    offerMyLocation && location ? { label: MY_LOCATION_LABEL, address: "", lat: location.lat, lon: location.lon } : null;
  const options = offerMyLocation ? [mine ?? { label: `${MY_LOCATION_LABEL} (bật chia sẻ vị trí)`, address: "", lat: NaN, lon: NaN }, ...results] : results;

  const pick = (p: Place) => {
    setOpen(false);
    if (Number.isNaN(p.lat)) {
      shareLocation(); // user gesture; re-pick once the fix lands
      return;
    }
    setText(p.label);
    onPick(p);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const p = options[active] ?? options[0];
      if (p) {
        e.preventDefault();
        pick(p);
      }
    } else if (e.key === "Escape") {
      // Close the list only; the map's own Esc must not fire as well.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="relative w-80 max-w-[70vw]" data-testid={testId}>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        className="friday-map-chip w-full !rounded-xl !px-4 !py-2.5 !text-sm outline-none placeholder:text-slate-400 focus:border-cyan-300"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" className="friday-map-panel absolute left-0 right-0 top-full mt-1 max-h-80 overflow-auto py-1">
          {options.map((p, i) => (
            <li
              key={`${p.label}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-4 py-2 text-sm ${i === active ? "bg-cyan-400/15" : "hover:bg-cyan-400/10"}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(p)}
            >
              <div className="text-cyan-50">{p.label}</div>
              {p.address && p.address !== p.label && <div className="truncate text-xs text-slate-400">{p.address}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: `PlacePanel.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useFridayStore } from "@/lib/store";
import { reverseGeocode, type Endpoint, type Place } from "./mapApi";

export interface MenuState {
  x: number;
  y: number;
  lat: number;
  lon: number;
}

export function myLocationEndpoint(): Endpoint | null {
  const loc = useFridayStore.getState().location;
  return loc ? { lat: loc.lat, lon: loc.lon, label: "Vị trí của bạn" } : null;
}

const coords = (lat: number, lon: number) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

export function PlacePanel({
  place,
  onClose,
  onDirectionsTo,
  onDirectionsFrom,
}: {
  place: Place;
  onClose: () => void;
  onDirectionsTo: (e: Endpoint) => void;
  onDirectionsFrom: (e: Endpoint) => void;
}) {
  const [address, setAddress] = useState(place.address);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setAddress(place.address);
    setCopied(false);
    if (place.address) return;
    const ctrl = new AbortController();
    reverseGeocode(place.lat, place.lon, ctrl.signal)
      .then((hit) => hit && setAddress(hit.address))
      .catch(() => {});
    return () => ctrl.abort();
  }, [place]);

  const here: Endpoint = { lat: place.lat, lon: place.lon, label: place.label };
  const copy = () => {
    void navigator.clipboard?.writeText(coords(place.lat, place.lon)).then(() => setCopied(true));
  };

  return (
    <section
      data-testid="place-card"
      aria-label={place.label}
      className="friday-map-panel absolute bottom-24 left-4 z-10 w-[380px] max-w-[calc(100vw-2rem)] p-4 md:bottom-auto md:top-32"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-cyan-50">{place.label}</h2>
          {place.category && <div className="text-xs uppercase tracking-wider text-cyan-300/80">{place.category}</div>}
        </div>
        <button type="button" aria-label="Đóng" className="text-slate-400 hover:text-cyan-100" onClick={onClose}>
          ✕
        </button>
      </div>
      {address && <p className="mt-2 text-sm text-slate-300">{address}</p>}
      <p className="mt-1 font-mono text-xs text-slate-400">{coords(place.lat, place.lon)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="rounded-full bg-cyan-400 px-3 py-1.5 text-sm font-medium text-slate-950" onClick={() => onDirectionsTo(here)}>
          ↱ Chỉ đường
        </button>
        <button type="button" className="friday-map-chip" onClick={() => onDirectionsFrom(here)}>
          Từ đây
        </button>
        <button type="button" className="friday-map-chip" onClick={copy}>
          {copied ? "Đã sao chép" : "Sao chép tọa độ"}
        </button>
      </div>
    </section>
  );
}

export function ContextMenu({
  menu,
  onClose,
  onFrom,
  onTo,
  onWhatsHere,
}: {
  menu: MenuState;
  onClose: () => void;
  onFrom: (e: Endpoint) => void;
  onTo: (e: Endpoint) => void;
  onWhatsHere: (lat: number, lon: number) => void;
}) {
  const point: Endpoint = { lat: menu.lat, lon: menu.lon, label: coords(menu.lat, menu.lon) };
  const item = "block w-full px-4 py-2 text-left text-sm hover:bg-cyan-400/10";
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div
      role="menu"
      aria-label="Tùy chọn vị trí"
      className="friday-map-panel absolute z-20 w-56 py-1"
      style={{ left: menu.x, top: menu.y }}
    >
      <button type="button" role="menuitem" className={item} onClick={run(() => onFrom(point))}>
        Chỉ đường từ đây
      </button>
      <button type="button" role="menuitem" className={item} onClick={run(() => onTo(point))}>
        Chỉ đường đến đây
      </button>
      <button type="button" role="menuitem" className={item} onClick={run(() => onWhatsHere(menu.lat, menu.lon))}>
        Đây là đâu?
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={run(() => void navigator.clipboard?.writeText(coords(menu.lat, menu.lon)))}
      >
        Sao chép tọa độ
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Wire into `MapLayer.tsx`**

Imports: `import { MapSearch } from "./MapSearch";` and `import { ContextMenu, PlacePanel, myLocationEndpoint, type MenuState } from "./PlacePanel";` (add `type MapMouseEvent` to the maplibre import).

State: `const [menu, setMenu] = useState<MenuState | null>(null);`

Add the map-click effect after the markers effect:

```tsx
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
```

Add helpers inside `MapStage` (used by the panel, menu and Task 8):

```tsx
  const getNear = useCallback(() => {
    const c = map?.getCenter();
    return c ? { lat: c.lat, lon: c.lng } : null;
  }, [map]);
  const directionsTo = (to: Endpoint) => {
    setPlace(null);
    setDirections((d) => ({ profile: d?.profile ?? "motor_scooter", stops: [d?.stops[0] ?? myLocationEndpoint(), to] }));
  };
  const directionsFrom = (from: Endpoint) => {
    setPlace(null);
    setDirections((d) => ({ profile: d?.profile ?? "motor_scooter", stops: [from, d?.stops.at(-1) ?? null] }));
  };
```

Replace the top-bar slot comment with:

```tsx
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
```

Replace the panel slot comment with:

```tsx
      {place && !directions && (
        <PlacePanel place={place} onClose={() => setPlace(null)} onDirectionsTo={directionsTo} onDirectionsFrom={directionsFrom} />
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
```

Extend the Esc handler: check `menu` first — `if (menu) setMenu(null); else if (directions) …` — and add `menu` to its dependency array.

- [ ] **Step 6: Run the tests**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts`
Expected: 5 PASS. `npm run lint && npm run typecheck` clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/friday/map tests/ui/map.spec.ts
git commit -m "feat(map): search autocomplete, place card and context menu"
```

---

### Task 8: Directions panel

**Files:**
- Create: `src/components/friday/map/DirectionsPanel.tsx`
- Modify: `src/components/friday/map/MapLayer.tsx`, `tests/ui/stubOrchestrator.ts`
- Test: `tests/ui/map.spec.ts`

**Interfaces:**
- Consumes: `fetchRoute`, `routeCoordinates`, `maneuverCoordinate`, `stepCoordinates`, `formatDistance`, `formatDuration`, `PROFILE_LABELS`, `Route`, `Endpoint` (Task 5); `MapSearch` (Task 7); `DirectionsValue`, `getNear`, `myLocationEndpoint` (Tasks 6–7).
- Produces: `DirectionsPanel(props: { map: MlMap; value: DirectionsValue; onChange: (v: DirectionsValue) => void; onClose: () => void; getNear })` with `data-testid="directions-panel"`, `data-testid="directions-summary"`, `data-testid="directions-status"`; map layers `friday-route-casing`, `friday-route-line`, `friday-route-step`; `MAP_FLOW` export in `tests/ui/stubOrchestrator.ts`.

- [ ] **Step 1: Stub flow + failing UI tests**

Append to `tests/ui/stubOrchestrator.ts`:

```ts
/** get_directions as the backend streams it: the map preview is also the final spec. */
const MAP_ROUTE_SPEC = {
  type: "map",
  title: "CHỈ ĐƯỜNG",
  data: {
    points: [
      { id: "A", label: "Hồ Gươm", lat: 21.0288, lon: 105.8525 },
      { id: "B", label: "Lăng Bác", lat: 21.0368, lon: 105.8346 },
    ],
    map: {
      route: {
        profile: "motor_scooter",
        waypoints: [
          { lat: 21.0288, lon: 105.8525, label: "Hồ Gươm" },
          { lat: 21.0368, lon: 105.8346, label: "Lăng Bác" },
        ],
      },
    },
  },
};

export const MAP_FLOW: StubEvent[] = [
  { event: "state", data: { state: "thinking" }, after: 60 },
  { event: "state", data: { state: "tool_execution" }, after: 150 },
  { event: "tool", data: { tool: "get_directions", risk: "low" }, after: 20 },
  { event: "viz", data: { ...MAP_ROUTE_SPEC, animation: "materialize", interaction: "none" }, after: 150 },
  { event: "state", data: { state: "visualizing" }, after: 150 },
  { event: "viz", data: { ...MAP_ROUTE_SPEC, animation: "materialize", interaction: "drill_down" }, after: 20 },
  { event: "state", data: { state: "speaking" }, after: 150 },
  { event: "answer", data: { text: "Khoảng 2,4 km, chừng 9 phút đi xe máy." }, after: 20 },
  { event: "done", data: {}, after: 20 },
];
```

Append to `tests/ui/map.spec.ts` (add `import { MAP_FLOW, startStubOrchestrator } from "./stubOrchestrator";`):

```ts
const ROUTE = {
  routes: [
    {
      distance_m: 2412,
      duration_s: 545,
      legs: [{
        shape: "_{nbg@gdv{hEoeGvpQolF~kO",
        maneuvers: [
          { instruction: "Đi về hướng tây trên Đinh Tiên Hoàng.", type: 2, distance_m: 1100, duration_s: 250, begin_shape_index: 0 },
          { instruction: "Rẽ phải vào Hùng Vương.", type: 10, distance_m: 1312, duration_s: 295, begin_shape_index: 1 },
          { instruction: "Bạn đã đến nơi.", type: 4, distance_m: 0, duration_s: 0, begin_shape_index: 2 },
        ],
      }],
    },
    { distance_m: 2900, duration_s: 610, legs: [{ shape: "_{nbg@gdv{hEoeGvpQolF~kO", maneuvers: [] }] },
  ],
};

test("an agent route opens directions with the summary, steps and route layers", async ({ page }) => {
  await stubMapTiler(page);
  await page.route("**/geo/route", (r) => r.fulfill({ json: ROUTE }));
  const stub = await startStubOrchestrator(MAP_FLOW);
  try {
    await gotoLitScene(page);
    await page.getByRole("textbox").last().click();
    await page.getByRole("textbox").last().pressSequentially("chỉ đường tới lăng bác", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
    const panel = page.getByTestId("directions-panel");
    await expect(page.getByTestId("directions-summary")).toContainText("9 phút");
    await expect(page.getByTestId("directions-summary")).toContainText("2,4 km");
    await expect(panel.getByRole("tab", { name: "🛵 Xe máy" })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("listitem")).toContainText(["Rẽ phải vào Hùng Vương."]);
    expect(await page.evaluate(() => {
      const m = (window as unknown as { __fridayMap?: { getLayer(id: string): unknown } }).__fridayMap;
      return !!m?.getLayer("friday-route-line") && !!m?.getLayer("friday-route-casing");
    })).toBe(true);
    // switching mode re-asks the route with the new profile
    const asked = page.waitForRequest((r) => r.url().endsWith("/geo/route") && r.postDataJSON().profile === "pedestrian");
    await panel.getByRole("tab", { name: "🚶 Đi bộ" }).click();
    await asked;
  } finally {
    await stub.close();
  }
});

test("routing off: directions say so and the map stays usable", async ({ page }) => {
  await stubMapTiler(page);
  await page.route("**/geo/route", (r) => r.fulfill({ status: 503, json: { error: "routing_unavailable" } }));
  const stub = await startStubOrchestrator(MAP_FLOW);
  try {
    await gotoLitScene(page);
    await page.getByRole("textbox").last().click();
    await page.getByRole("textbox").last().pressSequentially("chỉ đường tới lăng bác", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("directions-status")).toHaveText("Chỉ đường chưa được cấu hình", { timeout: 20_000 });
    await expect(page.getByRole("combobox", { name: "Tìm kiếm địa điểm" })).toBeEnabled();
  } finally {
    await stub.close();
  }
});
```

Before the map opens, the InputBar input is the only textbox on the page. Check `tests/ui/friday.spec.ts` for how the existing tests target it and use the same locator if `getByRole("textbox").last()` is ambiguous.

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts -g "route|routing"`
Expected: FAIL — no `directions-panel`.

- [ ] **Step 3: `DirectionsPanel.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Marker, type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import type { MapProfile } from "@/lib/visualization/types";
import type { DirectionsValue } from "./MapLayer";
import { MapSearch } from "./MapSearch";
import {
  PROFILE_LABELS,
  fetchRoute,
  formatDistance,
  formatDuration,
  maneuverCoordinate,
  routeCoordinates,
  stepCoordinates,
  type Endpoint,
  type Route,
} from "./mapApi";

const ROUTE_SRC = "friday-route";
const STEP_SRC = "friday-route-step";
const PROFILES: MapProfile[] = ["motor_scooter", "auto", "bicycle", "pedestrian"];

type Status = "idle" | "loading" | "ok" | "unavailable" | "no_route" | "error";
const STATUS_TEXT: Partial<Record<Status, string>> = {
  loading: "Đang tìm đường…",
  unavailable: "Chỉ đường chưa được cấu hình",
  no_route: "Không tìm thấy đường đi (chỉ hỗ trợ trong Việt Nam)",
  error: "Không tính được đường đi",
};

type Line = GeoJSON.Feature<GeoJSON.LineString, { i: number; selected: boolean }>;

function routeData(routes: Route[], selected: number): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  return {
    type: "FeatureCollection",
    features: routes.map<Line>((r, i) => ({
      type: "Feature",
      properties: { i, selected: i === selected },
      geometry: { type: "LineString", coordinates: routeCoordinates(r) },
    })),
  };
}

/** Add or refresh the route layers — also after a style swap, which drops them. */
function drawRoutes(map: MlMap, routes: Route[], selected: number, step: [number, number][]) {
  const data = routeData(routes, selected);
  const stepData: GeoJSON.Feature<GeoJSON.LineString> = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: step } };
  const src = map.getSource(ROUTE_SRC) as GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    (map.getSource(STEP_SRC) as GeoJSONSource).setData(stepData);
    return;
  }
  map.addSource(ROUTE_SRC, { type: "geojson", data });
  map.addSource(STEP_SRC, { type: "geojson", data: stepData });
  const layout = { "line-join": "round", "line-cap": "round", "line-sort-key": ["case", ["get", "selected"], 1, 0] } as const;
  map.addLayer({ id: "friday-route-casing", type: "line", source: ROUTE_SRC, layout, paint: { "line-color": ["case", ["get", "selected"], "#0b3d4a", "#1f2a33"], "line-width": 10 } });
  map.addLayer({ id: "friday-route-line", type: "line", source: ROUTE_SRC, layout, paint: { "line-color": ["case", ["get", "selected"], "#38e8ff", "#6b7c8a"], "line-width": 5 } });
  map.addLayer({ id: "friday-route-step", type: "line", source: STEP_SRC, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#eafcff", "line-width": 7 } });
}

function clearRoutes(map: MlMap) {
  // The map may already be removed when the panel unmounts with it.
  try {
    for (const id of ["friday-route-step", "friday-route-line", "friday-route-casing"]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [STEP_SRC, ROUTE_SRC]) if (map.getSource(id)) map.removeSource(id);
  } catch {
    /* map gone */
  }
}

function fitRoute(map: MlMap, route: Route) {
  const coords = routeCoordinates(route);
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
  onChange,
  onClose,
  getNear,
}: {
  map: MlMap;
  value: DirectionsValue;
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
      setRoutes([]);
      setStatus("idle");
      return;
    }
    const ctrl = new AbortController();
    setStatus("loading");
    fetchRoute(stops, value.profile, ctrl.signal)
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
  const steps = best ? best.legs.flatMap((leg, li) => leg.maneuvers.map((m, mi) => ({ m, li, mi }))) : [];
  const last = value.stops.length - 1;

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
        {PROFILES.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={value.profile === p}
            className={`flex-1 rounded-full px-2 py-1 text-xs ${value.profile === p ? "bg-cyan-400 text-slate-950" : "hover:bg-cyan-400/10"}`}
            onClick={() => onChange({ ...value, profile: p })}
          >
            {PROFILE_LABELS[p]}
          </button>
        ))}
      </div>

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
          </div>
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
            {steps.map(({ m, li, mi }) => (
              <li
                key={`${li}-${mi}`}
                className="cursor-pointer rounded px-2 py-1.5 text-sm hover:bg-cyan-400/10"
                onMouseEnter={() => setStep(stepCoordinates(best, li, mi))}
                onMouseLeave={() => setStep([])}
                onClick={() => {
                  const at = maneuverCoordinate(best, li, mi);
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
```

- [ ] **Step 4: Wire into `MapLayer.tsx`**

Import `DirectionsPanel` from `./DirectionsPanel`. Next to the top-bar `MapSearch` add the directions toggle:

```tsx
        <button
          type="button"
          className="friday-map-fab"
          aria-label="Chỉ đường"
          onClick={() => {
            const to = place ? { lat: place.lat, lon: place.lon, label: place.label } : null;
            setPlace(null);
            setDirections({ profile: "motor_scooter", stops: [myLocationEndpoint(), to] });
          }}
        >
          ↱
        </button>
```

and in the panel slot, after the `PlacePanel` line:

```tsx
      {map && directions && (
        <DirectionsPanel map={map} value={directions} onChange={setDirections} onClose={() => setDirections(null)} getNear={getNear} />
      )}
```

`setDirections` is a stable state setter, so the marker effect in `DirectionsPanel` does not re-run on every render.

- [ ] **Step 5: Run the tests**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts`
Expected: 7 PASS. `npm run lint && npm run typecheck` clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/friday/map tests/ui/map.spec.ts tests/ui/stubOrchestrator.ts
git commit -m "feat(map): directions with alternatives, draggable stops and step list"
```

---

### Task 9: Docs, tuning, full verification

**Files:**
- Modify: `README.md`, `backend/README.md`, `docs/ARCHITECTURE.md`, `src/lib/mapView.ts` (only if `HANDOFF_ZOOM` needs tuning)

**Interfaces:**
- Consumes: everything above.
- Produces: documented env vars and local Valhalla steps; tuned handoff constant; green `npm run verify`.

- [ ] **Step 1: Docs**

- `README.md`: in the env/setup section add `NEXT_PUBLIC_MAPTILER_KEY` (what it is, origin restriction) and a "Street map & directions" paragraph: zoom the globe past its limit or ask FRIDAY for a place/route; directions need the backend's `VALHALLA_URL` (`npm run dev:valhalla`, first build ~15–40 min, ~2–4 GB RAM).
- `backend/README.md`: add `VALHALLA_URL` and `MAPTILER_SERVER_KEY` to the env table and the two tools (`find_place`, `get_directions`: low risk, `geo.read`) to the tool list, noting Render's free plan cannot host Valhalla.
- `docs/ARCHITECTURE.md`: one short section — map layer between canvas and HUD, `mapView` slice, `map` spec = route intent, `/geo/route` proxy, preview pinning.

- [ ] **Step 2: Manual check in the browser preview (with a real key)**

With `NEXT_PUBLIC_MAPTILER_KEY` set in `.env.local`, start the dev server via the browser preview tooling (`.claude/launch.json`, `npm run dev`), open the GLOBE from the dev rail and zoom in until the map takes over. Check:
- the two spheres overlap during the crossfade; if the map's globe is visibly bigger/smaller, adjust `HANDOFF_ZOOM` in `src/lib/mapView.ts` in 0.1 steps and keep the comment;
- enter/leave five times, then run in the console `document.querySelectorAll("canvas").length` — it must not grow (each close removes MapLibre's canvas/WebGL context);
- place search, place card, context menu and layer switcher (dark/light/satellite/terrain, 3D buildings) work;
- with `npm run dev:valhalla` running and `VALHALLA_URL` set, ask "chỉ đường từ Hồ Gươm tới Lăng Bác": the route draws, steps are Vietnamese, dragging B reroutes; record Valhalla's RAM with `docker stats --no-stream` and put the number in `backend/README.md` in place of the estimate.

Take one screenshot of the map with a route for the PR.

- [ ] **Step 3: Full verification**

Run: `npm run verify`
Expected: lint, typecheck, unit, backend, contracts and UI suites all PASS. Fix failures at their root; do not skip or weaken tests.

- [ ] **Step 4: Commit**

```bash
git add README.md backend/README.md docs/ARCHITECTURE.md src/lib/mapView.ts
git commit -m "docs(map): street map setup, Valhalla and map architecture"
```
