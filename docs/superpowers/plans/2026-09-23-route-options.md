# Route Options and Traffic Incidents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Directions can avoid tolls/motorways/ferries/unpaved roads, plan for a departure or arrival time, and colour congested stretches — in the map UI and in the agent's `get_directions` — and the traffic layer shows incidents.

**Architecture:** The options ride on the existing route intent (`MapView.route`), `POST /geo/route` and `tomtom.route`, so the agent and the map share one request. A small pure module (`geo/route_time.py`) validates and normalizes times for both the endpoint (strict: offset required) and the tool (assumes the operator's offset). `tomtom.route` adds `avoid`, `departAt`/`arriveAt` and `sectionType=traffic`, returns departure/arrival times and traffic sections, and caches "now" routes for 2 minutes only.

**Tech Stack:** TomTom Routing API v1 (existing), FastAPI + pydantic, maplibre-gl 6, React 19, Playwright + plain-python tests (all existing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-route-options-design.md`. Base: `main` at `d1dbe65`, branch `feat/route-options`.

## Global Constraints

- `MapAvoid = "tolls" | "motorways" | "ferries" | "unpaved"` → TomTom `tollRoads | motorways | ferries | unpavedRoads`.
- Times: ISO 8601 **with** UTC offset on the wire (`depart_at` / `arrive_at`, mutually exclusive). The API rejects naive times; the tool assumes the operator's offset.
- Time window: not more than **5 minutes** in the past, not more than **365 days** ahead.
- Operator offset comes from `CLIENT["utc_offset_min"]` (not the tz name — Windows has no tz database; same reason as `tools/system/clock.py`); fallback **+07:00**.
- Motorbike default: `motor_scooter` with `avoid` omitted → `["motorways"]` (tool); UI switching to motorbike adds `motorways`, switching away removes it. Explicit `avoid: []` means avoid nothing.
- "Now" routes cache for **120 s**; timed routes keep the existing LRU.
- Congestion colours: magnitude 0–1 `#fbbf24`, 2 `#fb923c`, 3–4 `#f87171`; `road_closure` `#7f1d1d` dashed.
- Traffic toggle adds `traffic_incidents`: `2/incidents_dark` (dark, satellite), `2/incidents_light` (light).
- UI copy (verbatim): "Đi ngay", "Khởi hành lúc", "Đến lúc", "Tùy chọn", "Tránh trạm thu phí", "Tránh cao tốc", "Tránh phà", "Tránh đường đất", "Khởi hành HH:MM → Đến HH:MM".
- Contract changes land in all three places (TS, Python, JSON). No test touches the real network. Commits: conventional prefix, **no `Co-Authored-By` trailer**. Done = `npm run verify` green.

## Deviation from the spec

§4.3 says the tool takes the offset from `CLIENT.timezone`. The client sends both `timezone` (IANA name) and `utc_offset_min`; the backend cannot resolve IANA names on Windows (`zoneinfo` has no data without `tzdata`), so the plan uses `utc_offset_min`, exactly like `get_current_time`.

## File Structure

- Create: `backend/friday/geo/route_time.py` (pure time parsing/validation), `backend/tests/unit/test_route_time.py`
- Modify (contract): `src/lib/visualization/types.ts`, `src/lib/visualization/normalization.ts`, `backend/friday/schemas/visualization.py`, `contracts/visualization/visualization.v1.json`, `tests/unit/contracts.spec.ts`, `tests/unit/vizNormalize.spec.ts`, `backend/tests/unit/test_contracts.py`
- Modify (backend): `backend/friday/geo/tomtom.py`, `backend/friday/api/schemas.py`, `backend/friday/api/routes.py`, `backend/friday/geo/tools.py`, `backend/friday/tools/registry.py`, `backend/tests/unit/test_tomtom.py`, `backend/tests/integration/test_geo_route.py`, `backend/tests/unit/test_geo_tools.py`
- Modify (frontend): `src/components/friday/map/mapApi.ts`, `src/components/friday/map/DirectionsPanel.tsx`, `src/components/friday/map/MapLayer.tsx`, `tests/unit/mapApi.spec.ts`, `tests/ui/map.spec.ts`, `tests/ui/stubOrchestrator.ts`

---

### Task 1: Contract — `avoid`, `depart_at`, `arrive_at` on the route intent

**Files:**
- Modify: `src/lib/visualization/types.ts:69-90`, `src/lib/visualization/normalization.ts:49-96`, `backend/friday/schemas/visualization.py` (MapRoute), `contracts/visualization/visualization.v1.json` (MapRoute)
- Test: `tests/unit/contracts.spec.ts`, `tests/unit/vizNormalize.spec.ts`, `backend/tests/unit/test_contracts.py`

**Interfaces:**
- Produces (TS): `export type MapAvoid = "tolls" | "motorways" | "ferries" | "unpaved"`; `MapView.route` gains `avoid?: MapAvoid[]; depart_at?: string; arrive_at?: string`.
- Produces (Python, `friday.schemas.visualization`): `MapAvoid` (Literal), `MapRoute.avoid: list[MapAvoid] | None`, `MapRoute.depart_at: str | None`, `MapRoute.arrive_at: str | None`.

- [ ] **Step 1: Failing tests**

Append to `tests/unit/contracts.spec.ts`:

```ts
test("map routes carry avoid options and one departure or arrival time", () => {
  const props = viz.definitions.MapRoute.properties;
  expect(Object.keys(props).sort()).toEqual(["arrive_at", "avoid", "depart_at", "profile", "waypoints"]);
  expect(props.avoid.items.enum).toEqual(["tolls", "motorways", "ferries", "unpaved"]);
  expect(props.depart_at.type).toBe("string");
  expect(props.arrive_at.type).toBe("string");
});
```

Append to `tests/unit/vizNormalize.spec.ts`:

```ts
test("map route options: known avoid values, offset times, never both times", () => {
  const w = [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }];
  expect(
    sanitizeMapView({ route: { profile: "auto", waypoints: w, avoid: ["tolls", "rocket", "tolls", "ferries"], depart_at: "2026-09-24T08:00:00+07:00" } }),
  ).toEqual({ route: { profile: "auto", waypoints: w, avoid: ["tolls", "ferries"], depart_at: "2026-09-24T08:00:00+07:00" } });
  // naive times are dropped; with both, arrive_at goes
  expect(sanitizeMapView({ route: { profile: "auto", waypoints: w, depart_at: "2026-09-24T08:00" } })).toEqual({ route: { profile: "auto", waypoints: w } });
  expect(
    sanitizeMapView({ route: { profile: "auto", waypoints: w, depart_at: "2026-09-24T08:00Z", arrive_at: "2026-09-24T09:00Z" } })?.route,
  ).toEqual({ profile: "auto", waypoints: w, depart_at: "2026-09-24T08:00Z" });
  expect(sanitizeMapView({ route: { profile: "auto", waypoints: w, arrive_at: "2026-09-24T09:00:00-05:30", avoid: "tolls" } })?.route)
    .toEqual({ profile: "auto", waypoints: w, arrive_at: "2026-09-24T09:00:00-05:30" });
});
```

Append to `backend/tests/unit/test_contracts.py`:

```python
def test_map_route_options_match_canonical_schema() -> None:
    from friday.schemas.visualization import MapAvoid, MapRoute

    schema = load("visualization", "visualization.v1.json")
    props = schema["definitions"]["MapRoute"]["properties"]
    assert set(MapRoute.model_fields) == set(props), set(MapRoute.model_fields) ^ set(props)
    assert list(get_args(MapAvoid)) == props["avoid"]["items"]["enum"]
    MapRoute(waypoints=[{"lat": 1, "lon": 1}, {"lat": 2, "lon": 2}], avoid=["tolls"], depart_at="2026-09-24T08:00:00+07:00")
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=unit tests/unit/contracts.spec.ts tests/unit/vizNormalize.spec.ts` and `python backend/runtests.py test_contracts`
Expected: FAIL — missing properties / `ImportError: MapAvoid`.

- [ ] **Step 3: TS types + sanitize**

`src/lib/visualization/types.ts`, after `MapProfile`:

```ts
/** Roads a route may avoid (spec 2026-09-23 §3); the backend maps them to TomTom's names. */
export type MapAvoid = "tolls" | "motorways" | "ferries" | "unpaved";
```

and in `MapView`:

```ts
  route?: {
    profile: MapProfile;
    waypoints: MapWaypoint[];
    avoid?: MapAvoid[];
    /** ISO 8601 with UTC offset. Excludes `arrive_at`. */
    depart_at?: string;
    /** ISO 8601 with UTC offset. Excludes `depart_at`. */
    arrive_at?: string;
  };
```

`src/lib/visualization/normalization.ts`: extend the type import with `type MapAvoid`, add after `MAP_PROFILES`:

```ts
const MAP_AVOID: ReadonlySet<string> = new Set(["tolls", "motorways", "ferries", "unpaved"]);
/** An ISO 8601 time that carries its own offset — a naive one would mean a different instant per server. */
const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function sanitizeTime(value: unknown): string | undefined {
  return typeof value === "string" && OFFSET_TIME.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}
```

and replace the route block of `sanitizeMapView` with:

```ts
  const r = v.route as
    | { profile?: unknown; waypoints?: unknown; avoid?: unknown; depart_at?: unknown; arrive_at?: unknown }
    | null
    | undefined;
  if (r && Array.isArray(r.waypoints)) {
    const waypoints = r.waypoints.flatMap((w) => {
      const p = sanitizeLatLon(w);
      if (!p) return [];
      const label = sanitizeLabel((w as { label?: unknown }).label);
      return [label ? { ...p, label } : p];
    });
    if (waypoints.length >= 2 && waypoints.length <= 5) {
      const profile = MAP_PROFILES.has(r.profile as string) ? (r.profile as MapProfile) : "motor_scooter";
      const route: NonNullable<MapView["route"]> = { profile, waypoints };
      if (Array.isArray(r.avoid)) {
        const avoid = [...new Set(r.avoid.filter((a): a is MapAvoid => MAP_AVOID.has(a as string)))];
        if (avoid.length > 0) route.avoid = avoid;
      }
      // TomTom takes one or the other; a departure is the more common ask.
      const depart = sanitizeTime(r.depart_at);
      const arrive = sanitizeTime(r.arrive_at);
      if (depart) route.depart_at = depart;
      else if (arrive) route.arrive_at = arrive;
      out.route = route;
    }
  }
```

- [ ] **Step 4: Python schema + JSON**

`backend/friday/schemas/visualization.py`, above `MapRoute`:

```python
MapAvoid = Literal["tolls", "motorways", "ferries", "unpaved"]
```

and in `MapRoute` after `waypoints`:

```python
    avoid: list[MapAvoid] | None = None
    #: ISO 8601 with UTC offset; excludes arrive_at (validated at /geo/route).
    depart_at: str | None = None
    arrive_at: str | None = None
```

Export `MapAvoid` from `backend/friday/schema.py` (import + `__all__`) next to `MapRoute`.

`contracts/visualization/visualization.v1.json`, `definitions.MapRoute.properties`, after `waypoints`:

```json
        "avoid": {
          "type": "array",
          "uniqueItems": true,
          "items": { "type": "string", "enum": ["tolls", "motorways", "ferries", "unpaved"] }
        },
        "depart_at": { "type": "string", "description": "ISO 8601 with UTC offset; excludes arrive_at" },
        "arrive_at": { "type": "string", "description": "ISO 8601 with UTC offset; excludes depart_at" }
```

(mind the comma after the `waypoints` block).

- [ ] **Step 5: Run the tests**

Run: `npx playwright test --project=unit tests/unit/contracts.spec.ts tests/unit/vizNormalize.spec.ts tests/unit/mapView.spec.ts`, `python backend/runtests.py test_contracts`, `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/visualization contracts/visualization backend/friday/schemas/visualization.py backend/friday/schema.py tests/unit/contracts.spec.ts tests/unit/vizNormalize.spec.ts backend/tests/unit/test_contracts.py
git commit -m "feat(viz): map routes carry avoid options and a departure or arrival time"
```

---

### Task 2: Route times module

**Files:**
- Create: `backend/friday/geo/route_time.py`, `backend/tests/unit/test_route_time.py`

**Interfaces:**
- Produces (`friday.geo.route_time`): `DEFAULT_OFFSET_MIN = 420`, `class RouteTimeError(ValueError)`, `parse_time(value: str, assume_offset_min: int | None = None) -> datetime`, `route_times(depart_at: str | None, arrive_at: str | None, *, assume_offset_min: int | None = None, now: datetime | None = None) -> tuple[str | None, str | None]` (ISO strings with offset, seconds precision).

- [ ] **Step 1: Failing test**

Create `backend/tests/unit/test_route_time.py`:

```python
"""Departure/arrival times for routes.

    PYTHONPATH=. python tests/unit/test_route_time.py
"""

from datetime import datetime, timedelta, timezone

from friday.geo.route_time import RouteTimeError, parse_time, route_times

NOW = datetime(2026, 9, 23, 1, 0, tzinfo=timezone.utc)  # 08:00 in Hà Nội


def raises(fn, text):
    try:
        fn()
    except RouteTimeError as err:
        assert text in str(err), (text, str(err))
        return
    raise AssertionError(f"expected RouteTimeError containing {text!r}")


def test_offsets_are_kept_or_assumed() -> None:
    assert parse_time("2026-09-24T08:00:00+07:00").utcoffset() == timedelta(hours=7)
    assert parse_time("2026-09-24T01:00:00Z").utcoffset() == timedelta(0)
    assert parse_time("2026-09-24T08:00", assume_offset_min=420).isoformat() == "2026-09-24T08:00:00+07:00"
    raises(lambda: parse_time("2026-09-24T08:00"), "no UTC offset")
    raises(lambda: parse_time("tomorrow at 8"), "not an ISO 8601 time")


def test_route_times_normalize_and_exclude_each_other() -> None:
    assert route_times(None, None, now=NOW) == (None, None)
    assert route_times("2026-09-24T08:00", None, assume_offset_min=420, now=NOW) == ("2026-09-24T08:00:00+07:00", None)
    assert route_times(None, "2026-09-23T09:30:00+07:00", now=NOW) == (None, "2026-09-23T09:30:00+07:00")
    raises(lambda: route_times("2026-09-24T08:00Z", "2026-09-24T09:00Z", now=NOW), "not both")


def test_window() -> None:
    # 4 minutes ago is fine (clock skew), 6 minutes ago is not
    assert route_times("2026-09-23T07:56:00+07:00", None, now=NOW)[0] == "2026-09-23T07:56:00+07:00"
    raises(lambda: route_times("2026-09-23T07:54:00+07:00", None, now=NOW), "in the past")
    raises(lambda: route_times(None, "2027-10-01T08:00:00+07:00", now=NOW), "more than a year ahead")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

- [ ] **Step 2: Run to watch it fail**

Run: `python backend/runtests.py test_route_time`
Expected: FAIL — `ModuleNotFoundError: No module named 'friday.geo.route_time'`.

- [ ] **Step 3: Implement `backend/friday/geo/route_time.py`**

```python
"""Departure / arrival times for routes (spec 2026-09-23 §4).

One place for both callers: /geo/route is strict (the browser always sends
an offset, so a naive time is a bug), the agent tool assumes the operator's
offset (models write "08:00"). Offsets, not tz names: Windows has no tz
database without tzdata — same reason as tools/system/clock.py.
"""

from datetime import datetime, timedelta, timezone

#: Vietnam, when the operator's browser sent no offset.
DEFAULT_OFFSET_MIN = 7 * 60
#: Clock skew between browser, server and TomTom.
PAST_SLACK = timedelta(minutes=5)
HORIZON = timedelta(days=365)


class RouteTimeError(ValueError):
    """A time the router cannot use; the message says why, for the user."""


def parse_time(value: str, assume_offset_min: int | None = None) -> datetime:
    try:
        dt = datetime.fromisoformat(value.strip())
    except (ValueError, AttributeError) as err:
        raise RouteTimeError(f"'{value}' is not an ISO 8601 time") from err
    if dt.tzinfo is None:
        if assume_offset_min is None:
            raise RouteTimeError(f"'{value}' has no UTC offset")
        dt = dt.replace(tzinfo=timezone(timedelta(minutes=assume_offset_min)))
    return dt


def route_times(
    depart_at: str | None,
    arrive_at: str | None,
    *,
    assume_offset_min: int | None = None,
    now: datetime | None = None,
) -> tuple[str | None, str | None]:
    if depart_at and arrive_at:
        raise RouteTimeError("give a departure time or an arrival time, not both")
    now = now or datetime.now(timezone.utc)
    out: list[str | None] = []
    for value in (depart_at, arrive_at):
        if not value:
            out.append(None)
            continue
        dt = parse_time(value, assume_offset_min)
        if dt < now - PAST_SLACK:
            raise RouteTimeError(f"{dt.isoformat(timespec='minutes')} is in the past")
        if dt > now + HORIZON:
            raise RouteTimeError(f"{dt.isoformat(timespec='minutes')} is more than a year ahead")
        out.append(dt.isoformat(timespec="seconds"))
    return out[0], out[1]
```

- [ ] **Step 4: Run the test**

Run: `python backend/runtests.py test_route_time`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/friday/geo/route_time.py backend/tests/unit/test_route_time.py
git commit -m "feat(geo): departure and arrival time parsing for routes"
```

---

### Task 3: `tomtom.route` options, traffic sections, 2-minute "now" cache

**Files:**
- Modify: `backend/friday/geo/tomtom.py` (imports, `_Lru`, `_cached`, `_normalize`, `route`)
- Test: `backend/tests/unit/test_tomtom.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `tomtom.AVOID = {"tolls": "tollRoads", "motorways": "motorways", "ferries": "ferries", "unpaved": "unpavedRoads"}`, `tomtom.NOW_TTL_S = 120`, `tomtom._now` (monotonic clock, swappable in tests), `async route(waypoints, profile=None, *, avoid=(), depart_at=None, arrive_at=None)`; each route gains `departure_time: str | None`, `arrival_time: str | None`, `traffic_sections: list[{start, end, category, delay_s, magnitude}]`.

- [ ] **Step 1: Failing tests**

In `backend/tests/unit/test_tomtom.py`, in `trip()` add to the summary `"departureTime": "2026-09-23T07:52:00+07:00", "arrivalTime": "2026-09-23T08:01:05+07:00"` and add a top-level key to the returned dict:

```python
        "sections": [
            {"sectionType": "TRAVEL_MODE", "startPointIndex": 0, "endPointIndex": 2, "travelMode": "motorcycle"},
            {"sectionType": "TRAFFIC", "startPointIndex": 0, "endPointIndex": 1, "simpleCategory": "JAM",
             "magnitudeOfDelay": 3, "delayInSeconds": 360, "effectiveSpeedInKmh": 9},
            {"sectionType": "TRAFFIC", "startPointIndex": 1, "endPointIndex": 2, "simpleCategory": "ROAD_CLOSURE",
             "magnitudeOfDelay": 4, "delayInSeconds": 0},
        ],
```

In `test_route_request_and_normalization` add after the existing assertions on `q`:

```python
        assert q["sectionType"] == ["traffic"] and "avoid" not in q and "departAt" not in q
        assert (r["departure_time"], r["arrival_time"]) == ("2026-09-23T07:52:00+07:00", "2026-09-23T08:01:05+07:00")
        assert r["traffic_sections"] == [
            {"start": 0, "end": 1, "category": "jam", "delay_s": 360, "magnitude": 3},
            {"start": 1, "end": 2, "category": "road_closure", "delay_s": 0, "magnitude": 4},
        ], r["traffic_sections"]
```

(`r` is defined further down in that test — put these lines after `r = out["routes"][0]`.)

Append:

```python
def test_route_options_are_sent_and_keyed() -> None:
    def run():
        asyncio.run(tt.route([A, B], "auto", avoid=["tolls", "unpaved"], arrive_at="2026-09-24T08:00:00+07:00"))
        q = CALLS[0]["query"]
        assert sorted(q["avoid"]) == ["tollRoads", "unpavedRoads"], q
        assert q["arriveAt"] == ["2026-09-24T08:00:00+07:00"] and "departAt" not in q
        asyncio.run(tt.route([A, B], "auto", avoid=["unpaved", "tolls"], arrive_at="2026-09-24T08:00:00+07:00"))
        assert len(CALLS) == 1, "avoid order does not matter to the cache"
        asyncio.run(tt.route([A, B], "auto", avoid=["tolls", "unpaved"], depart_at="2026-09-24T08:00:00+07:00"))
        assert len(CALLS) == 2 and CALLS[1]["query"]["departAt"] == ["2026-09-24T08:00:00+07:00"]
        try:
            asyncio.run(tt.route([A, B], "auto", avoid=["cliffs"]))
        except ValueError:
            pass
        else:
            raise AssertionError("unknown avoid value must be refused")
    with_server(run)


def test_now_routes_go_stale_after_two_minutes_timed_ones_do_not() -> None:
    clock = {"t": 1000.0}
    original = tt._now
    tt._now = lambda: clock["t"]

    def run():
        asyncio.run(tt.route([A, B], "auto"))
        asyncio.run(tt.route([A, B], "auto", depart_at="2026-09-24T08:00:00+07:00"))
        clock["t"] += 119
        asyncio.run(tt.route([A, B], "auto"))
        assert len(CALLS) == 2, "still fresh"
        clock["t"] += 2
        asyncio.run(tt.route([A, B], "auto"))
        asyncio.run(tt.route([A, B], "auto", depart_at="2026-09-24T08:00:00+07:00"))
        assert len(CALLS) == 3, "the 'now' route refetched, the timed one did not"
    try:
        with_server(run)
    finally:
        tt._now = original
```

- [ ] **Step 2: Run to watch them fail**

Run: `python backend/runtests.py test_tomtom`
Expected: FAIL — no `sectionType`, `route()` has no `avoid` keyword, no `_now`.

- [ ] **Step 3: Implement**

In `backend/friday/geo/tomtom.py`:

- add `import time` to the imports;
- after `PLACE_REF` add:

```python
#: Contract avoid names (spec 2026-09-23 §3) → TomTom's.
AVOID = {"tolls": "tollRoads", "motorways": "motorways", "ferries": "ferries", "unpaved": "unpavedRoads"}
TRAFFIC_CATEGORY = {"JAM": "jam", "ROAD_WORK": "road_work", "ROAD_CLOSURE": "road_closure"}
#: A route for "now" carries live traffic, which goes stale; timed routes do not.
NOW_TTL_S = 120

#: Monotonic clock for cache expiry; tests swap it.
_now = time.monotonic
```

- replace `_Lru` with:

```python
class _Lru:
    """LRU with optional per-entry expiry (used for live-traffic routes)."""

    def __init__(self, size: int) -> None:
        self.size = size
        self.data: "OrderedDict[str, tuple[Any, float | None]]" = OrderedDict()

    def get(self, key: str) -> Any:
        entry = self.data.get(key)
        if entry is None:
            return None
        value, expires = entry
        if expires is not None and _now() >= expires:
            del self.data[key]
            return None
        self.data.move_to_end(key)
        return value

    def put(self, key: str, value: Any, ttl: float | None = None) -> Any:
        self.data[key] = (value, None if ttl is None else _now() + ttl)
        self.data.move_to_end(key)
        if len(self.data) > self.size:
            self.data.popitem(last=False)
        return value
```

- replace `_cached` with:

```python
async def _cached(name: str, key: str, fetch: Callable[[], Any], ttl: float | None = None) -> Any:
    cache = _CACHES[name]
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, await asyncio.to_thread(fetch), ttl)
```

- in `_normalize`, add to the returned dict (after `traffic_delay_s`):

```python
        "departure_time": summary.get("departureTime"),
        "arrival_time": summary.get("arrivalTime"),
        "traffic_sections": [
            {
                "start": s.get("startPointIndex", 0),
                "end": s.get("endPointIndex", 0),
                "category": TRAFFIC_CATEGORY.get(s.get("simpleCategory"), "other"),
                "delay_s": round(s.get("delayInSeconds", 0)),
                "magnitude": int(s.get("magnitudeOfDelay", 0)),
            }
            for s in route.get("sections", [])
            if s.get("sectionType") == "TRAFFIC"
        ],
```

- replace `route` with:

```python
async def route(
    waypoints: list[dict],
    profile: str | None = None,
    *,
    avoid: list[str] | tuple[str, ...] = (),
    depart_at: str | None = None,
    arrive_at: str | None = None,
) -> dict[str, Any]:
    """Times arrive validated and normalized (geo/route_time.py)."""
    key = _key()
    profile = profile or default_profile()
    if profile not in TRAVEL_MODE:
        raise UnsupportedProfile(profile)
    unknown = [a for a in avoid if a not in AVOID]
    if unknown:
        raise ValueError(f"unknown avoid value(s): {', '.join(unknown)}")
    avoids = sorted(set(avoid))
    stops = ":".join(f"{w['lat']},{w['lon']}" for w in waypoints)
    params: list[tuple[str, str]] = [
        ("key", key), ("travelMode", TRAVEL_MODE[profile]), ("instructionsType", "coded"),
        ("traffic", "true"), ("routeRepresentation", "polyline"), ("sectionType", "traffic"),
    ]
    params += [("avoid", AVOID[a]) for a in avoids]
    if depart_at:
        params.append(("departAt", depart_at))
    elif arrive_at:
        params.append(("arriveAt", arrive_at))
    # Alternatives only between two stops.
    if len(waypoints) == 2:
        params.append(("maxAlternatives", "2"))
    url = f"{_base()}/routing/1/calculateRoute/{stops}/json?{urllib.parse.urlencode(params)}"
    cache_key = json.dumps([
        [(round(w["lat"], 5), round(w["lon"], 5)) for w in waypoints], profile, avoids, depart_at, arrive_at,
    ])
    ttl = NOW_TTL_S if not (depart_at or arrive_at) else None
    raw = await _cached("route", cache_key, lambda: _http(url, no_route_on_400=True), ttl)
    routes = [_normalize(r) for r in raw.get("routes", [])]
    if not routes:
        raise NoRoute("no routes")
    return {"routes": routes}
```

- [ ] **Step 4: Run the tests**

Run: `python backend/runtests.py test_tomtom test_geo_route test_geo_tools`
Expected: PASS (the endpoint and tool still call `route(waypoints, profile)` positionally, which keeps working).

- [ ] **Step 5: Commit**

```bash
git add backend/friday/geo/tomtom.py backend/tests/unit/test_tomtom.py
git commit -m "feat(geo): route avoid options, departure/arrival times and traffic sections"
```

---

### Task 4: `POST /geo/route` accepts the options

**Files:**
- Modify: `backend/friday/api/schemas.py:152-158` (`RouteRequest`), `backend/friday/api/routes.py:706-716` (`geo_route`)
- Test: `backend/tests/integration/test_geo_route.py`

**Interfaces:**
- Consumes: `route_times`, `RouteTimeError` (Task 2); `tomtom.route(..., avoid=, depart_at=, arrive_at=)` (Task 3); `MapAvoid` (Task 1).
- Produces (HTTP): body `{waypoints, profile?, avoid?: MapAvoid[], depart_at?: str, arrive_at?: str}`; 422 for both times, naive time, past, > 1 year, unknown avoid.

- [ ] **Step 1: Failing test**

Append to `backend/tests/integration/test_geo_route.py`:

```python
def test_route_options_pass_through_and_times_are_checked() -> None:
    seen = []

    async def route(waypoints, profile=None, **options):
        seen.append(options)
        return ROUTE

    tt.route = route
    try:
        from datetime import datetime, timedelta, timezone

        soon = (datetime.now(timezone(timedelta(hours=7))) + timedelta(hours=2)).isoformat(timespec="seconds")
        res = client.post("/geo/route", json={"waypoints": [A, B], "avoid": ["tolls", "motorways"], "arrive_at": soon})
        assert res.status_code == 200, res.text
        assert seen[-1] == {"avoid": ["tolls", "motorways"], "depart_at": None, "arrive_at": soon}, seen[-1]
        client.post("/geo/route", json={"waypoints": [A, B]})
        assert seen[-1] == {"avoid": [], "depart_at": None, "arrive_at": None}
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        for body in (
            {"waypoints": [A, B], "depart_at": soon, "arrive_at": soon},  # both
            {"waypoints": [A, B], "depart_at": "2026-09-24T08:00"},       # no offset
            {"waypoints": [A, B], "depart_at": past},                     # past
            {"waypoints": [A, B], "depart_at": "2099-01-01T08:00:00Z"},   # too far
            {"waypoints": [A, B], "avoid": ["cliffs"]},                   # unknown avoid
        ):
            assert client.post("/geo/route", json=body).status_code == 422, body
    finally:
        restore()
```

- [ ] **Step 2: Run to watch it fail**

Run: `python backend/runtests.py test_geo_route`
Expected: FAIL — options are not forwarded / invalid bodies return 200.

- [ ] **Step 3: Implement**

`backend/friday/api/schemas.py`: extend the pydantic import with `model_validator`; `from friday.schemas.visualization import LatLon` → `from friday.schemas.visualization import LatLon, MapAvoid`; add `from friday.geo.route_time import RouteTimeError, route_times`; and add to `RouteRequest`:

```python
    avoid: list[MapAvoid] = Field(default_factory=list, max_length=4)
    #: ISO 8601 with UTC offset — the browser always sends one (spec 2026-09-23 §4.1).
    depart_at: str | None = Field(default=None, max_length=40)
    arrive_at: str | None = Field(default=None, max_length=40)

    @model_validator(mode="after")
    def _times(self) -> "RouteRequest":
        try:
            self.depart_at, self.arrive_at = route_times(self.depart_at, self.arrive_at)
        except RouteTimeError as err:
            raise ValueError(str(err)) from err
        return self
```

If importing `friday.geo.route_time` from `friday.api.schemas` creates an import cycle at startup (run `python -c "import friday.main"` to check), move the two imports inside `_times`.

`backend/friday/api/routes.py`, in `geo_route` replace the `tomtom.route(...)` call with:

```python
        return await tomtom.route(
            [w.model_dump() for w in body.waypoints],
            body.profile,
            avoid=body.avoid,
            depart_at=body.depart_at,
            arrive_at=body.arrive_at,
        )
```

- [ ] **Step 4: Run the tests**

Run: `python backend/runtests.py test_geo_route test_tomtom`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/friday/api/schemas.py backend/friday/api/routes.py backend/tests/integration/test_geo_route.py
git commit -m "feat(api): /geo/route takes avoid options and a checked departure or arrival time"
```

---

### Task 5: `get_directions` with options, times and the motorbike default

**Files:**
- Modify: `backend/friday/geo/tools.py` (`run_get_directions`, `preview_get_directions`, helpers), `backend/friday/tools/registry.py:121-143`
- Test: `backend/tests/unit/test_geo_tools.py`

**Interfaces:**
- Consumes: `route_times`, `RouteTimeError`, `DEFAULT_OFFSET_MIN` (Task 2); `tomtom.route(..., avoid=, depart_at=, arrive_at=)` and the new route fields (Task 3).
- Produces: tool input `avoid`, `depart_at`, `arrive_at`; output adds `avoid`, `depart_at`, `arrive_at`, `departure_time`, `arrival_time` (`{"local": "HH:MM", "iso": str}` or `None`), `jams`; preview `map.route` carries `avoid` (when non-empty) and the time.

- [ ] **Step 1: Failing tests**

In `backend/tests/unit/test_geo_tools.py`:

- `ROUTE`'s route dict gains `"departure_time": "2026-09-23T07:52:00+07:00", "arrival_time": "2026-09-23T08:01:05+07:00", "traffic_sections": [{"start": 0, "end": 1, "category": "jam", "delay_s": 360, "magnitude": 3}, {"start": 1, "end": 2, "category": "road_work", "delay_s": 0, "magnitude": 1}]`.
- `fake()`: `seen = {"search": [], "route": [], "options": []}`, and `route_fn` becomes:

```python
    async def route_fn(waypoints, profile=None, **options):
        seen["route"].append((waypoints, profile))
        seen["options"].append(options)
        if route_exc:
            raise route_exc
        return route
```

- `run()` gains an optional `client` dict merged into the context:

```python
def run(coro, location=None, client=None):
    async def go():
        ctx = {**(client or {}), **({"location": location} if location else {})}
        cm.CLIENT.set(ClientContext(**ctx).model_dump(exclude_none=True) if ctx else {})
        return await coro

    return asyncio.run(go())
```

- In `test_directions_default_to_motorbike_and_cap_steps` add:

```python
    assert seen["options"] == [{"avoid": ["motorways"], "depart_at": None, "arrive_at": None}]
    assert out["avoid"] == ["motorways"] and out["jams"] == 1
    assert out["departure_time"] == {"local": "07:52", "iso": "2026-09-23T07:52:00+07:00"}
    assert out["arrival_time"]["local"] == "08:01"
```

  and change the expected preview route to include `"avoid": ["motorways"]`.

- Append:

```python
def test_explicit_avoid_and_times() -> None:
    seen = fake({"a": [HG], "b": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "a", "to": "b", "profile": "auto", "arrive_at": "2099-01-01T08:00"}))
        assert "more than a year ahead" in out["error"]
        assert seen["route"] == [], "a bad time is refused before any request"

        run(tools.run_get_directions({"from": "a", "to": "b", "avoid": []}))
        assert seen["options"][-1]["avoid"] == [], "explicit [] avoids nothing, even on a motorbike"

        from datetime import datetime, timedelta, timezone

        local = (datetime.now(timezone(timedelta(hours=-5))) + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M")
        out = run(tools.run_get_directions({"from": "a", "to": "b", "profile": "auto", "avoid": ["tolls"],
                                            "depart_at": local}), client={"utc_offset_min": -300})
        assert seen["options"][-1] == {"avoid": ["tolls"], "depart_at": f"{local}:00-05:00", "arrive_at": None}
        route = tools.preview_get_directions(out)["data"]["map"]["route"]
        assert route["avoid"] == ["tolls"] and route["depart_at"] == f"{local}:00-05:00" and "arrive_at" not in route

        local7 = (datetime.now(timezone(timedelta(hours=7))) + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M")
        run(tools.run_get_directions({"from": "a", "to": "b", "arrive_at": local7}))
        assert seen["options"][-1]["arrive_at"] == f"{local7}:00+07:00", "no browser offset → +07:00"

        out = run(tools.run_get_directions({"from": "a", "to": "b", "avoid": ["cliffs"]}))
        assert "avoid" in out["error"]
    finally:
        restore()
```

- [ ] **Step 2: Run to watch them fail**

Run: `python backend/runtests.py test_geo_tools`
Expected: FAIL — no `options`, missing output keys.

- [ ] **Step 3: Implement in `tools.py`**

Imports: `from .route_time import DEFAULT_OFFSET_MIN, RouteTimeError, route_times`. Constants below `MAX_STEPS`:

```python
AVOID_VALUES = ("tolls", "motorways", "ferries", "unpaved")
#: Motorbikes are banned from Vietnamese expressways (spec 2026-09-23 §2).
MOTORBIKE_AVOID = ["motorways"]
```

Helpers below `_is_me`:

```python
def _operator_offset() -> int:
    offset = (CLIENT.get() or {}).get("utc_offset_min")
    return DEFAULT_OFFSET_MIN if offset is None else offset


def _clock(iso: str | None) -> dict[str, str] | None:
    """TomTom answers in the route's local time; HH:MM is what gets spoken."""
    return {"local": iso[11:16], "iso": iso} if iso else None
```

In `run_get_directions`, right after the profile check, add:

```python
    requested_avoid = payload.get("avoid")
    if requested_avoid is None:
        avoid = list(MOTORBIKE_AVOID) if profile == "motor_scooter" else []
    else:
        unknown = [a for a in requested_avoid if a not in AVOID_VALUES]
        if unknown:
            return {"error": f"unknown avoid value(s): {', '.join(map(str, unknown))}; use {', '.join(AVOID_VALUES)}"}
        avoid = sorted(set(requested_avoid))
    try:
        depart_at, arrive_at = route_times(
            payload.get("depart_at"), payload.get("arrive_at"), assume_offset_min=_operator_offset()
        )
    except RouteTimeError as err:
        # Checked before any geocoding, so a bad time costs no quota.
        return {"error": str(err)}
```

change the routing call to:

```python
        result = await tomtom.route(
            [{"lat": s["lat"], "lon": s["lon"]} for s in stops],
            profile,
            avoid=avoid,
            depart_at=depart_at,
            arrive_at=arrive_at,
        )
```

and add to the returned dict (after `"traffic_delay_min"`):

```python
        "avoid": avoid,
        "depart_at": depart_at,
        "arrive_at": arrive_at,
        "departure_time": _clock(best.get("departure_time")),
        "arrival_time": _clock(best.get("arrival_time")),
        "jams": sum(1 for s in best.get("traffic_sections", []) if s["category"] == "jam"),
```

In `preview_get_directions`, build the route dict with the options:

```python
    route: dict[str, Any] = {
        "profile": output["profile"],
        "waypoints": [{"lat": s["lat"], "lon": s["lon"], "label": s["label"]} for s in stops],
    }
    if output.get("avoid"):
        route["avoid"] = output["avoid"]
    for key in ("depart_at", "arrive_at"):
        if output.get(key):
            route[key] = output[key]
```

and use `"map": {"route": route}` in the returned spec.

- [ ] **Step 4: Registry**

In the `get_directions` entry of `backend/friday/tools/registry.py`:

```python
            description=(
                "Directions between places, shown on the street map with "
                "distance, time, departure/arrival clock times and the current "
                "traffic delay. from/to are place names or 'my_location'. "
                "profile: motor_scooter (default, xe máy), auto (car), bicycle, "
                "pedestrian. Use arrive_at when the user asks when to leave to "
                "arrive on time, depart_at for a later departure; call "
                "get_current_time first if you need today's date."
            ),
```

and add to `input_schema.properties`:

```python
                    "avoid": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["tolls", "motorways", "ferries", "unpaved"]},
                        "description": "roads to avoid. Omit for the default (motorbikes avoid motorways, "
                                       "which are closed to them in Vietnam); [] avoids nothing",
                    },
                    "depart_at": {
                        "type": "string",
                        "description": "ISO 8601 departure time, e.g. 2026-09-24T08:00; the operator's UTC "
                                       "offset is assumed when none is given. Never together with arrive_at",
                    },
                    "arrive_at": {
                        "type": "string",
                        "description": "ISO 8601 arrival deadline, same format. Never together with depart_at",
                    },
```

- [ ] **Step 5: Run the backend suite**

Run: `python backend/runtests.py`
Expected: PASS (including `test_map_preview_pin` and `test_contracts`).

- [ ] **Step 6: Commit**

```bash
git add backend/friday/geo/tools.py backend/friday/tools/registry.py backend/tests/unit/test_geo_tools.py
git commit -m "feat(geo): get_directions takes avoid options and departure or arrival times"
```

---

### Task 6: Frontend API — options, times, incidents, traffic segments

**Files:**
- Modify: `src/components/friday/map/mapApi.ts`
- Test: `tests/unit/mapApi.spec.ts`

**Interfaces:**
- Consumes: `/geo/route` options and route fields (Tasks 3–4); `MapAvoid` (Task 1).
- Produces (`mapApi.ts`): `AVOID_ORDER: MapAvoid[]`, `AVOID_LABELS: Record<MapAvoid, string>`, `defaultAvoid(profile): MapAvoid[]`, `avoidForProfile(avoid, from, to): MapAvoid[]`, `type RouteTime = { kind: "now" } | { kind: "depart" | "arrive"; at: string }`, `interface RouteOptions { avoid: MapAvoid[]; time: RouteTime }`, `interface TrafficSection { start; end; category: "jam" | "road_work" | "road_closure" | "other"; delay_s; magnitude }`, `Route.departure_time?: string | null`, `Route.arrival_time?: string | null`, `Route.traffic_sections: TrafficSection[]`, `fetchRoute(stops, profile, options: RouteOptions, signal?)`, `toOffsetIso(local, offsetMin?)`, `nextQuarterHourLocal(now?)`, `formatClock(iso)`, `trafficSegments(route): GeoJSON.FeatureCollection<GeoJSON.LineString, { magnitude: number; closure: boolean }>`; `styleUrl(id, true)` adds `traffic_incidents`.

- [ ] **Step 1: Failing tests**

In `tests/unit/mapApi.spec.ts`: add to the import `avoidForProfile, defaultAvoid, formatClock, nextQuarterHourLocal, toOffsetIso, trafficSegments`; add `traffic_sections: []` to the existing `route` fixture; extend the style test with

```ts
  const traffic = decodeURIComponent(styleUrl("dark", true));
  expect(traffic).toContain("traffic_flow=2/flow_relative-dark");
  expect(traffic).toContain("traffic_incidents=2/incidents_dark");
  expect(decodeURIComponent(styleUrl("light", true))).toContain("traffic_incidents=2/incidents_light");
  expect(styleUrl("dark")).not.toContain("traffic_incidents");
```

and append:

```ts
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
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement in `mapApi.ts`**

- `import type { MapAvoid, MapProfile } from "@/lib/visualization/types";`
- `STYLES` entries gain `incidents`: dark `"2/incidents_dark"`, light `"2/incidents_light"`, satellite `"2/incidents_dark"`; in `styleUrl`:

```ts
  if (traffic) {
    params.set("traffic_flow", s.flow);
    params.set("traffic_incidents", s.incidents);
  }
```

- after `PROFILE_LABELS` add:

```ts
export const AVOID_ORDER: MapAvoid[] = ["tolls", "motorways", "ferries", "unpaved"];
export const AVOID_LABELS: Record<MapAvoid, string> = {
  tolls: "Tránh trạm thu phí",
  motorways: "Tránh cao tốc",
  ferries: "Tránh phà",
  unpaved: "Tránh đường đất",
};

/** Motorbikes are banned from Vietnamese expressways (spec 2026-09-23 §2). */
export function defaultAvoid(profile: MapProfile): MapAvoid[] {
  return profile === "motor_scooter" ? ["motorways"] : [];
}

/** Switching mode keeps the user's choices but moves the motorbike motorway rule with it. */
export function avoidForProfile(avoid: MapAvoid[], from: MapProfile, to: MapProfile): MapAvoid[] {
  const kept = from === "motor_scooter" ? avoid.filter((a) => a !== "motorways") : avoid;
  return to === "motor_scooter" && !kept.includes("motorways") ? [...kept, "motorways"] : kept;
}

export type RouteTime = { kind: "now" } | { kind: "depart" | "arrive"; at: string };

export interface RouteOptions {
  avoid: MapAvoid[];
  time: RouteTime;
}

/** `<input type="datetime-local">` value (no offset) → ISO with the browser's offset. */
export function toOffsetIso(local: string, offsetMin = -new Date(local).getTimezoneOffset()): string {
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const base = local.length === 16 ? `${local}:00` : local;
  return `${base}${sign}${hh}:${mm}`;
}

/** Default for a newly picked time: the next quarter hour, as a datetime-local value. */
export function nextQuarterHourLocal(now = new Date()): string {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** HH:MM of an ISO time as written (TomTom answers in the route's local time). */
export function formatClock(iso: string): string {
  return iso.slice(11, 16);
}
```

- in the routing section add, and extend `Route`:

```ts
export interface TrafficSection {
  start: number;
  end: number;
  category: "jam" | "road_work" | "road_closure" | "other";
  delay_s: number;
  /** 0 unknown, 1 minor … 4 indefinite (TomTom magnitudeOfDelay). */
  magnitude: number;
}
```

```ts
  departure_time?: string | null;
  arrival_time?: string | null;
  traffic_sections: TrafficSection[];
```

- `fetchRoute` takes the options:

```ts
export async function fetchRoute(
  stops: Endpoint[],
  profile: MapProfile,
  options: RouteOptions,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const { time } = options;
  const body = {
    waypoints: stops.map(({ lat, lon }) => ({ lat, lon })),
    profile,
    avoid: options.avoid,
    ...(time.kind === "depart" ? { depart_at: time.at } : {}),
    ...(time.kind === "arrive" ? { arrive_at: time.at } : {}),
  };
```

  and send `body: JSON.stringify(body)` in the existing `fetch` call.

- after `stepCoordinates` add:

```ts
/** Congested stretches of one route as line features for the overlay layers. */
export function trafficSegments(route: Route): GeoJSON.FeatureCollection<GeoJSON.LineString, { magnitude: number; closure: boolean }> {
  return {
    type: "FeatureCollection",
    features: (route.traffic_sections ?? []).flatMap((s) => {
      const coordinates = route.coordinates.slice(s.start, s.end + 1);
      if (coordinates.length < 2) return [];
      return [{
        type: "Feature" as const,
        properties: { magnitude: s.magnitude, closure: s.category === "road_closure" },
        geometry: { type: "LineString" as const, coordinates },
      }];
    }),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts` → PASS. `npm run typecheck` will now fail only in `DirectionsPanel.tsx` (the `fetchRoute` call) — fixed in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/components/friday/map/mapApi.ts tests/unit/mapApi.spec.ts
git commit -m "feat(map): route options, times, incidents and traffic segments in the map API"
```

---

### Task 7: Directions panel — time, options, congestion overlay

**Files:**
- Modify: `src/components/friday/map/DirectionsPanel.tsx`, `src/components/friday/map/MapLayer.tsx:27-31,141-150,251-255,364,375`
- Test: `tests/ui/map.spec.ts`, `tests/ui/stubOrchestrator.ts`

**Interfaces:**
- Consumes: everything Task 6 produces.
- Produces: `DirectionsValue = { profile; stops; avoid: MapAvoid[]; time: RouteTime }`; map layers `friday-route-traffic`, `friday-route-closure`; DOM `select[aria-label="Thời gian"]`, `input[aria-label="Chọn giờ"]`, checkboxes labelled per `AVOID_LABELS`, `data-testid="directions-times"`.

- [ ] **Step 1: Stub + failing UI tests**

`tests/ui/stubOrchestrator.ts`, `MAP_ROUTE_SPEC.data.map.route`: add `avoid: ["motorways"],`.

`tests/ui/map.spec.ts`, `ROUTE.routes[0]`: add `departure_time: "2026-09-23T07:52:00+07:00", arrival_time: "2026-09-23T08:01:05+07:00", traffic_sections: [{ start: 0, end: 1, category: "jam", delay_s: 360, magnitude: 3 }],` and `traffic_sections: []` to `routes[1]`. In the test `"an agent route opens directions with the summary, steps and route layers"`:

- before the steps assertion add:

```ts
    await expect(panel.getByLabel("Tránh cao tốc")).toBeChecked(); // from the agent spec
    await expect(page.getByTestId("directions-times")).toHaveText("Khởi hành 07:52 → Đến 08:01");
```

- extend the layer check to `&& !!m?.getLayer("friday-route-traffic")`;
- replace the pedestrian `waitForRequest` predicate with:

```ts
    const asked = page.waitForRequest((r) => {
      if (!r.url().endsWith("/geo/route")) return false;
      const body = r.postDataJSON();
      return body.profile === "pedestrian" && body.avoid.length === 0;
    });
```

Append:

```ts
test("arrive-by sends arrive_at with an offset; motorbike brings back the motorway rule", async ({ page }) => {
  await stubTomTom(page);
  await page.route("**/geo/route", (r) => r.fulfill({ json: ROUTE }));
  const stub = await startStubOrchestrator(MAP_FLOW);
  try {
    await gotoLitScene(page);
    await page.locator("input").click();
    await page.locator("input").pressSequentially("chỉ đường tới lăng bác", { delay: 15 });
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("directions-panel");
    await expect(page.getByTestId("directions-summary")).toContainText("9 phút", { timeout: 20_000 });

    const arrive = page.waitForRequest((r) => {
      if (!r.url().endsWith("/geo/route")) return false;
      const body = r.postDataJSON();
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/.test(body.arrive_at ?? "") && !("depart_at" in body);
    });
    await panel.getByLabel("Thời gian").selectOption("arrive");
    await arrive;
    await expect(panel.getByLabel("Chọn giờ")).toBeVisible();

    await panel.getByRole("tab", { name: "🚗 Ô tô" }).click();
    await expect(panel.getByLabel("Tránh cao tốc")).not.toBeChecked();
    await panel.getByRole("tab", { name: "🛵 Xe máy" }).click();
    await expect(panel.getByLabel("Tránh cao tốc")).toBeChecked();
  } finally {
    await stub.close();
  }
});
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts -g "agent route|arrive-by"`
Expected: FAIL — no time select, no options, no traffic layer.

- [ ] **Step 3: `MapLayer.tsx`**

- Import `defaultAvoid, type RouteTime` from `./mapApi` (add to the existing import) and `type MapAvoid` from `@/lib/visualization/types` (next to `MapProfile`).
- `DirectionsValue` becomes:

```tsx
export interface DirectionsValue {
  profile: MapProfile;
  /** First is "from", last is "to"; null = not chosen yet. */
  stops: (Endpoint | null)[];
  avoid: MapAvoid[];
  time: RouteTime;
}

function newDirections(profile: MapProfile, stops: (Endpoint | null)[]): DirectionsValue {
  return { profile, stops, avoid: defaultAvoid(profile), time: { kind: "now" } };
}
```

- The agent-spec branch (`setDirections({ profile: view.route.profile, stops: … })`) becomes:

```tsx
      const r = view.route;
      setDirections({
        profile: r.profile,
        stops: r.waypoints.map((w) => ({
          lat: w.lat,
          lon: w.lon,
          label: w.label ?? `${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`,
        })),
        avoid: r.avoid ?? defaultAvoid(r.profile),
        time: r.depart_at ? { kind: "depart", at: r.depart_at } : r.arrive_at ? { kind: "arrive", at: r.arrive_at } : { kind: "now" },
      });
```

- `directionsTo` / `directionsFrom`:

```tsx
    setDirections((d) => ({ ...(d ?? newDirections(profiles[0], [])), stops: [d?.stops[0] ?? myLocationEndpoint(), to] }));
```
```tsx
    setDirections((d) => ({ ...(d ?? newDirections(profiles[0], [])), stops: [from, d?.stops.at(-1) ?? null] }));
```

- the ↱ button: `setDirections(newDirections(profiles[0], [myLocationEndpoint(), to]));`

- [ ] **Step 4: `DirectionsPanel.tsx`**

- Import from `./mapApi` additionally: `AVOID_LABELS, AVOID_ORDER, avoidForProfile, formatClock, nextQuarterHourLocal, toOffsetIso, trafficSegments, type RouteTime`.
- Constants: `const TRAFFIC_SRC = "friday-route-traffic";`.
- `drawRoutes(map, routes, selected, step)` — also draw the selected route's congestion. Replace its body with:

```tsx
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
```

- `clearRoutes`: layer ids `["friday-route-step", "friday-route-closure", "friday-route-traffic", "friday-route-line", "friday-route-casing"]`, sources `[STEP_SRC, TRAFFIC_SRC, ROUTE_SRC]`.
- The fetch effect: `fetchRoute(stops, value.profile, { avoid: value.avoid, time: value.time }, ctrl.signal)`.
- Profile tab `onClick`: `onChange({ ...value, profile: p, avoid: avoidForProfile(value.avoid, value.profile, p) })`.
- Before the `return (`, add:

```tsx
  const at = value.time.kind === "now" ? null : value.time.at;
  const setTime = (kind: RouteTime["kind"]) =>
    onChange({ ...value, time: kind === "now" ? { kind } : { kind, at: at ?? toOffsetIso(nextQuarterHourLocal()) } });
  const toggleAvoid = (a: MapAvoid, on: boolean) =>
    onChange({ ...value, avoid: on ? [...value.avoid, a] : value.avoid.filter((x) => x !== a) });
```

  (add `type MapAvoid` to the `@/lib/visualization/types` import).

- Between the tablist `</div>` and the stops `<div className="flex items-center gap-2">`, insert:

```tsx
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
```

- After the `directions-summary` `</div>`, insert:

```tsx
          {best.departure_time && best.arrival_time && (
            <div data-testid="directions-times" className="mt-1 text-xs text-slate-300">
              {/* With "Đến lúc" the departure time is the answer (spec 2026-09-23 §5.2). */}
              <span className={value.time.kind === "arrive" ? "font-semibold text-cyan-200" : undefined}>
                Khởi hành {formatClock(best.departure_time)}
              </span>{" "}
              → Đến {formatClock(best.arrival_time)}
            </div>
          )}
```

- [ ] **Step 5: Run the tests**

Run: `npm run lint && npm run typecheck` → clean.
Run: `npx playwright test --project=ui tests/ui/map.spec.ts` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/friday/map tests/ui/map.spec.ts tests/ui/stubOrchestrator.ts
git commit -m "feat(map): depart/arrive times, avoid options and congestion on the route"
```

---

### Task 8: Live check and full verification

**Files:** none unless the live check reveals a mismatch.

- [ ] **Step 1: Live probe (real key in `backend/.env`)**

```bash
K=$(grep ^TOMTOM_API_KEY backend/.env | cut -d= -f2)
curl -s "https://api.tomtom.com/routing/1/calculateRoute/21.0288,105.8525:21.0368,105.8346/json?key=$K&travelMode=motorcycle&sectionType=traffic&avoid=motorways&avoid=tollRoads&arriveAt=$(date -d '+1 day 08:00' +%Y-%m-%dT%H:%M:00%:z)" | python -c "import json,sys; d=json.load(sys.stdin); r=d['routes'][0]; print(r['summary'].get('departureTime'), r['summary'].get('arrivalTime')); print([s for s in r.get('sections',[]) if s.get('sectionType')=='TRAFFIC'][:3])"
```

Confirm `departureTime`/`arrivalTime` are present and `sections[].sectionType` is `"TRAFFIC"` with `simpleCategory`/`magnitudeOfDelay`. If the live names differ, fix `_normalize` and the fixture together, re-run `python backend/runtests.py test_tomtom`.

- [ ] **Step 2: Manual check in the browser preview**

With both TomTom keys set, run the backend and the dev server (`.claude/launch.json`). Check: the Giao thông toggle shows incident icons; a motorbike route has "Tránh cao tốc" ticked; "Đến lúc" + a time shows "Khởi hành … → Đến …" with the departure emphasised; ticking "Tránh trạm thu phí" reroutes; congested stretches are coloured on the selected route; asking FRIDAY "8h sáng mai đi từ Hồ Gươm tới Lăng Bác bằng ô tô, tránh trạm thu phí" opens the panel with those options. Screenshot for the PR.

- [ ] **Step 3: Full verification**

Run: `npm run verify`
Expected: lint, typecheck, unit, backend, contracts and UI suites all PASS.

- [ ] **Step 4: Commit (only if Step 1 or 2 required a fix)**

```bash
git add -A backend src tests
git commit -m "fix(map): align route options with the live TomTom response"
```
