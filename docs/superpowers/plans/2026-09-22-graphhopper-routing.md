# GraphHopper Routing Migration Plan (delta)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the self-hosted Valhalla routing that `feat/maplibre-map` already ships with GraphHopper Cloud, so directions work on the deployed backend with nothing to host.

**Architecture:** Only the routing provider changes. `backend/friday/geo/valhalla.py` becomes `graphhopper.py` behind the same `/geo/route` proxy (plus a new `GET /geo/profiles`); the backend normalizes GraphHopper's answer into a flatter route shape (`coordinates` + `maneuvers`, no encoded polyline, no legs), and the map UI shows only the travel modes the key's plan allows. Everything else from the first plan (map layer, handoff, search, place card, previews) is untouched.

**Tech Stack:** GraphHopper Cloud Routing API (`https://graphhopper.com/api/1/route`), FastAPI + `urllib` (existing pattern), maplibre-gl 6 (existing), Playwright + plain-python tests (existing).

**Spec:** `docs/superpowers/specs/2026-09-21-maplibre-map-design.md` (revised 2026-09-22 — §2, §4.2, §6, §7). The first plan, `docs/superpowers/plans/2026-09-21-maplibre-map.md`, describes what is already built on this branch; this plan is the delta on top of it.

## Global Constraints

- Provider: GraphHopper Cloud. `GRAPHHOPPER_API_KEY` is backend-only (never in the browser); unset = directions off, everything else works.
- Free plan: 500 credits/day, car/bike/foot only, non-commercial. `GRAPHHOPPER_PROFILES` (default `car,bike,foot`) lists what the plan allows; adding `scooter` enables motorbike with no code change.
- Contract profiles stay `"auto" | "motor_scooter" | "bicycle" | "pedestrian"`, mapped `auto→car`, `motor_scooter→scooter`, `bicycle→bike`, `pedestrian→foot`.
- Default profile = first allowed in the order `motor_scooter, auto, bicycle, pedestrian` → **`auto` on the free plan**. Wire/schema fallback for a missing or unknown profile: `auto`.
- Instructions: `locale=vi`. Coordinates: `points_encoded=false`, `[lon, lat]`, rounded to 6 decimals by the backend.
- Route wire shape (backend → frontend): `{"routes": [{"distance_m", "duration_s", "coordinates": [[lon, lat]], "maneuvers": [{"instruction", "sign", "distance_m", "duration_s", "begin_shape_index"}]}]}`.
- Errors: 503 `routing_unavailable` (no key, 401, 429, 5xx, unreachable), 422 `no_route` (GraphHopper 400), 422 `unsupported_profile` (mode not on the plan — refused before any request).
- No new dependencies. No test touches the real network.
- Commits: conventional prefix, **no `Co-Authored-By` trailer**. Done = `npm run verify` green.

## What is removed

`backend/friday/geo/valhalla.py`, `backend/tests/unit/test_valhalla.py`, `docker/valhalla/`, the `dev:valhalla` npm script, `VALHALLA_URL`, and the frontend polyline6 decoder (`decodePolyline6`, `routeCoordinates`, `RouteLeg`).

## File Structure

- Create: `backend/friday/geo/graphhopper.py`, `backend/tests/unit/test_graphhopper.py`
- Delete: `backend/friday/geo/valhalla.py`, `backend/tests/unit/test_valhalla.py`, `docker/valhalla/compose.yml`
- Modify (backend): `backend/friday/geo/__init__.py`, `backend/friday/geo/tools.py`, `backend/friday/api/routes.py`, `backend/friday/api/schemas.py`, `backend/friday/schemas/visualization.py`, `backend/friday/tools/registry.py`, `backend/.env.example`, `backend/render.yaml`, `backend/README.md`, `backend/tests/integration/test_geo_route.py`, `backend/tests/unit/test_geo_tools.py`, `backend/tests/unit/test_contracts.py`
- Modify (frontend): `src/lib/visualization/types.ts`, `src/lib/visualization/normalization.ts`, `contracts/visualization/visualization.v1.json`, `src/components/friday/map/mapApi.ts`, `src/components/friday/map/DirectionsPanel.tsx`, `src/components/friday/map/MapLayer.tsx`, `tests/unit/mapApi.spec.ts`, `tests/unit/vizNormalize.spec.ts`, `tests/ui/map.spec.ts`, `tests/ui/stubOrchestrator.ts`
- Modify (repo): `package.json`, `.env.example`, `README.md`, `docs/ARCHITECTURE.md`

---

### Task 1: Contract default profile → `auto`

The wire default must be a mode every plan has; `motor_scooter` is not on the free plan.

**Files:**
- Modify: `src/lib/visualization/types.ts:69`, `src/lib/visualization/normalization.ts:89`, `backend/friday/schemas/visualization.py:85`, `contracts/visualization/visualization.v1.json:117`
- Test: `tests/unit/vizNormalize.spec.ts:169`, `backend/tests/unit/test_contracts.py:226`

**Interfaces:**
- Produces: `MapRoute.profile` default `"auto"` (Python + JSON); `sanitizeMapView` falls back to `"auto"`.

- [ ] **Step 1: Update the tests first**

In `tests/unit/vizNormalize.spec.ts` change the expectation on line 169 to

```ts
  ).toEqual({ route: { profile: "auto", waypoints: [{ lat: 1, lon: 1 }, { lat: 3, lon: 3 }] } });
```

and the comment above that test that says the unknown profile falls back to motorbike to `// an unknown profile falls back to car (on every plan)`.

In `backend/tests/unit/test_contracts.py` line 226:

```python
    assert MapRoute.model_fields["profile"].default == "auto"
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=unit tests/unit/vizNormalize.spec.ts` and `python backend/runtests.py test_contracts`
Expected: FAIL — `motor_scooter` received where `auto` is expected.

- [ ] **Step 3: Change the defaults**

- `src/lib/visualization/normalization.ts:89`: `... ? (r.profile as MapProfile) : "auto";`
- `src/lib/visualization/types.ts:69`: comment becomes `/** Travel mode for a map route (spec §5); the backend maps these to GraphHopper profiles. */`
- `backend/friday/schemas/visualization.py:85`: `profile: Literal["auto", "motor_scooter", "bicycle", "pedestrian"] = "auto"`
- `contracts/visualization/visualization.v1.json:117`: `"default": "auto"`

- [ ] **Step 4: Run the tests**

Run: `npx playwright test --project=unit tests/unit/vizNormalize.spec.ts tests/unit/contracts.spec.ts` and `python backend/runtests.py test_contracts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visualization contracts/visualization backend/friday/schemas/visualization.py tests/unit/vizNormalize.spec.ts backend/tests/unit/test_contracts.py
git commit -m "fix(viz): map routes default to car, the one mode every routing plan has"
```

---

### Task 2: GraphHopper client, `/geo/route` and `/geo/profiles`

**Files:**
- Create: `backend/friday/geo/graphhopper.py`, `backend/tests/unit/test_graphhopper.py`
- Delete: `backend/friday/geo/valhalla.py`, `backend/tests/unit/test_valhalla.py`, `docker/valhalla/compose.yml`
- Modify: `backend/friday/geo/__init__.py`, `backend/friday/api/schemas.py:152-156`, `backend/friday/api/routes.py:20,658-668`, `backend/tests/integration/test_geo_route.py`, `backend/.env.example:130-132`, `package.json:12`

**Interfaces:**
- Produces (`friday.geo.graphhopper`): `PROFILE_ORDER`, `GH_PROFILE`, `RoutingUnavailable`, `NoRoute`, `UnsupportedProfile`, `available_profiles() -> list[str]`, `default_profile() -> str`, `clear_cache()`, `async route(waypoints: list[dict], profile: str | None = None, locale: str = "vi") -> dict` (shape in Global Constraints).
- Produces (HTTP): `POST /geo/route` (profile optional → plan default; adds 422 `unsupported_profile`), `GET /geo/profiles` → `{"profiles": [...]}`.

- [ ] **Step 1: Write the failing unit test**

Create `backend/tests/unit/test_graphhopper.py`:

```python
"""GraphHopper Cloud client: request shape, normalization, errors, cache.
A local fake stands in for graphhopper.com — no external network.

    PYTHONPATH=. python tests/unit/test_graphhopper.py
"""

import asyncio
import json
import os
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from friday.geo import graphhopper as gh

# Shaped like the documented /route response with points_encoded=false
# (distance in m, time in ms, GeoJSON [lon, lat] points).
PATH = {
    "distance": 2412.3,
    "time": 545_400,
    "points": {"type": "LineString", "coordinates": [[105.8525, 21.0288], [105.843, 21.033], [105.8346, 21.0368]]},
    "instructions": [
        {"text": "Đi về hướng tây", "sign": 0, "distance": 1100.2, "time": 250_000, "interval": [0, 1]},
        {"text": "Đến nơi", "sign": 4, "distance": 0, "time": 0, "interval": [2, 2]},
    ],
}
CALLS: list[dict] = []
MODE = {"status": 200}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        CALLS.append(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query))
        status = MODE["status"]
        if status == 400:
            payload = {"message": "Connection between locations not found"}
        elif status != 200:
            payload = {"message": "nope"}
        else:
            payload = {"paths": [PATH, PATH]}
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


ENV = ("GRAPHHOPPER_API_KEY", "GRAPHHOPPER_PROFILES", "FRIDAY_GRAPHHOPPER_URL")


def with_server(fn, profiles=None):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    old = {k: os.environ.get(k) for k in ENV}
    os.environ["GRAPHHOPPER_API_KEY"] = "test-key"
    os.environ["FRIDAY_GRAPHHOPPER_URL"] = f"http://127.0.0.1:{server.server_address[1]}/api/1"
    if profiles is None:
        os.environ.pop("GRAPHHOPPER_PROFILES", None)
    else:
        os.environ["GRAPHHOPPER_PROFILES"] = profiles
    CALLS.clear()
    MODE["status"] = 200
    gh.clear_cache()
    try:
        fn()
    finally:
        server.shutdown()
        server.server_close()
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


A = {"lat": 21.0288, "lon": 105.8525}
B = {"lat": 21.0368, "lon": 105.8346}


def test_free_plan_profiles_default_to_car() -> None:
    def run():
        assert gh.available_profiles() == ["auto", "bicycle", "pedestrian"]
        assert gh.default_profile() == "auto"
    with_server(run)


def test_paid_plan_puts_motorbike_first() -> None:
    def run():
        assert gh.available_profiles() == ["motor_scooter", "auto", "bicycle", "pedestrian"]
        assert gh.default_profile() == "motor_scooter"
    with_server(run, profiles="car, bike, foot, scooter")


def test_request_shape_and_normalization() -> None:
    def run():
        out = asyncio.run(gh.route([A, B]))
        q = CALLS[0]
        assert q["point"] == ["21.0288,105.8525", "21.0368,105.8346"], q
        assert q["profile"] == ["car"] and q["locale"] == ["vi"] and q["key"] == ["test-key"]
        assert q["points_encoded"] == ["false"] and q["instructions"] == ["true"]
        assert q["algorithm"] == ["alternative_route"] and q["alternative_route.max_paths"] == ["3"]
        assert len(out["routes"]) == 2
        r = out["routes"][0]
        assert (r["distance_m"], r["duration_s"]) == (2412, 545), r
        assert r["coordinates"][1] == [105.843, 21.033]
        assert r["maneuvers"][0] == {
            "instruction": "Đi về hướng tây", "sign": 0, "distance_m": 1100,
            "duration_s": 250, "begin_shape_index": 0,
        }, r
    with_server(run)


def test_via_points_skip_alternatives() -> None:
    def run():
        asyncio.run(gh.route([A, {"lat": 21.03, "lon": 105.84}, B], "pedestrian"))
        q = CALLS[0]
        assert len(q["point"]) == 3 and "algorithm" not in q and q["profile"] == ["foot"]
    with_server(run)


def test_unconfigured_profile_is_refused_before_any_call() -> None:
    def run():
        try:
            asyncio.run(gh.route([A, B], "motor_scooter"))
        except gh.UnsupportedProfile:
            pass
        else:
            raise AssertionError("scooter is not on the free plan")
        assert CALLS == []
    with_server(run)


def test_cache_saves_credits_on_rounded_input() -> None:
    def run():
        asyncio.run(gh.route([A, B]))
        asyncio.run(gh.route([{"lat": 21.028800001, "lon": 105.8525}, B]))
        assert len(CALLS) == 1, CALLS
        asyncio.run(gh.route([A, B], "bicycle"))
        assert len(CALLS) == 2
    with_server(run)


def test_error_mapping() -> None:
    def run():
        for status, exc in ((400, gh.NoRoute), (401, gh.RoutingUnavailable), (429, gh.RoutingUnavailable), (500, gh.RoutingUnavailable)):
            MODE["status"] = status
            gh.clear_cache()
            try:
                asyncio.run(gh.route([A, B]))
            except exc:
                continue
            raise AssertionError(f"{status} must raise {exc.__name__}")
    with_server(run)


def test_no_key_or_unreachable_is_unavailable() -> None:
    old = {k: os.environ.get(k) for k in ENV}
    try:
        os.environ.pop("GRAPHHOPPER_API_KEY", None)
        try:
            asyncio.run(gh.route([A, B]))
        except gh.RoutingUnavailable:
            pass
        else:
            raise AssertionError("no key must be RoutingUnavailable")
        os.environ["GRAPHHOPPER_API_KEY"] = "k"
        os.environ["FRIDAY_GRAPHHOPPER_URL"] = "http://127.0.0.1:9/api/1"  # discard port
        gh.clear_cache()
        try:
            asyncio.run(gh.route([A, B]))
        except gh.RoutingUnavailable:
            pass
        else:
            raise AssertionError("unreachable must be RoutingUnavailable")
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

- [ ] **Step 2: Rewrite the integration test**

Replace the whole of `backend/tests/integration/test_geo_route.py` with:

```python
"""POST /geo/route and GET /geo/profiles — validation, errors, origin guard.

    PYTHONPATH=. python tests/integration/test_geo_route.py
"""

import os

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"

from fastapi.testclient import TestClient

from friday.geo import graphhopper as gh
from friday.main import app

client = TestClient(app)
A = {"lat": 21.0288, "lon": 105.8525}
B = {"lat": 21.0368, "lon": 105.8346}
ROUTE = {"routes": [{"distance_m": 2412, "duration_s": 545, "coordinates": [], "maneuvers": []}]}
ORIGINAL = gh.route


def fake_route(result=None, exc=None):
    calls = []

    async def route(waypoints, profile=None, locale="vi"):
        calls.append((waypoints, profile))
        if exc is not None:
            raise exc
        return result

    gh.route = route
    return calls


def test_happy_path_passes_the_profile_through() -> None:
    calls = fake_route(ROUTE)
    try:
        res = client.post("/geo/route", json={"waypoints": [A, B]})
        client.post("/geo/route", json={"waypoints": [A, B], "profile": "bicycle"})
    finally:
        gh.route = ORIGINAL
    assert res.status_code == 200 and res.json() == ROUTE, res.text
    # no profile → the client picks the plan's default
    assert calls == [([A, B], None), ([A, B], "bicycle")]


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
        gh.route = ORIGINAL


def test_error_mapping() -> None:
    try:
        for exc, status, body in (
            (gh.RoutingUnavailable("no key"), 503, {"error": "routing_unavailable"}),
            (gh.NoRoute("Connection between locations not found"), 422, {"error": "no_route"}),
            (gh.UnsupportedProfile("motor_scooter"), 422, {"error": "unsupported_profile"}),
        ):
            fake_route(exc=exc)
            res = client.post("/geo/route", json={"waypoints": [A, B]})
            assert res.status_code == status and res.json() == body, res.text
    finally:
        gh.route = ORIGINAL


def test_profiles_endpoint() -> None:
    old = os.environ.pop("GRAPHHOPPER_PROFILES", None)
    try:
        assert client.get("/geo/profiles").json() == {"profiles": ["auto", "bicycle", "pedestrian"]}
    finally:
        if old is not None:
            os.environ["GRAPHHOPPER_PROFILES"] = old


def test_origin_guard() -> None:
    fake_route(ROUTE)
    try:
        res = client.post("/geo/route", json={"waypoints": [A, B]}, headers={"origin": "https://evil.example"})
    finally:
        gh.route = ORIGINAL
    assert res.status_code == 403


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

- [ ] **Step 3: Run to watch them fail**

Run: `python backend/runtests.py test_graphhopper test_geo_route`
Expected: FAIL — `ImportError: cannot import name 'graphhopper' from 'friday.geo'`.

- [ ] **Step 4: Implement the client**

Create `backend/friday/geo/graphhopper.py`:

```python
"""GraphHopper Cloud routing (spec §6.2) — hosted, keyed, optional.

No GRAPHHOPPER_API_KEY means routing is off, not broken: callers get
RoutingUnavailable and say so plainly. The key never leaves this process;
the browser asks /geo/route. Same urllib + to_thread shape as
tools/integrations/fetch.py — no HTTP dependency for one GET.

The free plan routes car, bike and foot only. GRAPHHOPPER_PROFILES lists
what the key's plan allows; add "scooter" on a paid plan and the motorbike
mode appears everywhere (UI tabs, tool default) with no code change.
"""

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from typing import Any

BASE = "https://graphhopper.com/api/1"
TIMEOUT_S = 10.0
#: Every request costs credits (500/day on the free plan); drags and mode
#: toggles re-ask the same question, so answer those from memory.
CACHE_SIZE = 256
FREE_PLAN = "car,bike,foot"

#: Contract profile names (Valhalla-style, spec §5) in preference order —
#: the first one the plan allows is the default.
PROFILE_ORDER = ("motor_scooter", "auto", "bicycle", "pedestrian")
GH_PROFILE = {"motor_scooter": "scooter", "auto": "car", "bicycle": "bike", "pedestrian": "foot"}

_CACHE: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


class RoutingUnavailable(Exception):
    """No key, out of credits, unreachable or failing — nothing to retry here."""


class NoRoute(Exception):
    """GraphHopper ran and found no path, or a point is not near any road."""


class UnsupportedProfile(Exception):
    """The key's plan does not include this travel mode."""


def _base() -> str:
    # Test hook, like FRIDAY_ALLOW_PRIVATE_FETCH: point at a local fake.
    return os.getenv("FRIDAY_GRAPHHOPPER_URL", BASE).rstrip("/")


def available_profiles() -> list[str]:
    allowed = {p.strip() for p in os.getenv("GRAPHHOPPER_PROFILES", FREE_PLAN).split(",") if p.strip()}
    return [p for p in PROFILE_ORDER if GH_PROFILE[p] in allowed]


def default_profile() -> str:
    profiles = available_profiles()
    return profiles[0] if profiles else "auto"


def clear_cache() -> None:
    _CACHE.clear()


def _get(url: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        # Input is validated before it gets here, so a 400 is GraphHopper
        # saying "no connection" or "point not near a road".
        if err.code == 400:
            raise NoRoute(_message(err)) from err
        # 401 bad key, 429 out of credits, 5xx: the caller cannot fix any of it.
        raise RoutingUnavailable(f"graphhopper HTTP {err.code}: {_message(err)}") from err
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        raise RoutingUnavailable(str(err)) from err


def _message(err: urllib.error.HTTPError) -> str:
    try:
        return str(json.loads(err.read()).get("message", ""))
    except (ValueError, OSError):
        return ""


def _normalize(path: dict[str, Any]) -> dict[str, Any]:
    return {
        "distance_m": round(path["distance"]),
        "duration_s": round(path["time"] / 1000),
        "coordinates": [[round(c[0], 6), round(c[1], 6)] for c in path["points"]["coordinates"]],
        "maneuvers": [
            {
                "instruction": i.get("text", ""),
                "sign": i.get("sign", 0),
                "distance_m": round(i.get("distance", 0)),
                "duration_s": round(i.get("time", 0) / 1000),
                "begin_shape_index": (i.get("interval") or [0])[0],
            }
            for i in path.get("instructions", [])
        ],
    }


async def route(waypoints: list[dict], profile: str | None = None, locale: str = "vi") -> dict[str, Any]:
    key = os.getenv("GRAPHHOPPER_API_KEY")
    if not key:
        raise RoutingUnavailable("GRAPHHOPPER_API_KEY is not set")
    profile = profile or default_profile()
    if profile not in available_profiles():
        raise UnsupportedProfile(profile)
    cache_key = json.dumps([[(round(w["lat"], 5), round(w["lon"], 5)) for w in waypoints], profile, locale])
    if cache_key in _CACHE:
        _CACHE.move_to_end(cache_key)
        return _CACHE[cache_key]
    params: list[tuple[str, str]] = [("point", f"{w['lat']},{w['lon']}") for w in waypoints]
    params += [
        ("profile", GH_PROFILE[profile]),
        ("locale", locale),
        ("instructions", "true"),
        ("points_encoded", "false"),
        ("key", key),
    ]
    # Alternatives only exist between two points (and cost extra credits).
    if len(waypoints) == 2:
        params += [("algorithm", "alternative_route"), ("alternative_route.max_paths", "3")]
    raw = await asyncio.to_thread(_get, f"{_base()}/route?{urllib.parse.urlencode(params)}")
    result = {"routes": [_normalize(p) for p in raw.get("paths", [])]}
    if not result["routes"]:
        raise NoRoute("no paths")
    _CACHE[cache_key] = result
    if len(_CACHE) > CACHE_SIZE:
        _CACHE.popitem(last=False)
    return result
```

Delete the old provider: `git rm backend/friday/geo/valhalla.py backend/tests/unit/test_valhalla.py docker/valhalla/compose.yml`, and remove the `"dev:valhalla"` line from `package.json` scripts.

Change the docstring of `backend/friday/geo/__init__.py` to `"""Maps: MapTiler geocoding and GraphHopper Cloud routing (spec 2026-09-21)."""`.

- [ ] **Step 5: Schema + endpoints**

In `backend/friday/api/schemas.py` replace `RouteRequest` with:

```python
class RouteRequest(BaseModel):
    """POST /geo/route — validated here so GraphHopper only sees sane input
    (and no credit is spent on a request that could never succeed)."""

    waypoints: list[LatLon] = Field(min_length=2, max_length=5)
    #: None = the plan's default travel mode (see geo/graphhopper.py).
    profile: Literal["auto", "motor_scooter", "bicycle", "pedestrian"] | None = None
```

In `backend/friday/api/routes.py` change line 20 to `from friday.geo import graphhopper` and replace the `geo_route` endpoint (lines 658-668) with:

```python
@router.get("/geo/profiles", dependencies=[Depends(require_known_origin)])
async def geo_profiles() -> dict[str, Any]:
    """Travel modes the routing plan allows, default first — the map's tabs."""
    return {"profiles": graphhopper.available_profiles()}


@router.post("/geo/route", dependencies=[Depends(require_known_origin)])
async def geo_route(body: RouteRequest) -> Any:
    """Spec §6.3 — one route question for the map UI. No model call behind
    it; the origin gate plus the client's cache guard the credit budget."""
    try:
        # Looked up on the module so tests can swap graphhopper.route.
        return await graphhopper.route([w.model_dump() for w in body.waypoints], body.profile)
    except graphhopper.RoutingUnavailable:
        return JSONResponse(status_code=503, content={"error": "routing_unavailable"})
    except graphhopper.NoRoute:
        return JSONResponse(status_code=422, content={"error": "no_route"})
    except graphhopper.UnsupportedProfile:
        return JSONResponse(status_code=422, content={"error": "unsupported_profile"})
```

- [ ] **Step 6: Env**

In `backend/.env.example` replace the three Valhalla lines (the `# Directions …` comment block and `# VALHALLA_URL=…`) with:

```
# Directions (spec 2026-09-21 §6) — GraphHopper Cloud, https://graphhopper.com
# Optional: unset = the map works but says "Chỉ đường chưa được cấu hình".
# Free plan: 500 credits/day, car/bike/foot only, non-commercial use.
# GRAPHHOPPER_API_KEY=
# Profiles the key's plan allows. Add ",scooter" on a paid plan to get the
# motorbike mode (it then becomes the default).
# GRAPHHOPPER_PROFILES=car,bike,foot
```

- [ ] **Step 7: Run the tests**

Run: `python backend/runtests.py test_graphhopper test_geo_route`
Expected: PASS. (`test_geo_tools` still imports `valhalla` and fails until Task 3 — expected.)

- [ ] **Step 8: Commit**

```bash
git add -A backend/friday/geo backend/friday/api backend/.env.example backend/tests docker package.json
git commit -m "feat(geo): GraphHopper Cloud routing replaces self-hosted Valhalla"
```

---

### Task 3: Agent tools on GraphHopper

**Files:**
- Modify: `backend/friday/geo/tools.py`, `backend/friday/tools/registry.py:121-140`
- Test: `backend/tests/unit/test_geo_tools.py`

**Interfaces:**
- Consumes: `friday.geo.graphhopper` (Task 2).
- Produces: `get_directions` default profile = `graphhopper.default_profile()`; a mode the plan lacks returns an error dict before any geocoding; `DEFAULT_PROFILE` is removed from `tools.py`.

- [ ] **Step 1: Update the tests**

In `backend/tests/unit/test_geo_tools.py`:

- docstring line 1: `"""find_place / get_directions with a fake geocoder and a fake router.`
- line 11: `from friday.geo import graphhopper, maptiler, tools`
- replace the `ROUTE` fixture with:

```python
ROUTE = {"routes": [{"distance_m": 2412, "duration_s": 545, "coordinates": [], "maneuvers": [
    {"instruction": f"Bước {i}", "sign": 0, "distance_m": 10, "duration_s": 5, "begin_shape_index": i} for i in range(12)
]}]}
```

- line 38: `    async def route_fn(waypoints, profile=None, locale="vi"):`
- lines 44, 48, 52: `valhalla.route` → `graphhopper.route`
- rename `test_directions_default_to_motorbike_and_cap_steps` to `test_directions_default_to_the_plans_mode_and_cap_steps` and change its assertions on lines 92, 93 and 96 from `"motor_scooter"` to `"auto"`, with the comment `# free plan (GRAPHHOPPER_PROFILES unset): car is the default` above line 92;
- replace the two error cases on lines 118-121 with:

```python
        fake({"a": [HG], "b": [LB]}, route_exc=graphhopper.RoutingUnavailable("no key"))
        assert "not configured" in run(tools.run_get_directions({"from": "a", "to": "b"}))["error"]
        fake({"a": [HG], "b": [LB]}, route_exc=graphhopper.NoRoute("Connection between locations not found"))
        assert "no route" in run(tools.run_get_directions({"from": "a", "to": "b"}))["error"]
        # scooter is not on the free plan: refused up front, with the reason
        seen = fake({"a": [HG], "b": [LB]}, route=ROUTE)
        assert "scooter" in run(tools.run_get_directions({"from": "a", "to": "b", "profile": "motor_scooter"}))["error"]
        assert seen["search"] == [] and seen["route"] == []  # no credit, no geocoding spent
```

- [ ] **Step 2: Run to watch it fail**

Run: `python backend/runtests.py test_geo_tools`
Expected: FAIL — `tools` still imports `valhalla`.

- [ ] **Step 3: Switch `tools.py`**

- `from . import maptiler, valhalla` → `from . import graphhopper, maptiler`; delete `DEFAULT_PROFILE = "motor_scooter"`.
- Replace the first three lines of `run_get_directions` with:

```python
    profile = payload.get("profile") or graphhopper.default_profile()
    if profile not in graphhopper.PROFILE_ORDER:
        return {"error": f"unknown profile '{profile}'"}
    if profile not in graphhopper.available_profiles():
        # Checked before any geocoding so no credits are spent on a refusal.
        return {"error": "motorbike directions need a GraphHopper plan with the scooter profile; use auto, bicycle or pedestrian"}
```

- Replace the routing call and its `except` clauses with:

```python
        # Looked up on the module so tests can swap graphhopper.route.
        result = await graphhopper.route([{"lat": s["lat"], "lon": s["lon"]} for s in stops], profile)
    except maptiler.GeocodeUnavailable as err:
        return {"error": f"place search unavailable: {err}"}
    except graphhopper.RoutingUnavailable:
        return {"error": "routing is not configured on this server (or today's credits are used up)"}
    except graphhopper.NoRoute:
        return {"error": "no route found between these places"}
    except graphhopper.UnsupportedProfile:
        return {"error": "this travel mode is not available on the routing plan"}
```

- In the returned dict: `"steps": [m["instruction"] for m in best["maneuvers"]][:MAX_STEPS],`

- [ ] **Step 4: Registry description**

In the `get_directions` entry of `backend/friday/tools/registry.py`, replace the description and the profile schema with:

```python
            description=(
                "Directions between places, shown on the street map with "
                "distance and time. from/to are place names or 'my_location'. "
                "profile: auto (car), bicycle, pedestrian, or motor_scooter "
                "(xe máy, only if the routing plan has it). Omit profile for "
                "the plan's default."
            ),
```

```python
                    "profile": {"type": "string", "enum": ["auto", "bicycle", "pedestrian", "motor_scooter"]},
```

- [ ] **Step 5: Run the backend suite**

Run: `python backend/runtests.py`
Expected: PASS (whole backend suite, including `test_map_preview_pin` and `test_contracts`).

- [ ] **Step 6: Commit**

```bash
git add backend/friday/geo/tools.py backend/friday/tools/registry.py backend/tests/unit/test_geo_tools.py
git commit -m "feat(geo): get_directions follows the routing plan's travel modes"
```

---

### Task 4: Frontend — flat route shape and plan-driven mode tabs

**Files:**
- Modify: `src/components/friday/map/mapApi.ts`, `src/components/friday/map/DirectionsPanel.tsx`, `src/components/friday/map/MapLayer.tsx`
- Test: `tests/unit/mapApi.spec.ts`, `tests/ui/map.spec.ts`, `tests/ui/stubOrchestrator.ts`

**Interfaces:**
- Consumes: `/geo/route` shape and `GET /geo/profiles` (Task 2).
- Produces (`mapApi.ts`): `interface Maneuver { instruction; sign; distance_m; duration_s; begin_shape_index }`, `interface Route { distance_m; duration_s; coordinates: [number, number][]; maneuvers: Maneuver[] }`, `RouteResult` reason adds `"unsupported"`, `maneuverCoordinate(route, i)`, `stepCoordinates(route, i)`, `FREE_PLAN_PROFILES`, `fetchProfiles(signal?)`. Removed: `RouteLeg`, `decodePolyline6`, `routeCoordinates`.
- Produces (`DirectionsPanel`): new prop `profiles: MapProfile[]`.
- Produces (`MapLayer`): `profiles` state fetched once per open; new directions start at `profiles[0]`.

- [ ] **Step 1: Update the unit test**

In `tests/unit/mapApi.spec.ts` remove `decodePolyline6` and `routeCoordinates` from the import, delete the tests `"decodes Valhalla polyline6 into [lon, lat]"` and `"route geometry spans legs and resolves maneuvers per leg"` and the `HANOI_SHAPE` constant, and add:

```ts
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
```

- [ ] **Step 2: Update the UI tests and stub**

In `tests/ui/stubOrchestrator.ts`: in `MAP_ROUTE_SPEC` change `profile: "motor_scooter"` to `profile: "auto"`, the doc comment to `/** get_directions as the backend streams it on GraphHopper's free plan (default mode = car): the map preview is also the final spec. */`, and the answer text to `"Khoảng 2,4 km, chừng 9 phút đi ô tô."`.

In `tests/ui/map.spec.ts` replace the `ROUTE` fixture with:

```ts
const ROUTE = {
  routes: [
    {
      distance_m: 2412,
      duration_s: 545,
      coordinates: [
        [105.8525, 21.0288],
        [105.843, 21.033],
        [105.8346, 21.0368],
      ],
      maneuvers: [
        { instruction: "Đi về hướng tây trên Đinh Tiên Hoàng", sign: 0, distance_m: 1100, duration_s: 250, begin_shape_index: 0 },
        { instruction: "Rẽ phải vào Hùng Vương", sign: 2, distance_m: 1312, duration_s: 295, begin_shape_index: 1 },
        { instruction: "Đến nơi", sign: 4, distance_m: 0, duration_s: 0, begin_shape_index: 2 },
      ],
    },
    { distance_m: 2900, duration_s: 610, coordinates: [[105.8525, 21.0288], [105.8346, 21.0368]], maneuvers: [] },
  ],
};
```

and in the test `"an agent route opens directions with the summary, steps and route layers"`:
- after `await stubMapTiler(page);` add `await page.route("**/geo/profiles", (r) => r.fulfill({ json: { profiles: ["auto", "bicycle", "pedestrian"] } }));`
- replace the `🛵 Xe máy` assertion with:

```ts
    // free plan: car is selected and there is no motorbike tab
    await expect(panel.getByRole("tab", { name: "🚗 Ô tô" })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("tab", { name: "🛵 Xe máy" })).toHaveCount(0);
```

- change the step assertion to `await expect(panel.getByRole("listitem")).toContainText(["Rẽ phải vào Hùng Vương"]);`

- [ ] **Step 3: Run to watch them fail**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts`
Expected: FAIL — `Route` has no `coordinates`; `maneuverCoordinate` takes three arguments.

- [ ] **Step 4: `mapApi.ts`**

- Header comment: replace "and the orchestrator's /geo/route. Pure helpers (decode, format, parse) are unit-tested." with "and the orchestrator's /geo/route and /geo/profiles (the GraphHopper key stays on the server). Pure helpers (parse, step geometry, format) are unit-tested."
- After `PROFILE_LABELS` add:

```ts
/** GraphHopper's free plan — what the tabs show if /geo/profiles cannot be read. */
export const FREE_PLAN_PROFILES: MapProfile[] = ["auto", "bicycle", "pedestrian"];

/** Travel modes the routing plan allows, default first (spec §6.3). */
export async function fetchProfiles(signal?: AbortSignal): Promise<MapProfile[]> {
  try {
    const res = await fetch(`${getApiBase()}/geo/profiles`, { signal });
    if (!res.ok) return FREE_PLAN_PROFILES;
    const body = (await res.json()) as { profiles?: MapProfile[] };
    return body.profiles?.length ? body.profiles : FREE_PLAN_PROFILES;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return FREE_PLAN_PROFILES;
  }
}
```

- Replace `Maneuver`, `RouteLeg`, `Route` and `RouteResult` with:

```ts
export interface Maneuver {
  instruction: string;
  /** GraphHopper turn sign (-98..8); kept for a future turn icon. */
  sign: number;
  distance_m: number;
  duration_s: number;
  /** Index into `Route.coordinates` where this maneuver starts. */
  begin_shape_index: number;
}

export interface Route {
  distance_m: number;
  duration_s: number;
  /** [lon, lat] pairs — GeoJSON order, ready for a LineString. */
  coordinates: [number, number][];
  maneuvers: Maneuver[];
}

export type RouteResult =
  | { ok: true; routes: Route[] }
  | { ok: false; reason: "unavailable" | "no_route" | "unsupported" | "error" };
```

- In `fetchRoute`, replace the `if (!res.ok) { … }` block with:

```ts
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "no_route") return { ok: false, reason: "no_route" };
    if (body?.error === "unsupported_profile") return { ok: false, reason: "unsupported" };
    return { ok: false, reason: "error" };
  }
```

- Delete `decodePolyline6` and `routeCoordinates`, and replace `maneuverCoordinate` / `stepCoordinates` with:

```ts
/** Where maneuver `i` happens. */
export function maneuverCoordinate(route: Route, i: number): [number, number] | null {
  const m = route.maneuvers[i];
  return m ? (route.coordinates[m.begin_shape_index] ?? null) : null;
}

/** The stretch step `i` covers: its maneuver up to the next one (or the end). */
export function stepCoordinates(route: Route, i: number): [number, number][] {
  const m = route.maneuvers[i];
  if (!m) return [];
  const end = route.maneuvers[i + 1]?.begin_shape_index ?? route.coordinates.length - 1;
  return route.coordinates.slice(m.begin_shape_index, end + 1);
}
```

- [ ] **Step 5: `DirectionsPanel.tsx`**

- Remove `routeCoordinates` from the `./mapApi` import and delete the `PROFILES` constant.
- `Status` and `STATUS_TEXT` become:

```ts
type Status = "idle" | "loading" | "ok" | "unavailable" | "no_route" | "unsupported" | "error";
const STATUS_TEXT: Partial<Record<Status, string>> = {
  loading: "Đang tìm đường…",
  unavailable: "Chỉ đường chưa được cấu hình",
  no_route: "Không tìm thấy đường đi",
  unsupported: "Gói chỉ đường hiện tại không hỗ trợ phương tiện này",
  error: "Không tính được đường đi",
};
```

- In `routeData`: `geometry: { type: "LineString", coordinates: r.coordinates },`
- In `fitRoute`: `const coords = route.coordinates;`
- Add the prop (in both the destructuring and the props type, after `value`):

```tsx
  profiles,
```
```tsx
  /** Modes the routing plan allows (GET /geo/profiles), default first. */
  profiles: MapProfile[];
```

- Replace `const steps = …;` with:

```tsx
  // An agent may ask for a mode the plan lacks; show its tab so the state is honest.
  const tabs = profiles.includes(value.profile) ? profiles : [...profiles, value.profile];
```

- In the tablist: `{tabs.map((p) => (` instead of `{PROFILES.map((p) => (`.
- Replace the `<ol>` body with:

```tsx
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
```

- [ ] **Step 6: `MapLayer.tsx`**

- Import: `import { FREE_PLAN_PROFILES, fetchProfiles, styleUrl, type Endpoint, type MapStyleId, type Place } from "./mapApi";`
- Next to the `directions` state:

```tsx
  // Modes the routing plan allows, default first; free plan until the backend says otherwise.
  const [profiles, setProfiles] = useState<MapProfile[]>(FREE_PLAN_PROFILES);
```

- Before `const leave = useCallback(…)`:

```tsx
  useEffect(() => {
    const ctrl = new AbortController();
    fetchProfiles(ctrl.signal).then(setProfiles).catch(() => {});
    return () => ctrl.abort();
  }, []);
```

- Lines 270, 274 and 377: replace the three `"motor_scooter"` defaults with `profiles[0]`.
- Line 388: pass `profiles={profiles}` to `<DirectionsPanel …>`.

- [ ] **Step 7: Run the tests**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts` → PASS.
Run: `npm run lint && npm run typecheck` → clean (`grep -rn "decodePolyline6\|routeCoordinates\|legs" src/components/friday/map` returns nothing).
Run: `npx playwright test --project=ui tests/ui/map.spec.ts` → all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/friday/map tests/unit/mapApi.spec.ts tests/ui/map.spec.ts tests/ui/stubOrchestrator.ts
git commit -m "feat(map): plain-coordinate routes and mode tabs from the routing plan"
```

---

### Task 5: Docs, deploy config, full verification

**Files:**
- Modify: `README.md:190-199`, `backend/README.md:327,420-436`, `docs/ARCHITECTURE.md:428-432`, `.env.example:32`, `backend/render.yaml`

**Interfaces:**
- Produces: no Valhalla mention outside `docs/superpowers/`; both backend keys declared for Render.

- [ ] **Step 1: Docs**

- `README.md` "Street map & directions": replace the sentence starting "and routing needs `VALHALLA_URL` …" through "later starts are instant)." with: "and routing reads `GRAPHHOPPER_API_KEY` (GraphHopper Cloud — nothing to host; the free plan routes car, bike and foot with 500 credits/day for non-commercial use, and adding `scooter` to `GRAPHHOPPER_PROFILES` on a paid plan turns the motorbike mode on)."
- `.env.example:32`: "Directions also need GRAPHHOPPER_API_KEY on the backend (backend/.env.example) — that key never reaches the browser."
- `backend/README.md` tool table line 327: `| \`get_directions\` | low (\`geo.read\`) | routing via GraphHopper Cloud (\`GRAPHHOPPER_API_KEY\`), pins a route preview |`
- `backend/README.md` "Street map: geocoding and directions": replace the `VALHALLA_URL` row with two rows —

```
| `GRAPHHOPPER_API_KEY` | unset | GraphHopper Cloud key for `get_directions`, `POST /geo/route` and `GET /geo/profiles`. Unset means routing is off, not broken — the map still works and says routing is unconfigured. Never sent to the browser. |
| `GRAPHHOPPER_PROFILES` | `car,bike,foot` | Profiles the key's plan allows (free plan = car, bike, foot). Add `scooter` on a paid plan: the motorbike mode appears in the map and becomes the default. |
```

  and replace the two paragraphs below the table (from "`npm run dev:valhalla` starts…" through "…Run Valhalla locally for directions.") with:

```
The frontend never talks to GraphHopper directly — the map posts waypoints to
`POST /geo/route` on this service, which validates them, refuses a mode the
plan lacks before spending a credit, and answers repeats from a 256-entry cache.

**Free plan budget:** 500 credits/day and alternatives cost extra. A turn of
directions is usually 1–3 requests (drags and mode switches re-ask; the cache
absorbs exact repeats). When the credits run out GraphHopper answers 429 and the
map says routing is unconfigured until the daily reset.
```

  (Do not touch the search-provider table near line 385 — it is the web-search fallback order, not a general quota table.)
- `docs/ARCHITECTURE.md`: in the `map` spec bullet replace "which validates the waypoints and proxies to a local Valhalla. Directions need `VALHALLA_URL`;" with "which validates the waypoints and proxies to GraphHopper Cloud (`GET /geo/profiles` tells the UI which modes the plan allows). Directions need `GRAPHHOPPER_API_KEY`;".
- `backend/render.yaml` `envVars`: add

```yaml
      # Street map (spec 2026-09-21 §6). Set in the dashboard.
      - key: GRAPHHOPPER_API_KEY
        sync: false
      - key: MAPTILER_SERVER_KEY
        sync: false
```

- [ ] **Step 2: Check nothing still points at Valhalla**

Run: `git grep -n -i "valhalla" -- . ":!docs/superpowers"`
Expected: no output.

- [ ] **Step 3: Manual check (real keys)**

With `GRAPHHOPPER_API_KEY` and `MAPTILER_SERVER_KEY` in `backend/.env` and `NEXT_PUBLIC_MAPTILER_KEY` in `.env.local`, run the backend and the dev server (browser preview via `.claude/launch.json`), ask "chỉ đường từ Hồ Gươm tới Lăng Bác" and check: route + grey alternatives draw, steps are Vietnamese, only Ô tô / Xe đạp / Đi bộ tabs, dragging B reroutes, dragging B back to the same spot sends no new request (Network tab). Check the key's credit use in the GraphHopper dashboard. Screenshot for the PR.

- [ ] **Step 4: Full verification**

Run: `npm run verify`
Expected: lint, typecheck, unit, backend, contracts and UI suites all PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md backend/README.md docs/ARCHITECTURE.md .env.example backend/render.yaml
git commit -m "docs(map): GraphHopper Cloud routing setup and free-plan budget"
```
