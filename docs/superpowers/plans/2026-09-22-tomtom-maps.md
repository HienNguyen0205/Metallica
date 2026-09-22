# TomTom Maps Migration Plan (delta)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MapTiler (tiles + geocoding) and GraphHopper (routing) on `feat/maplibre-map` with TomTom for all three, gaining motorbike routing and real-time traffic on the free plan.

**Architecture:** One backend module, `backend/friday/geo/tomtom.py`, owns every TomTom call except tiles (Places Suggest/Details, Reverse Geocoding, fuzzy Search, Calculate Route) behind a server-only key, with per-function LRU caches. The browser only loads TomTom styles/tiles with a Map-Display-only key; search and reverse geocoding move behind new `/geo/suggest`, `/geo/place`, `/geo/reverse` proxies. TomTom has no Vietnamese guidance, so `geo/maneuvers.py` builds Vietnamese instructions from the 33 maneuver codes. The route wire shape stays the flat `{coordinates, maneuvers}` from the GraphHopper round, plus `traffic_delay_s`.

**Tech Stack:** TomTom Map Styles v2 / Map Display, Places Search API v3, Search API v2, Routing API v1; FastAPI + `urllib` (existing pattern); maplibre-gl 6 (existing); Playwright + plain-python tests (existing).

**Spec:** `docs/superpowers/specs/2026-09-21-maplibre-map-design.md` (revised 2026-09-22 for TomTom — §2, §4, §6, §7, §8). Base: `feat/maplibre-map` at `256f01e` (GraphHopper delta already implemented).

## Global Constraints

- Keys: `NEXT_PUBLIC_TOMTOM_MAP_KEY` (browser, Map Display only) and `TOMTOM_API_KEY` (backend: Search, Places, Reverse Geocoding, Routing; never in the browser). Unset backend key → map shows, search/directions report unconfigured.
- Free allowances per API per month: tiles 200K, traffic tiles 200K, Routing 20K, Reverse Geocoding 20K, Places Suggest 10K, Places Details 5K, **fuzzy Search 2.5K**. Every backend call is cached.
- Profiles: contract `motor_scooter | auto | bicycle | pedestrian` → TomTom `motorcycle | car | bicycle | pedestrian`. All four available; **default `motor_scooter`**. `GET /geo/profiles` stays and returns all four in that order.
- Language: `vi-VN` for search/reverse; routing uses `instructionsType=coded` and Vietnamese text built in `geo/maneuvers.py`.
- Route wire shape: `{"routes": [{"distance_m", "duration_s", "traffic_delay_s", "coordinates": [[lon, lat]], "maneuvers": [{"instruction", "maneuver", "distance_m", "duration_s", "begin_shape_index"}]}]}`.
- Errors from `/geo/*`: 429 `{"error": "quota_exceeded"}`; 503 `{"error": "unavailable"}` (routing keeps `routing_unavailable`); 422 `no_route` / `unsupported_profile` / validation.
- Privacy: proximity to TomTom search/suggest rounded to 2 decimals; full precision only for route stops.
- Search UI: ≥3 characters, 400 ms debounce.
- No new dependencies; no test touches the real network. Commits: conventional prefix, **no `Co-Authored-By` trailer**. Done = `npm run verify` green.

## What is removed

`backend/friday/geo/graphhopper.py`, `backend/friday/geo/maptiler.py`, `backend/tests/unit/test_graphhopper.py`, the `GRAPHHOPPER_*` / `MAPTILER_SERVER_KEY` / `NEXT_PUBLIC_MAPTILER_KEY` variables, the frontend MapTiler calls (`parseGeocoding`, direct geocoding fetches), `preferVietnameseLabels`, the OpenMapTiles 3D-building fallback, and the Terrain layer option.

## File Structure

- Create: `backend/friday/geo/tomtom.py`, `backend/friday/geo/maneuvers.py`, `backend/tests/unit/test_tomtom.py`, `backend/tests/unit/test_maneuvers.py`
- Delete: `backend/friday/geo/graphhopper.py`, `backend/friday/geo/maptiler.py`, `backend/tests/unit/test_graphhopper.py`
- Modify (backend): `backend/friday/geo/__init__.py`, `backend/friday/geo/tools.py`, `backend/friday/api/routes.py`, `backend/friday/api/schemas.py`, `backend/friday/tools/registry.py`, `backend/.env.example`, `backend/render.yaml`, `backend/README.md`, `backend/tests/integration/test_geo_route.py`, `backend/tests/unit/test_geo_tools.py`
- Modify (frontend): `src/components/friday/map/mapApi.ts`, `MapLayer.tsx`, `MapSearch.tsx`, `DirectionsPanel.tsx`, `src/proxy.ts`, `.env.example`, `playwright.config.ts`, `tests/unit/mapApi.spec.ts`, `tests/ui/map.spec.ts`, `tests/ui/stubOrchestrator.ts`
- Modify (docs): `README.md`, `docs/ARCHITECTURE.md`, `docs/superpowers/plans/2026-09-22-graphhopper-routing.md` (superseded note)

---

### Task 0: Probe the live TomTom APIs (needs real keys)

Several request details are documented loosely. Pin them against the real API before writing parsers, so fixtures match reality. **If the user has not provided keys yet, skip this task and run it as Task 7 Step 1 instead**; the plan's defaults below follow the docs.

**Files:** none committed except, if shapes differ, the fixture values and constants named below.

- [ ] **Step 1: Ask the user for the two keys** (`TOMTOM_API_KEY`, `NEXT_PUBLIC_TOMTOM_MAP_KEY`) and put them in `backend/.env` and `.env.local` only (both are gitignored — verify with `git check-ignore backend/.env .env.local`).

- [ ] **Step 2: Probe each call and record what differs from this plan**

```bash
K=$(grep ^TOMTOM_API_KEY backend/.env | cut -d= -f2)
M=$(grep ^NEXT_PUBLIC_TOMTOM_MAP_KEY .env.local | cut -d= -f2)
# 1. style version + style names (expect 200 and a MapLibre style JSON)
curl -s -o /dev/null -w "%{http_code}\n" "https://api.tomtom.com/style/1/style/22.2.1-*?key=$M&map=2/basic_street-dark&poi=2/poi_dark"
curl -s -o /dev/null -w "%{http_code}\n" "https://api.tomtom.com/style/1/style/22.2.1-*?key=$M&map=2/hybrid_street-satellite&poi=2/poi_dark"
curl -s -o /dev/null -w "%{http_code}\n" "https://api.tomtom.com/style/1/style/22.2.1-*?key=$M&map=2/basic_street-dark&traffic_flow=2/flow_relative-dark"
# 2. suggest: shape of results[].more.pathParameters, the Attributes header, language
curl -s -X POST https://api.tomtom.com/maps/orbis/places/suggest -H "TomTom-Api-Key: $K" -H "TomTom-Api-Version: 3" -H "Attributes: results" -H "Accept-Language: vi-VN" -H "Content-Type: application/json" -d '{"query":"hồ gươm","maxResults":3,"origin":{"type":"Point","coordinates":[105.85,21.03]}}'
# 3. details with the ref from 2 (expect position.coordinates [lon, lat])
curl -s "https://api.tomtom.com/maps/orbis/places/details/<ref>" -H "TomTom-Api-Key: $K" -H "TomTom-Api-Version: 3" -H "Attributes: position"
# 4. reverse, fuzzy search, route (motorcycle, coded guidance)
curl -s "https://api.tomtom.com/search/2/reverseGeocode/21.0288,105.8525.json?key=$K&language=vi-VN"
curl -s "https://api.tomtom.com/search/2/search/l%C4%83ng%20b%C3%A1c.json?key=$K&language=vi-VN&limit=1"
curl -s "https://api.tomtom.com/routing/1/calculateRoute/21.0288,105.8525:21.0368,105.8346/json?key=$K&travelMode=motorcycle&instructionsType=coded&traffic=true&maxAlternatives=2"
```

Record, and apply in the tasks that follow:
- the style version that answers 200 (`TOMTOM_STYLE_VERSION` in Task 4) and whether satellite answers 200 on the free key (if not, drop `satellite` in Task 4);
- the `Attributes` value suggest accepts and the exact `more.pathParameters` shape (`_suggestion` in Task 1);
- whether suggest honors `Accept-Language` (if titles come back non-Vietnamese, try `?language=vi-VN` on the URL instead);
- whether `pointIndex` in a two-leg route (add a via point) counts across legs — `_normalize` assumes the legs' points concatenated in order.

---

### Task 1: TomTom client and Vietnamese maneuvers

**Files:**
- Create: `backend/friday/geo/tomtom.py`, `backend/friday/geo/maneuvers.py`, `backend/tests/unit/test_tomtom.py`, `backend/tests/unit/test_maneuvers.py`

**Interfaces:**
- Produces (`friday.geo.maneuvers`): `VI: dict[str, str]` (33 codes), `vi_instruction(ins: dict) -> str`.
- Produces (`friday.geo.tomtom`): `TomTomUnavailable`, `QuotaExceeded`, `NoRoute`, `UnsupportedProfile`; `PROFILE_ORDER`, `TRAVEL_MODE`, `available_profiles()`, `default_profile()`, `coarse(lat, lon)`, `clear_cache()`; `async suggest(query, near=None, limit=6) -> list[{ref,title,subtitle,type}]`, `async place(ref) -> {lat, lon}`, `async reverse(lat, lon) -> str | None`, `async search(query, near=None, limit=5) -> list[{label,address,category,lat,lon}]`, `async route(waypoints, profile=None) -> {"routes": [...]}`.

- [ ] **Step 1: Write the failing maneuver test**

Create `backend/tests/unit/test_maneuvers.py`:

```python
"""TomTom maneuver codes → Vietnamese instructions.

    PYTHONPATH=. python tests/unit/test_maneuvers.py
"""

from friday.geo.maneuvers import VI, vi_instruction

# The full list from TomTom's guidance-instructions docs.
CODES = (
    "ARRIVE ARRIVE_LEFT ARRIVE_RIGHT DEPART STRAIGHT KEEP_RIGHT BEAR_RIGHT TURN_RIGHT "
    "SHARP_RIGHT KEEP_LEFT BEAR_LEFT TURN_LEFT SHARP_LEFT MAKE_UTURN ENTER_MOTORWAY "
    "ENTER_FREEWAY ENTER_HIGHWAY TAKE_EXIT MOTORWAY_EXIT_LEFT MOTORWAY_EXIT_RIGHT TAKE_FERRY "
    "ROUNDABOUT_CROSS ROUNDABOUT_RIGHT ROUNDABOUT_LEFT ROUNDABOUT_BACK TRY_MAKE_UTURN FOLLOW "
    "SWITCH_PARALLEL_ROAD SWITCH_MAIN_ROAD ENTRANCE_RAMP WAYPOINT_LEFT WAYPOINT_RIGHT WAYPOINT_REACHED"
).split()


def test_every_code_has_vietnamese_text() -> None:
    assert len(CODES) == 33
    assert set(VI) == set(CODES), set(CODES) ^ set(VI)


def test_turns_name_the_street_they_turn_onto() -> None:
    assert vi_instruction({"maneuver": "TURN_RIGHT", "street": "Hùng Vương"}) == "Rẽ phải vào Hùng Vương"
    assert vi_instruction({"maneuver": "DEPART", "street": "Đinh Tiên Hoàng"}) == "Xuất phát trên Đinh Tiên Hoàng"
    assert vi_instruction({"maneuver": "TURN_LEFT", "roadNumbers": ["QL1A"]}) == "Rẽ trái vào QL1A"
    assert vi_instruction({"maneuver": "TURN_LEFT"}) == "Rẽ trái"


def test_roundabouts_say_which_exit() -> None:
    assert vi_instruction({"maneuver": "ROUNDABOUT_RIGHT", "roundaboutExitNumber": 2}) == "Vào vòng xuyến, đi lối ra thứ 2"
    assert vi_instruction({"maneuver": "ROUNDABOUT_CROSS", "roundaboutExitNumber": 2}) == "Đi thẳng qua vòng xuyến"


def test_arrivals_ignore_the_street_and_unknown_codes_fall_back() -> None:
    assert vi_instruction({"maneuver": "ARRIVE_RIGHT", "street": "Hùng Vương"}) == "Đến nơi, ở bên phải"
    assert vi_instruction({"maneuver": "SOMETHING_NEW"}) == "Tiếp tục"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

- [ ] **Step 2: Write the failing client test**

Create `backend/tests/unit/test_tomtom.py`:

```python
"""TomTom client against a local fake — request shapes, normalization,
errors, cache. No external network.

    PYTHONPATH=. python tests/unit/test_tomtom.py
"""

import asyncio
import json
import os
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from friday.geo import tomtom as tt

SUGGEST = {"results": [
    {"id": "hg", "title": "Hồ Gươm", "type": "poi", "subtitles": ["Hoàn Kiếm", "Hà Nội"],
     "more": {"operation": "details", "pathParameters": ["pois", "hg"]}},
    {"id": "x", "title": "hồ gươm (tìm thêm)", "type": "discoverAction",
     "more": {"operation": "discover", "pathParameters": []}},
    {"id": "bad", "title": "Bad", "type": "poi", "more": {"operation": "details", "pathParameters": ["../etc", "x"]}},
]}
DETAILS = {"position": {"type": "Point", "coordinates": [105.8525, 21.0288]}}
REVERSE = {"addresses": [{"address": {"freeformAddress": "Đinh Tiên Hoàng, Hoàn Kiếm, Hà Nội"}, "position": "21.0288,105.8525"}]}
SEARCH = {"results": [
    {"type": "POI", "poi": {"name": "Lăng Chủ tịch Hồ Chí Minh"}, "address": {"freeformAddress": "Ba Đình, Hà Nội"},
     "position": {"lat": 21.0368, "lon": 105.8346}},
]}


def trip(length, time, delay):
    return {
        "summary": {"lengthInMeters": length, "travelTimeInSeconds": time, "trafficDelayInSeconds": delay},
        "legs": [{"points": [{"latitude": 21.0288, "longitude": 105.8525}, {"latitude": 21.033, "longitude": 105.843},
                             {"latitude": 21.0368, "longitude": 105.8346}]}],
        "guidance": {"instructions": [
            {"maneuver": "DEPART", "street": "Đinh Tiên Hoàng", "routeOffsetInMeters": 0, "travelTimeInSeconds": 0, "pointIndex": 0},
            {"maneuver": "TURN_RIGHT", "street": "Hùng Vương", "routeOffsetInMeters": 1100, "travelTimeInSeconds": 250, "pointIndex": 1},
            {"maneuver": "ARRIVE", "routeOffsetInMeters": length, "travelTimeInSeconds": time, "pointIndex": 2},
        ]},
    }


ROUTE = {"routes": [trip(2412, 545, 360), trip(2900, 610, 0)]}
CALLS: list[dict] = []
STATUS: dict[str, int] = {}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _reply(self, kind, payload):
        status = STATUS.get(kind, 200)
        if status != 200:
            payload = {"detailedError": {"code": "X", "message": "points are not connected by the road network"}}
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _record(self, kind, body=None):
        url = urllib.parse.urlparse(self.path)
        CALLS.append({"kind": kind, "path": urllib.parse.unquote(url.path), "query": urllib.parse.parse_qs(url.query),
                      "headers": dict(self.headers), "body": body})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self._record("suggest", body)
        self._reply("suggest", SUGGEST)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        kind = ("place" if "/places/details/" in path else "reverse" if "reverseGeocode" in path
                else "search" if "/search/2/search/" in path else "route")
        self._record(kind)
        self._reply(kind, {"place": DETAILS, "reverse": REVERSE, "search": SEARCH, "route": ROUTE}[kind])


def with_server(fn):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    old = {k: os.environ.get(k) for k in ("TOMTOM_API_KEY", "FRIDAY_TOMTOM_URL")}
    os.environ["TOMTOM_API_KEY"] = "test-key"
    os.environ["FRIDAY_TOMTOM_URL"] = f"http://127.0.0.1:{server.server_address[1]}"
    CALLS.clear()
    STATUS.clear()
    tt.clear_cache()
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
NEAR = (21.028812, 105.852499)


def test_profiles_are_all_free_and_motorbike_first() -> None:
    assert tt.available_profiles() == ["motor_scooter", "auto", "bicycle", "pedestrian"]
    assert tt.default_profile() == "motor_scooter"


def test_suggest_sends_a_coarse_origin_and_keeps_only_resolvable_results() -> None:
    def run():
        out = asyncio.run(tt.suggest("hồ gươm", NEAR))
        assert out == [{"ref": "pois/hg", "title": "Hồ Gươm", "subtitle": "Hoàn Kiếm, Hà Nội", "type": "poi"}], out
        call = CALLS[0]
        assert call["headers"]["TomTom-Api-Key"] == "test-key" and call["headers"]["TomTom-Api-Version"] == "3"
        assert call["body"]["origin"] == {"type": "Point", "coordinates": [105.85, 21.03]}, call["body"]
        asyncio.run(tt.suggest("Hồ Gươm", NEAR))
        assert len(CALLS) == 1, "case-insensitive cache hit"
    with_server(run)


def test_place_resolves_a_ref_and_rejects_path_tricks() -> None:
    def run():
        assert asyncio.run(tt.place("pois/hg")) == {"lat": 21.0288, "lon": 105.8525}
        assert CALLS[0]["path"].endswith("/maps/orbis/places/details/pois/hg")
        try:
            asyncio.run(tt.place("../../search/2"))
        except ValueError:
            pass
        else:
            raise AssertionError("bad ref must be refused")
    with_server(run)


def test_reverse_and_search() -> None:
    def run():
        assert asyncio.run(tt.reverse(21.0288, 105.8525)) == "Đinh Tiên Hoàng, Hoàn Kiếm, Hà Nội"
        assert CALLS[0]["query"]["language"] == ["vi-VN"]
        hits = asyncio.run(tt.search("lăng bác", NEAR, limit=1))
        assert hits == [{"label": "Lăng Chủ tịch Hồ Chí Minh", "address": "Ba Đình, Hà Nội", "category": "poi",
                         "lat": 21.0368, "lon": 105.8346}], hits
        q = CALLS[1]["query"]
        assert (q["lat"], q["lon"], q["limit"]) == (["21.03"], ["105.85"], ["1"]), q
    with_server(run)


def test_route_request_and_normalization() -> None:
    def run():
        out = asyncio.run(tt.route([A, B]))
        call = CALLS[0]
        assert call["path"].endswith("/routing/1/calculateRoute/21.0288,105.8525:21.0368,105.8346/json"), call["path"]
        q = call["query"]
        assert q["travelMode"] == ["motorcycle"] and q["instructionsType"] == ["coded"]
        assert q["traffic"] == ["true"] and q["maxAlternatives"] == ["2"]
        assert len(out["routes"]) == 2
        r = out["routes"][0]
        assert (r["distance_m"], r["duration_s"], r["traffic_delay_s"]) == (2412, 545, 360)
        assert r["coordinates"] == [[105.8525, 21.0288], [105.843, 21.033], [105.8346, 21.0368]]
        assert r["maneuvers"][1] == {"instruction": "Rẽ phải vào Hùng Vương", "maneuver": "TURN_RIGHT",
                                     "distance_m": 1312, "duration_s": 295, "begin_shape_index": 1}, r["maneuvers"][1]
        assert r["maneuvers"][0]["distance_m"] == 1100 and r["maneuvers"][2]["distance_m"] == 0
    with_server(run)


def test_route_modes_via_points_and_cache() -> None:
    def run():
        asyncio.run(tt.route([A, {"lat": 21.03, "lon": 105.84}, B], "pedestrian"))
        q = CALLS[0]["query"]
        assert q["travelMode"] == ["pedestrian"] and "maxAlternatives" not in q
        asyncio.run(tt.route([{"lat": 21.028800001, "lon": 105.8525}, B], "auto"))
        asyncio.run(tt.route([A, B], "auto"))
        assert len(CALLS) == 2, "rounded repeat is a cache hit"
        try:
            asyncio.run(tt.route([A, B], "rocket"))
        except tt.UnsupportedProfile:
            pass
        else:
            raise AssertionError("unknown mode must be refused")
    with_server(run)


def test_error_mapping() -> None:
    def run():
        STATUS["route"] = 400
        try:
            asyncio.run(tt.route([A, B]))
        except tt.NoRoute:
            pass
        else:
            raise AssertionError("route 400 → NoRoute")
        for kind, status, exc in (("suggest", 429, tt.QuotaExceeded), ("search", 403, tt.TomTomUnavailable),
                                  ("reverse", 500, tt.TomTomUnavailable)):
            STATUS[kind] = status
            tt.clear_cache()
            call = {"suggest": lambda: tt.suggest("abc"), "search": lambda: tt.search("abc"),
                    "reverse": lambda: tt.reverse(1, 2)}[kind]
            try:
                asyncio.run(call())
            except exc:
                continue
            raise AssertionError(f"{kind} {status} must raise {exc.__name__}")
    with_server(run)


def test_no_key_or_unreachable_is_unavailable() -> None:
    old = {k: os.environ.get(k) for k in ("TOMTOM_API_KEY", "FRIDAY_TOMTOM_URL")}
    try:
        os.environ.pop("TOMTOM_API_KEY", None)
        for call in (lambda: tt.suggest("abc"), lambda: tt.route([A, B])):
            try:
                asyncio.run(call())
            except tt.TomTomUnavailable:
                continue
            raise AssertionError("no key must be TomTomUnavailable")
        os.environ["TOMTOM_API_KEY"] = "k"
        os.environ["FRIDAY_TOMTOM_URL"] = "http://127.0.0.1:9"  # discard port
        tt.clear_cache()
        try:
            asyncio.run(tt.reverse(1, 2))
        except tt.TomTomUnavailable:
            pass
        else:
            raise AssertionError("unreachable must be TomTomUnavailable")
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

- [ ] **Step 3: Run to watch them fail**

Run: `python backend/runtests.py test_maneuvers test_tomtom`
Expected: FAIL — `ModuleNotFoundError: No module named 'friday.geo.maneuvers'` / `'friday.geo.tomtom'`.

- [ ] **Step 4: Implement `backend/friday/geo/maneuvers.py`**

```python
"""TomTom maneuver codes → Vietnamese (spec §6.2).

TomTom's guidance has no vi-VN, so directions ask for coded instructions and
the text is built here. The map's step list and get_directions' spoken steps
share it, so the operator hears exactly what they read.
"""

from typing import Any

VI: dict[str, str] = {
    "DEPART": "Xuất phát",
    "ARRIVE": "Đến nơi",
    "ARRIVE_LEFT": "Đến nơi, ở bên trái",
    "ARRIVE_RIGHT": "Đến nơi, ở bên phải",
    "STRAIGHT": "Đi thẳng",
    "KEEP_RIGHT": "Giữ bên phải",
    "BEAR_RIGHT": "Chếch sang phải",
    "TURN_RIGHT": "Rẽ phải",
    "SHARP_RIGHT": "Rẽ gắt sang phải",
    "KEEP_LEFT": "Giữ bên trái",
    "BEAR_LEFT": "Chếch sang trái",
    "TURN_LEFT": "Rẽ trái",
    "SHARP_LEFT": "Rẽ gắt sang trái",
    "MAKE_UTURN": "Quay đầu",
    "TRY_MAKE_UTURN": "Quay đầu khi có thể",
    "ENTER_MOTORWAY": "Vào đường cao tốc",
    "ENTER_FREEWAY": "Vào đường cao tốc",
    "ENTER_HIGHWAY": "Vào quốc lộ",
    "TAKE_EXIT": "Đi theo lối ra",
    "MOTORWAY_EXIT_LEFT": "Ra khỏi cao tốc ở bên trái",
    "MOTORWAY_EXIT_RIGHT": "Ra khỏi cao tốc ở bên phải",
    "TAKE_FERRY": "Lên phà",
    "ROUNDABOUT_CROSS": "Đi thẳng qua vòng xuyến",
    "ROUNDABOUT_RIGHT": "Vào vòng xuyến, rẽ phải",
    "ROUNDABOUT_LEFT": "Vào vòng xuyến, rẽ trái",
    "ROUNDABOUT_BACK": "Vào vòng xuyến, quay lại",
    "FOLLOW": "Đi theo",
    "SWITCH_PARALLEL_ROAD": "Chuyển sang đường song song",
    "SWITCH_MAIN_ROAD": "Chuyển sang đường chính",
    "ENTRANCE_RAMP": "Vào đường dẫn",
    "WAYPOINT_LEFT": "Đến điểm dừng, ở bên trái",
    "WAYPOINT_RIGHT": "Đến điểm dừng, ở bên phải",
    "WAYPOINT_REACHED": "Đến điểm dừng",
}

#: After these the street is the one you drive along ("trên"), not onto ("vào").
ALONG = {"DEPART", "STRAIGHT", "FOLLOW", "KEEP_LEFT", "KEEP_RIGHT"}


def vi_instruction(ins: dict[str, Any]) -> str:
    code = str(ins.get("maneuver", ""))
    text = VI.get(code, "Tiếp tục")
    exit_no = ins.get("roundaboutExitNumber")
    if code.startswith("ROUNDABOUT") and code != "ROUNDABOUT_CROSS" and exit_no:
        text = f"Vào vòng xuyến, đi lối ra thứ {exit_no}"
    if code.startswith(("ARRIVE", "WAYPOINT")):
        return text
    street = ins.get("street") or ", ".join(ins.get("roadNumbers") or [])
    if street:
        text = f"{text} {'trên' if code in ALONG else 'vào'} {street}"
    return text
```

- [ ] **Step 5: Implement `backend/friday/geo/tomtom.py`**

```python
"""TomTom Search, Places and Routing (spec §6) — one vendor, one server key.

TOMTOM_API_KEY never leaves this process; the browser's
NEXT_PUBLIC_TOMTOM_MAP_KEY is enabled for Map Display only. Unset means
search and directions are off, not broken. Free allowances are per API per
month (spec §6.1) — fuzzy search is only 2.5K — so every call is cached and
proximity is rounded to ~1 km before it leaves (spec §6.5). Same urllib +
to_thread shape as tools/integrations/fetch.py; no HTTP dependency.
"""

import asyncio
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from .maneuvers import vi_instruction

BASE = "https://api.tomtom.com"
TIMEOUT_S = 10.0
LANGUAGE = "vi-VN"
#: Contract profiles in preference order — all four are on the free plan.
PROFILE_ORDER = ("motor_scooter", "auto", "bicycle", "pedestrian")
TRAVEL_MODE = {"motor_scooter": "motorcycle", "auto": "car", "bicycle": "bicycle", "pedestrian": "pedestrian"}
#: A Places Details path ("pois/<id>"); anything else is refused, never fetched.
PLACE_REF = re.compile(r"^[a-z]+/[A-Za-z0-9_-]+$")


class TomTomUnavailable(Exception):
    """No key, rejected key, TomTom failing or unreachable."""


class QuotaExceeded(Exception):
    """429 — this month's free allowance for the API is used up."""


class NoRoute(Exception):
    """Routing ran and the stops are not connected by the road network."""


class UnsupportedProfile(Exception):
    """A travel mode outside the contract enum."""


def available_profiles() -> list[str]:
    return list(PROFILE_ORDER)


def default_profile() -> str:
    return PROFILE_ORDER[0]


def coarse(lat: float, lon: float) -> tuple[float, float]:
    return round(lat, 2), round(lon, 2)


class _Lru:
    def __init__(self, size: int) -> None:
        self.size = size
        self.data: "OrderedDict[str, Any]" = OrderedDict()

    def get(self, key: str) -> Any:
        if key not in self.data:
            return None
        self.data.move_to_end(key)
        return self.data[key]

    def put(self, key: str, value: Any) -> Any:
        self.data[key] = value
        if len(self.data) > self.size:
            self.data.popitem(last=False)
        return value


_CACHES = {"suggest": _Lru(512), "place": _Lru(256), "reverse": _Lru(256), "search": _Lru(256), "route": _Lru(256)}


def clear_cache() -> None:
    for cache in _CACHES.values():
        cache.data.clear()


def _base() -> str:
    # Test hook, like FRIDAY_ALLOW_PRIVATE_FETCH: point at a local fake.
    return os.getenv("FRIDAY_TOMTOM_URL", BASE).rstrip("/")


def _key() -> str:
    key = os.getenv("TOMTOM_API_KEY")
    if not key:
        raise TomTomUnavailable("TOMTOM_API_KEY is not set")
    return key


def _places_headers(attributes: str) -> dict[str, str]:
    return {"TomTom-Api-Key": _key(), "TomTom-Api-Version": "3", "Attributes": attributes, "Accept-Language": LANGUAGE}


def _message(err: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(err.read())
    except (ValueError, OSError):
        return ""
    return str((body.get("detailedError") or {}).get("message") or body.get("errorText") or body.get("message") or "")


def _http(url: str, *, body: dict | None = None, headers: dict | None = None, no_route_on_400: bool = False) -> Any:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json", **(headers or {})},
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        if err.code == 429:
            raise QuotaExceeded("TomTom free allowance used up") from err
        if err.code == 400 and no_route_on_400:
            raise NoRoute(_message(err)) from err
        raise TomTomUnavailable(f"tomtom HTTP {err.code}: {_message(err)}") from err
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        raise TomTomUnavailable(str(err)) from err


async def _cached(name: str, key: str, fetch: Callable[[], Any]) -> Any:
    cache = _CACHES[name]
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, await asyncio.to_thread(fetch))


# ---------- places (autocomplete) ----------

def _suggestion(result: dict[str, Any]) -> dict[str, Any] | None:
    more = result.get("more") or {}
    parts = more.get("pathParameters") or []
    if result.get("type") == "discoverAction" or more.get("operation") != "details" or not parts:
        return None
    ref = "/".join(str(p) for p in parts)
    if not PLACE_REF.match(ref):
        return None
    return {
        "ref": ref,
        "title": result.get("title", ""),
        "subtitle": ", ".join(result.get("subtitles") or []),
        "type": result.get("type", ""),
    }


async def suggest(query: str, near: tuple[float, float] | None = None, limit: int = 6) -> list[dict[str, Any]]:
    body: dict[str, Any] = {"query": query, "maxResults": limit}
    if near is not None:
        lat, lon = coarse(*near)
        body["origin"] = {"type": "Point", "coordinates": [lon, lat]}
    headers = _places_headers("results")
    url = f"{_base()}/maps/orbis/places/suggest"
    raw = await _cached("suggest", json.dumps([query.strip().lower(), body.get("origin"), limit]),
                        lambda: _http(url, body=body, headers=headers))
    return [s for s in (_suggestion(r) for r in raw.get("results", [])) if s]


async def place(ref: str) -> dict[str, float]:
    if not PLACE_REF.match(ref):
        raise ValueError(f"bad place ref {ref!r}")
    headers = _places_headers("position")
    raw = await _cached("place", ref, lambda: _http(f"{_base()}/maps/orbis/places/details/{ref}", headers=headers))
    coords = ((raw or {}).get("position") or {}).get("coordinates")
    if not coords:
        raise TomTomUnavailable("place has no position")
    return {"lat": coords[1], "lon": coords[0]}


# ---------- search / reverse ----------

async def reverse(lat: float, lon: float) -> str | None:
    params = urllib.parse.urlencode({"key": _key(), "language": LANGUAGE})
    url = f"{_base()}/search/2/reverseGeocode/{lat:.6f},{lon:.6f}.json?{params}"
    raw = await _cached("reverse", f"{lat:.5f},{lon:.5f}", lambda: _http(url))
    for entry in raw.get("addresses", []):
        text = (entry.get("address") or {}).get("freeformAddress")
        if text:
            return text
    return None


def _search_hit(result: dict[str, Any]) -> dict[str, Any]:
    address = (result.get("address") or {}).get("freeformAddress", "")
    return {
        "label": (result.get("poi") or {}).get("name") or address,
        "address": address,
        "category": (result.get("type") or "").lower() or None,
        "lat": result["position"]["lat"],
        "lon": result["position"]["lon"],
    }


async def search(query: str, near: tuple[float, float] | None = None, limit: int = 5) -> list[dict[str, Any]]:
    """Fuzzy search — agent tools only (2.5K/month; the UI uses suggest)."""
    params = {"key": _key(), "language": LANGUAGE, "limit": str(limit)}
    rounded = coarse(*near) if near is not None else None
    if rounded is not None:
        params["lat"], params["lon"] = str(rounded[0]), str(rounded[1])
    url = f"{_base()}/search/2/search/{urllib.parse.quote(query)}.json?{urllib.parse.urlencode(params)}"
    raw = await _cached("search", json.dumps([query.strip().lower(), rounded, limit]), lambda: _http(url))
    return [_search_hit(r) for r in raw.get("results", []) if r.get("position")][:limit]


# ---------- routing ----------

def _normalize(route: dict[str, Any]) -> dict[str, Any]:
    summary = route.get("summary") or {}
    total_m = summary.get("lengthInMeters", 0)
    total_s = summary.get("travelTimeInSeconds", 0)
    # pointIndex counts across the whole route, so the legs join in order.
    coords = [[round(p["longitude"], 6), round(p["latitude"], 6)] for leg in route.get("legs", []) for p in leg.get("points", [])]
    steps = (route.get("guidance") or {}).get("instructions", [])
    maneuvers = []
    for i, ins in enumerate(steps):
        nxt = steps[i + 1] if i + 1 < len(steps) else {}
        maneuvers.append({
            "instruction": vi_instruction(ins),
            "maneuver": ins.get("maneuver", ""),
            "distance_m": round(nxt.get("routeOffsetInMeters", total_m) - ins.get("routeOffsetInMeters", 0)),
            "duration_s": round(nxt.get("travelTimeInSeconds", total_s) - ins.get("travelTimeInSeconds", 0)),
            "begin_shape_index": ins.get("pointIndex", 0),
        })
    return {
        "distance_m": round(total_m),
        "duration_s": round(total_s),
        "traffic_delay_s": round(summary.get("trafficDelayInSeconds", 0)),
        "coordinates": coords,
        "maneuvers": maneuvers,
    }


async def route(waypoints: list[dict], profile: str | None = None) -> dict[str, Any]:
    key = _key()
    profile = profile or default_profile()
    if profile not in TRAVEL_MODE:
        raise UnsupportedProfile(profile)
    stops = ":".join(f"{w['lat']},{w['lon']}" for w in waypoints)
    params = {"key": key, "travelMode": TRAVEL_MODE[profile], "instructionsType": "coded",
              "traffic": "true", "routeRepresentation": "polyline"}
    # Alternatives only between two stops.
    if len(waypoints) == 2:
        params["maxAlternatives"] = "2"
    url = f"{_base()}/routing/1/calculateRoute/{stops}/json?{urllib.parse.urlencode(params)}"
    cache_key = json.dumps([[(round(w["lat"], 5), round(w["lon"], 5)) for w in waypoints], profile])
    raw = await _cached("route", cache_key, lambda: _http(url, no_route_on_400=True))
    routes = [_normalize(r) for r in raw.get("routes", [])]
    if not routes:
        raise NoRoute("no routes")
    return {"routes": routes}
```

- [ ] **Step 6: Run the tests**

Run: `python backend/runtests.py test_maneuvers test_tomtom`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/friday/geo/tomtom.py backend/friday/geo/maneuvers.py backend/tests/unit/test_tomtom.py backend/tests/unit/test_maneuvers.py
git commit -m "feat(geo): TomTom client with Vietnamese turn instructions"
```

---

### Task 2: `/geo/*` endpoints on TomTom

**Files:**
- Modify: `backend/friday/api/routes.py` (imports; the `/geo/profiles` + `/geo/route` block at ~658-676), `backend/friday/api/schemas.py:152-158`
- Delete: `backend/friday/geo/graphhopper.py`, `backend/tests/unit/test_graphhopper.py`
- Test: `backend/tests/integration/test_geo_route.py` (full rewrite)

**Interfaces:**
- Consumes: `friday.geo.tomtom` (Task 1).
- Produces (HTTP): `GET /geo/suggest?q=&lat=&lon=` → `{"suggestions": [...]}`; `GET /geo/place?ref=` → `{"lat","lon"}`; `GET /geo/reverse?lat=&lon=` → `{"address"}`; `POST /geo/route` (unchanged body; adds 429); `GET /geo/profiles` (now all four).

- [ ] **Step 1: Rewrite the integration test**

Replace `backend/tests/integration/test_geo_route.py` with:

```python
"""The /geo/* proxy endpoints — validation, error mapping, origin guard.

    PYTHONPATH=. python tests/integration/test_geo_route.py
"""

import os

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"

from fastapi.testclient import TestClient

from friday.geo import tomtom as tt
from friday.main import app

client = TestClient(app)
A = {"lat": 21.0288, "lon": 105.8525}
B = {"lat": 21.0368, "lon": 105.8346}
ROUTE = {"routes": [{"distance_m": 2412, "duration_s": 545, "traffic_delay_s": 0, "coordinates": [], "maneuvers": []}]}
NAMES = ("suggest", "place", "reverse", "route")
ORIGINAL = {n: getattr(tt, n) for n in NAMES}


def fake(name, result=None, exc=None):
    calls = []

    async def fn(*args, **kwargs):
        calls.append(args)
        if exc is not None:
            raise exc
        return result

    setattr(tt, name, fn)
    return calls


def restore():
    for n, fn in ORIGINAL.items():
        setattr(tt, n, fn)


def test_suggest() -> None:
    calls = fake("suggest", [{"ref": "pois/hg", "title": "Hồ Gươm", "subtitle": "", "type": "poi"}])
    try:
        res = client.get("/geo/suggest", params={"q": "hồ g", "lat": 21.03, "lon": 105.85})
        assert res.status_code == 200 and res.json()["suggestions"][0]["ref"] == "pois/hg", res.text
        assert calls == [("hồ g", (21.03, 105.85))]
        assert client.get("/geo/suggest", params={"q": "hồ"}).status_code == 422  # < 3 chars
        client.get("/geo/suggest", params={"q": "hồ gươm"})
        assert calls[-1] == ("hồ gươm", None)
    finally:
        restore()


def test_place_and_reverse() -> None:
    fake("place", {"lat": 21.0288, "lon": 105.8525})
    fake("reverse", "Hoàn Kiếm, Hà Nội")
    try:
        assert client.get("/geo/place", params={"ref": "pois/hg"}).json() == {"lat": 21.0288, "lon": 105.8525}
        assert client.get("/geo/place", params={"ref": "../x"}).status_code == 422
        assert client.get("/geo/reverse", params={"lat": 21.0288, "lon": 105.8525}).json() == {"address": "Hoàn Kiếm, Hà Nội"}
        assert client.get("/geo/reverse", params={"lat": 91, "lon": 0}).status_code == 422
    finally:
        restore()


def test_route_defaults_to_the_plans_mode() -> None:
    calls = fake("route", ROUTE)
    try:
        res = client.post("/geo/route", json={"waypoints": [A, B]})
        assert res.status_code == 200 and res.json() == ROUTE, res.text
        assert calls == [([A, B], None)]
        for body in ({"waypoints": [A]}, {"waypoints": [A, B], "profile": "rocket"}):
            assert client.post("/geo/route", json=body).status_code == 422, body
    finally:
        restore()


def test_error_mapping() -> None:
    try:
        cases = (
            ("route", lambda: client.post("/geo/route", json={"waypoints": [A, B]}), tt.TomTomUnavailable("no key"), 503, {"error": "routing_unavailable"}),
            ("route", lambda: client.post("/geo/route", json={"waypoints": [A, B]}), tt.QuotaExceeded(), 429, {"error": "quota_exceeded"}),
            ("route", lambda: client.post("/geo/route", json={"waypoints": [A, B]}), tt.NoRoute("x"), 422, {"error": "no_route"}),
            ("suggest", lambda: client.get("/geo/suggest", params={"q": "abc"}), tt.QuotaExceeded(), 429, {"error": "quota_exceeded"}),
            ("reverse", lambda: client.get("/geo/reverse", params={"lat": 1, "lon": 2}), tt.TomTomUnavailable("x"), 503, {"error": "unavailable"}),
            ("place", lambda: client.get("/geo/place", params={"ref": "pois/x"}), tt.TomTomUnavailable("x"), 503, {"error": "unavailable"}),
        )
        for name, call, exc, status, body in cases:
            fake(name, exc=exc)
            res = call()
            assert res.status_code == status and res.json() == body, (name, res.status_code, res.text)
    finally:
        restore()


def test_profiles_are_all_four() -> None:
    assert client.get("/geo/profiles").json() == {"profiles": ["motor_scooter", "auto", "bicycle", "pedestrian"]}


def test_origin_guard() -> None:
    fake("route", ROUTE)
    try:
        evil = {"origin": "https://evil.example"}
        assert client.post("/geo/route", json={"waypoints": [A, B]}, headers=evil).status_code == 403
        assert client.get("/geo/suggest", params={"q": "abc"}, headers=evil).status_code == 403
    finally:
        restore()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

- [ ] **Step 2: Run to watch it fail**

Run: `python backend/runtests.py test_geo_route`
Expected: FAIL — `/geo/suggest` 404, profiles still the GraphHopper free plan.

- [ ] **Step 3: Endpoints**

In `backend/friday/api/routes.py`:
- `from fastapi import APIRouter, Depends, Header, HTTPException` → add `Query as QueryParam` (the name `Query` is already taken by `friday.api.schemas.Query`).
- `from friday.geo import graphhopper` → `from friday.geo import tomtom`.
- Replace the `geo_profiles` and `geo_route` endpoints with:

```python
def _geo_error(err: Exception, unavailable: str = "unavailable") -> JSONResponse:
    """Quota and outages read differently in the UI, so they stay distinct."""
    if isinstance(err, tomtom.QuotaExceeded):
        return JSONResponse(status_code=429, content={"error": "quota_exceeded"})
    return JSONResponse(status_code=503, content={"error": unavailable})


@router.get("/geo/suggest", dependencies=[Depends(require_known_origin)])
async def geo_suggest(
    q: str = QueryParam(min_length=3, max_length=120),
    lat: float | None = QueryParam(default=None, ge=-90, le=90),
    lon: float | None = QueryParam(default=None, ge=-180, le=180),
) -> Any:
    """Autocomplete (spec §6.3) — TomTom Places Suggest, cached."""
    near = (lat, lon) if lat is not None and lon is not None else None
    try:
        return {"suggestions": await tomtom.suggest(q, near)}
    except (tomtom.TomTomUnavailable, tomtom.QuotaExceeded) as err:
        return _geo_error(err)


@router.get("/geo/place", dependencies=[Depends(require_known_origin)])
async def geo_place(ref: str = QueryParam(max_length=200, pattern=r"^[a-z]+/[A-Za-z0-9_-]+$")) -> Any:
    """Position of a picked suggestion — Places Details, only on pick."""
    try:
        return await tomtom.place(ref)
    except (tomtom.TomTomUnavailable, tomtom.QuotaExceeded) as err:
        return _geo_error(err)


@router.get("/geo/reverse", dependencies=[Depends(require_known_origin)])
async def geo_reverse(
    lat: float = QueryParam(ge=-90, le=90),
    lon: float = QueryParam(ge=-180, le=180),
) -> Any:
    try:
        return {"address": await tomtom.reverse(lat, lon)}
    except (tomtom.TomTomUnavailable, tomtom.QuotaExceeded) as err:
        return _geo_error(err)


@router.get("/geo/profiles", dependencies=[Depends(require_known_origin)])
async def geo_profiles() -> dict[str, Any]:
    """Travel modes the routing plan allows, default first — the map's tabs."""
    return {"profiles": tomtom.available_profiles()}


@router.post("/geo/route", dependencies=[Depends(require_known_origin)])
async def geo_route(body: RouteRequest) -> Any:
    """Spec §6.3 — one route question for the map UI; cached in the client."""
    try:
        # Looked up on the module so tests can swap tomtom.route.
        return await tomtom.route([w.model_dump() for w in body.waypoints], body.profile)
    except (tomtom.TomTomUnavailable, tomtom.QuotaExceeded) as err:
        return _geo_error(err, "routing_unavailable")
    except tomtom.NoRoute:
        return JSONResponse(status_code=422, content={"error": "no_route"})
    except tomtom.UnsupportedProfile:
        return JSONResponse(status_code=422, content={"error": "unsupported_profile"})
```

In `backend/friday/api/schemas.py`, `RouteRequest`: docstring → `"""POST /geo/route — validated here so TomTom only sees sane input (and no request is spent on one that could never succeed)."""`; the profile comment → `#: None = the default travel mode (motorbike; see geo/tomtom.py).`

Delete: `git rm backend/friday/geo/graphhopper.py backend/tests/unit/test_graphhopper.py`.

- [ ] **Step 4: Run the tests**

Run: `python backend/runtests.py test_geo_route test_tomtom`
Expected: PASS. (`test_geo_tools` fails until Task 3 — it still imports `graphhopper`/`maptiler`.)

- [ ] **Step 5: Commit**

```bash
git add -A backend/friday/api backend/friday/geo backend/tests
git commit -m "feat(geo): TomTom-backed suggest, place, reverse and route endpoints"
```

---

### Task 3: Agent tools on TomTom

**Files:**
- Modify: `backend/friday/geo/tools.py`, `backend/friday/geo/__init__.py`, `backend/friday/tools/registry.py` (find_place / get_directions entries), `backend/.env.example`
- Delete: `backend/friday/geo/maptiler.py`
- Test: `backend/tests/unit/test_geo_tools.py`

**Interfaces:**
- Consumes: `tomtom.search`, `tomtom.route`, `tomtom.default_profile`, `tomtom.PROFILE_ORDER`, exceptions (Task 1).
- Produces: `get_directions` output gains `traffic_delay_min`; default profile `motor_scooter`; quota → error dict.

- [ ] **Step 1: Update the tests**

In `backend/tests/unit/test_geo_tools.py`:
- line 1 docstring: `"""find_place / get_directions with a fake TomTom module.`
- imports: `from friday.geo import tomtom, tools` (drop `graphhopper`, `maptiler`; drop the now-unused `os`, `urllib.parse`).
- `ROUTE`: each maneuver `"sign": 0` → `"maneuver": "STRAIGHT"`, and add `"traffic_delay_s": 360` to the route dict.
- in `fake()`: `maptiler.search, graphhopper.route = search, route_fn` → `tomtom.search, tomtom.route = search, route_fn`, and `route_fn`'s signature → `async def route_fn(waypoints, profile=None):`.
- `ORIG = (tomtom.search, tomtom.route)`; `restore()` → `tomtom.search, tomtom.route = ORIG`.
- the comment `# rounding happens in maptiler.search` → `# rounding happens in tomtom.search`.
- rename `test_directions_default_to_the_plans_mode_and_cap_steps` → `test_directions_default_to_motorbike_and_cap_steps`; in it replace the three `"auto"` expectations with `"motor_scooter"`, drop the free-plan comment, and add `assert out["traffic_delay_min"] == 6`.
- in `test_directions_errors_are_error_dicts` replace the body with:

```python
    try:
        fake({"a": [HG], "b": [LB]}, route_exc=tomtom.TomTomUnavailable("no key"))
        assert "not configured" in run(tools.run_get_directions({"from": "a", "to": "b"}))["error"]
        fake({"a": [HG], "b": [LB]}, route_exc=tomtom.QuotaExceeded())
        assert "allowance" in run(tools.run_get_directions({"from": "a", "to": "b"}))["error"]
        fake({"a": [HG], "b": [LB]}, route_exc=tomtom.NoRoute("not connected"))
        assert "no route" in run(tools.run_get_directions({"from": "a", "to": "b"}))["error"]
        fake({"a": [HG]}, route=ROUTE)
        assert "nowhere" in run(tools.run_get_directions({"from": "a", "to": "nowhere"}))["error"]
        assert "profile" in run(tools.run_get_directions({"from": "a", "to": "a", "profile": "rocket"}))["error"]
    finally:
        restore()
```

- delete `test_maptiler_sends_only_a_coarse_position` and `test_maptiler_without_a_key_is_unavailable` (covered by `test_tomtom.py`).
- add:

```python
def test_find_place_quota_is_an_error_dict() -> None:
    async def quota(query, near=None, limit=5):
        raise tomtom.QuotaExceeded()

    tomtom.search = quota
    try:
        assert "allowance" in run(tools.run_find_place({"query": "cafe"}))["error"]
    finally:
        restore()
```

- [ ] **Step 2: Run to watch it fail**

Run: `python backend/runtests.py test_geo_tools`
Expected: FAIL — `tools` still imports `graphhopper`/`maptiler`.

- [ ] **Step 3: Switch `tools.py`**

- `from . import graphhopper, maptiler` → `from . import tomtom`.
- Add below `NO_LOCATION`:

```python
QUOTA = {"error": "the map provider's free allowance for this month is used up"}
```

- `_first`: comment → `# Looked up on the module so tests can swap tomtom.search.` and `maptiler.search(` → `tomtom.search(`.
- `run_find_place`: `maptiler.search(` → `tomtom.search(`; replace its `except maptiler.GeocodeUnavailable as err:` clause with:

```python
    except tomtom.QuotaExceeded:
        return QUOTA
    except tomtom.TomTomUnavailable as err:
        return {"error": f"place search unavailable: {err}"}
```

- `run_get_directions`: replace the profile block (first five statements up to and including the scooter refusal) with:

```python
    profile = payload.get("profile") or tomtom.default_profile()
    if profile not in tomtom.PROFILE_ORDER:
        return {"error": f"unknown profile '{profile}'"}
```

  replace the routing call and its `except` clauses with:

```python
        # Looked up on the module so tests can swap tomtom.route.
        result = await tomtom.route([{"lat": s["lat"], "lon": s["lon"]} for s in stops], profile)
    except tomtom.QuotaExceeded:
        return QUOTA
    except tomtom.TomTomUnavailable:
        return {"error": "search and directions are not configured on this server"}
    except tomtom.NoRoute:
        return {"error": "no route found between these places"}
    except tomtom.UnsupportedProfile:
        return {"error": f"unknown profile '{profile}'"}
```

  and add to the returned dict, after `"duration_min"`: `"traffic_delay_min": round(best.get("traffic_delay_s", 0) / 60),`.

`backend/friday/geo/__init__.py` docstring → `"""Maps: TomTom search, places and routing (spec 2026-09-21)."""`. Delete `git rm backend/friday/geo/maptiler.py`.

- [ ] **Step 4: Registry**

In `backend/friday/tools/registry.py`:
- `find_place` description: replace "…pins a map preview" wording only if it names MapTiler; the risk comment "Reads a public geocoder" stays true.
- `get_directions` description →

```python
            description=(
                "Directions between places, shown on the street map with "
                "distance, time and the current traffic delay. from/to are "
                "place names or 'my_location'. profile: motor_scooter "
                "(default, xe máy), auto (car), bicycle, pedestrian."
            ),
```

  and the profile enum → `["motor_scooter", "auto", "bicycle", "pedestrian"]`.

- [ ] **Step 5: Env**

In `backend/.env.example` replace the GraphHopper block and the `MAPTILER_SERVER_KEY` block with:

```
# Street map search + directions (spec 2026-09-21 §6) — TomTom, https://developer.tomtom.com
# Enable Search, Places, Reverse Geocoding and Routing on this key; it never
# reaches the browser (the browser key is NEXT_PUBLIC_TOMTOM_MAP_KEY, Map
# Display only). Unset: the map works but search/directions say unconfigured.
# Free allowances are per API per month; fuzzy search (agent find_place) is
# only 2.5K/month.
# TOMTOM_API_KEY=
```

- [ ] **Step 6: Run the backend suite**

Run: `python backend/runtests.py`
Expected: PASS, and `git grep -n -i "graphhopper\|maptiler" -- backend` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add -A backend
git commit -m "feat(geo): find_place and get_directions on TomTom with traffic delay"
```

---

### Task 4: Map display on TomTom

**Files:**
- Modify: `src/components/friday/map/mapApi.ts` (styles/keys part), `src/components/friday/map/MapLayer.tsx`, `src/proxy.ts:31`, `.env.example:32-33`, `playwright.config.ts:101-103`
- Test: `tests/unit/mapApi.spec.ts`, `tests/ui/map.spec.ts` (stub helper)

**Interfaces:**
- Produces (`mapApi.ts`): `TOMTOM_MAP_KEY`, `TOMTOM_STYLE_VERSION`, `type MapStyleId = "dark" | "light" | "satellite"`, `styleUrl(id: MapStyleId, traffic?: boolean)`, `withTomTomKey(url: string): string`. Removed: `MAPTILER_KEY`.
- Produces (`map.spec.ts`): `stubTomTom(page, opts?)` replacing `stubMapTiler`.

- [ ] **Step 1: Update the tests**

In `tests/unit/mapApi.spec.ts`, replace the style test with:

```ts
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
```

(add `withTomTomKey` to the import).

In `tests/ui/map.spec.ts` replace the header comment and `stubMapTiler` with:

```ts
/**
 * Street map (spec 2026-09-21). api.tomtom.com is stubbed: a background-only
 * style is enough for real MapLibre to load in Chromium without the network.
 * Search and reverse geocoding go through the orchestrator, stubbed per test.
 */
```

```ts
export async function stubTomTom(
  page: Page,
  opts: { suggestions?: unknown[]; places?: Record<string, unknown>; address?: string | null } = {},
) {
  await page.route("https://api.tomtom.com/**", (r) => r.fulfill({ json: STYLE }));
  await page.route("**/geo/suggest?**", (r) => r.fulfill({ json: { suggestions: opts.suggestions ?? [] } }));
  await page.route("**/geo/place?**", (r) => {
    const ref = new URL(r.request().url()).searchParams.get("ref") ?? "";
    return r.fulfill({ json: opts.places?.[ref] ?? { lat: 21.0288, lon: 105.8525 } });
  });
  await page.route("**/geo/reverse?**", (r) => r.fulfill({ json: { address: opts.address ?? null } }));
}
```

and rename every `stubMapTiler(page` call to `stubTomTom(page` (the search/right-click tests are rewritten in Task 5; for now pass no options).

- [ ] **Step 2: Run to watch the unit test fail**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts`
Expected: FAIL — `withTomTomKey` missing, style URL is MapTiler.

- [ ] **Step 3: `mapApi.ts` styles and key**

Replace the header comment, `MAPTILER_KEY`, `MapStyleId`, `STYLE_PATH` and `styleUrl` with:

```ts
/**
 * Everything the map talks to (spec §4.3): TomTom styles/tiles with the
 * browser's Map-Display-only key, and the orchestrator's /geo/* endpoints for
 * search, places, reverse geocoding and routing (the TomTom server key never
 * reaches the browser). Pure helpers (styles, step geometry, format) are
 * unit-tested.
 */
import { getApiBase } from "@/lib/api/session";
import type { MapProfile } from "@/lib/visualization/types";

export const TOMTOM_MAP_KEY = process.env.NEXT_PUBLIC_TOMTOM_MAP_KEY ?? "";

/** Map Styles v2 resource version; confirmed against the live API in Task 0/7. */
export const TOMTOM_STYLE_VERSION = "22.2.1-*";

export type MapStyleId = "dark" | "light" | "satellite";

const STYLES: Record<MapStyleId, { map: string; poi: string; flow: string }> = {
  dark: { map: "2/basic_street-dark", poi: "2/poi_dark", flow: "2/flow_relative-dark" },
  light: { map: "2/basic_street-light", poi: "2/poi_light", flow: "2/flow_relative-light" },
  satellite: { map: "2/hybrid_street-satellite", poi: "2/poi_dark", flow: "2/flow_relative-dark" },
};

export function styleUrl(id: MapStyleId, traffic = false): string {
  const s = STYLES[id];
  const params = new URLSearchParams({ key: TOMTOM_MAP_KEY, map: s.map, poi: s.poi });
  if (traffic) params.set("traffic_flow", s.flow);
  return `https://api.tomtom.com/style/1/style/${TOMTOM_STYLE_VERSION}?${params}`;
}

/** MapLibre `transformRequest`: TomTom tiles/sprites/glyphs named by the style may omit the key. */
export function withTomTomKey(url: string): string {
  if (!url.startsWith("https://api.tomtom.com/") || /[?&]key=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(TOMTOM_MAP_KEY)}`;
}
```

(the `getApiBase` / `MapProfile` imports already exist — keep one copy).

- [ ] **Step 4: `MapLayer.tsx`**

- Import `withTomTomKey` from `./mapApi` (keep `styleUrl`).
- `STYLE_OPTIONS`: remove the `terrain` entry.
- Delete `preferVietnameseLabels` and its call in the `style.load` handler.
- Replace `setBuildings3d` with a toggle over the style's own extrusions only:

```tsx
/** Toggle the style's own 3D building layers (the switch only shows when it has some). */
function setBuildings3d(map: MlMap, on: boolean) {
  for (const layer of map.getStyle().layers) {
    if (layer.type === "fill-extrusion") map.setLayoutProperty(layer.id, "visibility", on ? "visible" : "none");
  }
  map.easeTo({ pitch: on ? 55 : 0, duration: 600 });
}
```

- State: add `const [traffic, setTraffic] = useState(false);` and `const [has3d, setHas3d] = useState(false);`.
- In the `new MlMap({...})` options add `transformRequest: (url) => ({ url: withTomTomKey(url) }),`.
- The `style.load` handler becomes:

```tsx
    m.on("style.load", () => {
      m.setProjection({ type: "globe" });
      setHas3d(m.getStyle().layers.some((l) => l.type === "fill-extrusion"));
    });
```

- `chooseStyle` → `map?.setStyle(styleUrl(id, traffic));`, and add:

```tsx
  const toggleTraffic = (on: boolean) => {
    setTraffic(on);
    setBuildings(false);
    map?.setStyle(styleUrl(styleId, on));
  };
```

- In the layer menu, wrap the 3D `<label>` in `{has3d && (…)}` and add before it:

```tsx
            <label className="mt-1 flex items-center gap-2 px-2 py-1 text-sm">
              <input type="checkbox" checked={traffic} onChange={(e) => toggleTraffic(e.target.checked)} />
              Giao thông
            </label>
```

- [ ] **Step 5: CSP, env, test env**

- `src/proxy.ts:31`: `img-src 'self' data: blob: https://api.tomtom.com;` and the comment above it: `MapLibre sprites from TomTom and its blob-module worker`.
- `.env.example` lines 30-33 (the street-map block) →

```
# Street map (MapLibre + TomTom Map Display). Client-visible by design: enable
# this key for Map Display only in the TomTom dashboard. Without it the map
# opens blank. Search and directions use TOMTOM_API_KEY on the backend
# (backend/.env.example), which never reaches the browser.
# NEXT_PUBLIC_TOMTOM_MAP_KEY=
```

- `playwright.config.ts`: `NEXT_PUBLIC_MAPTILER_KEY: "test-key"` → `NEXT_PUBLIC_TOMTOM_MAP_KEY: "test-key"`, comment `…the map UI tests stub api.tomtom.com…`.

- [ ] **Step 6: Run the tests**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts` → PASS.
Run: `npx playwright test --project=ui tests/ui/map.spec.ts -g "agent map spec|zooming|reduced motion"` → PASS (search/route tests are updated in Tasks 5–6).

- [ ] **Step 7: Commit**

```bash
git add src/components/friday/map/mapApi.ts src/components/friday/map/MapLayer.tsx src/proxy.ts .env.example playwright.config.ts tests/unit/mapApi.spec.ts tests/ui/map.spec.ts
git commit -m "feat(map): TomTom styles with a traffic layer and key-scoped tiles"
```

---

### Task 5: Search and place card through the orchestrator

**Files:**
- Modify: `src/components/friday/map/mapApi.ts` (geocoding part), `src/components/friday/map/MapSearch.tsx` (full replacement)
- Test: `tests/ui/map.spec.ts` (search + right-click tests)

**Interfaces:**
- Produces (`mapApi.ts`): `interface Suggestion { ref; title; subtitle; type }`, `type SuggestResult = { ok: true; suggestions: Suggestion[] } | { ok: false; reason: "quota" | "unavailable" }`, `suggestPlaces(query, near, signal?)`, `resolvePlace(s: Suggestion, signal?) -> Place | null`, `reverseGeocode(lat, lon, signal?) -> Place | null` (same signature as before; `PlacePanel` is unchanged). Removed: `parseGeocoding`, `searchPlaces`.

- [ ] **Step 1: Rewrite the two UI tests**

Replace `GEOCODE` and the search / right-click tests in `tests/ui/map.spec.ts` with:

```ts
const SUGGESTIONS = [
  { ref: "pois/hg", title: "Hồ Gươm", subtitle: "Hoàn Kiếm, Hà Nội", type: "poi" },
  { ref: "pois/ht", title: "Hồ Tây", subtitle: "Tây Hồ, Hà Nội", type: "poi" },
];

test("search suggests after three characters, resolves the pick and opens the place card", async ({ page }) => {
  await stubTomTom(page, { suggestions: SUGGESTIONS, places: { "pois/ht": { lat: 21.0583, lon: 105.8194 } } });
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  const box = page.getByRole("combobox", { name: "Tìm kiếm địa điểm" });
  await box.click();
  await box.pressSequentially("hồ", { delay: 20 });
  await page.waitForTimeout(600);
  await expect(page.getByRole("option")).toHaveCount(0); // two characters: no request
  await box.pressSequentially(" t", { delay: 20 });
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

test("an exhausted search quota says so", async ({ page }) => {
  await stubTomTom(page);
  await page.route("**/geo/suggest?**", (r) => r.fulfill({ status: 429, json: { error: "quota_exceeded" } }));
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  const box = page.getByRole("combobox", { name: "Tìm kiếm địa điểm" });
  await box.click();
  await box.pressSequentially("hồ gươm", { delay: 20 });
  await expect(page.getByRole("status").filter({ hasText: "Tìm kiếm tạm hết hạn mức" })).toBeVisible();
});

test("right-click offers directions from/to and what's here", async ({ page }) => {
  await stubTomTom(page, { address: "Đinh Tiên Hoàng, Hoàn Kiếm, Hà Nội" });
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  const size = page.viewportSize()!;
  await page.mouse.click(size.width / 2, size.height / 2, { button: "right" });
  const menu = page.getByRole("menu", { name: "Tùy chọn vị trí" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Đây là đâu?" }).click();
  await expect(page.getByTestId("place-card")).toContainText("Hoàn Kiếm"); // from /geo/reverse
});
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts -g "search|quota|right-click"`
Expected: FAIL — the box still calls MapTiler (stubbed to the style JSON), so no options appear.

- [ ] **Step 3: `mapApi.ts` geocoding part**

Delete `parseGeocoding`, `searchPlaces` and the old `reverseGeocode`; add after `Endpoint`:

```ts
/** One autocomplete row; its position is fetched only when picked (Places Details is 5K/month). */
export interface Suggestion {
  ref: string;
  title: string;
  subtitle: string;
  type: string;
}

export type SuggestResult =
  | { ok: true; suggestions: Suggestion[] }
  | { ok: false; reason: "quota" | "unavailable" };

/** `near` is rounded to ~1 km before it leaves the browser (spec §6.5). */
export async function suggestPlaces(
  query: string,
  near: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<SuggestResult> {
  const params = new URLSearchParams({ q: query });
  if (near) {
    params.set("lat", near.lat.toFixed(2));
    params.set("lon", near.lon.toFixed(2));
  }
  const res = await fetch(`${getApiBase()}/geo/suggest?${params}`, { signal });
  if (res.status === 429) return { ok: false, reason: "quota" };
  if (!res.ok) return { ok: false, reason: "unavailable" };
  const body = (await res.json()) as { suggestions?: Suggestion[] };
  return { ok: true, suggestions: body.suggestions ?? [] };
}

export async function resolvePlace(s: Suggestion, signal?: AbortSignal): Promise<Place | null> {
  const res = await fetch(`${getApiBase()}/geo/place?${new URLSearchParams({ ref: s.ref })}`, { signal });
  if (!res.ok) return null;
  const { lat, lon } = (await res.json()) as { lat: number; lon: number };
  return { label: s.title, address: s.subtitle, category: s.type || undefined, lat, lon };
}

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<Place | null> {
  const res = await fetch(`${getApiBase()}/geo/reverse?${new URLSearchParams({ lat: String(lat), lon: String(lon) })}`, { signal });
  if (!res.ok) return null;
  const { address } = (await res.json()) as { address: string | null };
  return address ? { label: address, address, lat, lon } : null;
}
```

- [ ] **Step 4: Replace `MapSearch.tsx`**

```tsx
"use client";

import { useEffect, useId, useState } from "react";
import { shareLocation } from "@/lib/geolocation";
import { useFridayStore } from "@/lib/store";
import { resolvePlace, suggestPlaces, type Place, type Suggestion } from "./mapApi";

const MY_LOCATION_LABEL = "Vị trí của bạn";
/** Suggest is 10K/month: wait for a real word and a pause before asking. */
const MIN_CHARS = 3;
const DEBOUNCE_MS = 400;

type Option = { kind: "me"; place: Place | null } | { kind: "hit"; s: Suggestion };

/** Google-Maps-style search box: debounced TomTom suggestions (via the orchestrator) as an ARIA combobox. */
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
  const [results, setResults] = useState<Suggestion[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const location = useFridayStore((s) => s.location);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setText(value ?? ""), [value]);

  useEffect(() => {
    const q = text.trim();
    if (!open || q.length < MIN_CHARS) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setNotice(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      suggestPlaces(q, getNear(), ctrl.signal)
        .then((r) => {
          if (r.ok) {
            setResults(r.suggestions);
            setNotice(null);
          } else {
            setResults([]);
            setNotice(r.reason === "quota" ? "Tìm kiếm tạm hết hạn mức" : "Tìm kiếm chưa được cấu hình");
          }
          setActive(-1);
        })
        .catch(() => {}); // aborted or offline: keep the last list
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // getNear is read at search time on purpose; it is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open]);

  const me: Place | null = location ? { label: MY_LOCATION_LABEL, address: "", lat: location.lat, lon: location.lon } : null;
  const options: Option[] = [
    ...(offerMyLocation ? [{ kind: "me", place: me } as const] : []),
    ...results.map((s) => ({ kind: "hit", s }) as const),
  ];

  const pick = (o: Option) => {
    setOpen(false);
    if (o.kind === "me") {
      if (!o.place) {
        shareLocation(); // user gesture; re-pick once the fix lands
        return;
      }
      setText(o.place.label);
      onPick(o.place);
      return;
    }
    setText(o.s.title);
    resolvePlace(o.s)
      .then((p) => (p ? onPick(p) : setNotice("Không lấy được vị trí địa điểm này")))
      .catch(() => setNotice("Không lấy được vị trí địa điểm này"));
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
      const o = options[active] ?? options[0];
      if (o) {
        e.preventDefault();
        pick(o);
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
          {options.map((o, i) => {
            const title = o.kind === "me" ? (o.place ? MY_LOCATION_LABEL : `${MY_LOCATION_LABEL} (bật chia sẻ vị trí)`) : o.s.title;
            const subtitle = o.kind === "hit" ? o.s.subtitle : "";
            return (
              <li
                key={o.kind === "me" ? "me" : o.s.ref}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`cursor-pointer px-4 py-2 text-sm ${i === active ? "bg-cyan-400/15" : "hover:bg-cyan-400/10"}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
              >
                <div className="text-cyan-50">{title}</div>
                {subtitle && <div className="truncate text-xs text-slate-400">{subtitle}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {open && notice && (
        <p role="status" className="friday-map-panel absolute left-0 right-0 top-full mt-1 px-4 py-2 text-xs text-amber-200">
          {notice}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run lint && npm run typecheck` → clean.
Run: `npx playwright test --project=ui tests/ui/map.spec.ts -g "search|quota|right-click"` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/friday/map/mapApi.ts src/components/friday/map/MapSearch.tsx tests/ui/map.spec.ts
git commit -m "feat(map): search and place card through the orchestrator's TomTom proxy"
```

---

### Task 6: Directions — motorbike default, traffic delay, quota

**Files:**
- Modify: `src/components/friday/map/mapApi.ts` (routing part), `src/components/friday/map/DirectionsPanel.tsx`, `src/components/friday/map/MapLayer.tsx` (profile default constant)
- Test: `tests/unit/mapApi.spec.ts`, `tests/ui/map.spec.ts` (route tests), `tests/ui/stubOrchestrator.ts`

**Interfaces:**
- Produces (`mapApi.ts`): `Maneuver.maneuver: string` (replaces `sign`), `Route.traffic_delay_s: number`, `RouteResult` reason adds `"quota"`, `DEFAULT_PROFILES: MapProfile[]` (replaces `FREE_PLAN_PROFILES`).

- [ ] **Step 1: Update the tests**

- `tests/unit/mapApi.spec.ts`: in the `route` fixture replace each `sign: N` with a `maneuver` code (`"DEPART"`, `"TURN_RIGHT"`, `"ARRIVE"`) and add `traffic_delay_s: 0`.
- `tests/ui/stubOrchestrator.ts`: `MAP_ROUTE_SPEC` profile → `"motor_scooter"`; its doc comment → `/** get_directions as the backend streams it (TomTom, default mode = motorbike): the map preview is also the final spec. */`; answer text → `"Khoảng 2,4 km, chừng 9 phút đi xe máy, chậm 6 phút do kẹt xe."`.
- `tests/ui/map.spec.ts`, `ROUTE` fixture: replace every `sign: N` with the matching code (`"DEPART"`, `"TURN_RIGHT"`, `"ARRIVE"`) and add `traffic_delay_s: 360` to the first route and `traffic_delay_s: 0` to the second. In the route test:
  - profiles stub → `{ profiles: ["motor_scooter", "auto", "bicycle", "pedestrian"] }`;
  - replace the two free-plan tab assertions with:

```ts
    await expect(panel.getByRole("tab", { name: "🛵 Xe máy" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("directions-summary")).toContainText("chậm 6 phút do kẹt xe");
```

  - add a quota test:

```ts
test("an exhausted routing quota says so", async ({ page }) => {
  await stubTomTom(page);
  await page.route("**/geo/route", (r) => r.fulfill({ status: 429, json: { error: "quota_exceeded" } }));
  const stub = await startStubOrchestrator(MAP_FLOW);
  try {
    await gotoLitScene(page);
    await page.locator("input").click();
    await page.locator("input").pressSequentially("chỉ đường tới lăng bác", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("directions-status")).toHaveText("Chỉ đường tạm hết hạn mức", { timeout: 20_000 });
  } finally {
    await stub.close();
  }
});
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts` → FAIL (type: `sign` expected). The UI route tests fail on the missing delay text.

- [ ] **Step 3: `mapApi.ts` routing part**

- `FREE_PLAN_PROFILES` → rename to `DEFAULT_PROFILES` with value `["motor_scooter", "auto", "bicycle", "pedestrian"]` and comment `/** All four modes are on TomTom's free plan — the tabs if /geo/profiles cannot be read. */`; update its two uses inside `fetchProfiles`.
- In `Maneuver` replace the `sign` field and its comment with:

```ts
  /** TomTom maneuver code (e.g. "TURN_RIGHT"); kept for a future turn icon. */
  maneuver: string;
```

- In `Route` add after `duration_s`: `  /** Extra time from current traffic (TomTom). */\n  traffic_delay_s: number;`
- `RouteResult` reason union → `"unavailable" | "no_route" | "unsupported" | "quota" | "error"`.
- In `fetchRoute`, after the `503` line add `if (res.status === 429) return { ok: false, reason: "quota" };`.

- [ ] **Step 4: `DirectionsPanel.tsx` and `MapLayer.tsx`**

- `Status` adds `"quota"`; `STATUS_TEXT` adds `quota: "Chỉ đường tạm hết hạn mức",`.
- In the summary block, after the distance `<span>`:

```tsx
            {best.traffic_delay_s >= 60 && (
              <span className="text-sm text-amber-200">chậm {formatDuration(best.traffic_delay_s)} do kẹt xe</span>
            )}
```

- `MapLayer.tsx`: `FREE_PLAN_PROFILES` → `DEFAULT_PROFILES` in the import and the `useState` initializer; update the comment above it to `// Modes the routing plan allows, default first (all four on TomTom).`

- [ ] **Step 5: Run the tests**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts` → PASS.
Run: `npm run lint && npm run typecheck` → clean; `git grep -n -i "maptiler\|graphhopper\|FREE_PLAN" -- src tests` prints nothing.
Run: `npx playwright test --project=ui tests/ui/map.spec.ts` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/friday/map tests/unit/mapApi.spec.ts tests/ui/map.spec.ts tests/ui/stubOrchestrator.ts
git commit -m "feat(map): motorbike-first directions with traffic delay and quota message"
```

---

### Task 7: Live check, docs, deploy config, full verification

**Files:**
- Modify: `README.md` (Street map & directions), `backend/README.md` (tool table, env table + paragraphs), `docs/ARCHITECTURE.md` (map spec bullet), `backend/render.yaml` (env vars), `docs/superpowers/plans/2026-09-22-graphhopper-routing.md` (superseded note)

- [ ] **Step 1: Live probe** — if Task 0 was skipped, run it now and fix any shape it reveals (constants, `_suggestion`, `Attributes`, satellite option), re-running `python backend/runtests.py` and the map UI tests after each fix.

- [ ] **Step 2: Manual check in the browser preview**

With both keys set, run the backend and the dev server (browser preview via `.claude/launch.json`). Check: the dark TomTom style loads and labels in Vietnam are Vietnamese; Sáng / Vệ tinh switch; Giao thông overlays flow colors; 3D toggle appears only if the style has extrusions; search suggests after 3 characters and a pick lands on the right place; "Đây là đâu?" shows an address; "chỉ đường từ Hồ Gươm tới Lăng Bác" draws a motorbike route with grey alternatives, Vietnamese steps ("Rẽ phải vào …"), and a traffic delay when there is one; dragging B reroutes; repeating the same search/route sends no new backend-to-TomTom request (backend log). Screenshot for the PR.

- [ ] **Step 3: Docs and deploy config**

- `README.md` "Street map & directions": replace the provider sentences with: "The map is TomTom (`NEXT_PUBLIC_TOMTOM_MAP_KEY`, Map Display only). Search, place details, reverse geocoding and directions go through the backend with `TOMTOM_API_KEY`, which never reaches the browser. TomTom's free plan covers all four travel modes (motorbike by default) and live traffic; allowances are per API per month, and fuzzy search — used by the agent's `find_place` — is only 2.5K/month."
- `backend/README.md`: tool table rows → `find_place` "TomTom fuzzy search (`TOMTOM_API_KEY`), pins a map preview"; `get_directions` "TomTom routing with traffic (`TOMTOM_API_KEY`), Vietnamese steps, pins a route preview". Env table: replace the `GRAPHHOPPER_*` and `MAPTILER_SERVER_KEY` rows with one `TOMTOM_API_KEY` row ("Server key for `/geo/suggest`, `/geo/place`, `/geo/reverse`, `POST /geo/route` and the geo tools; enable Search, Places, Reverse Geocoding and Routing; never sent to the browser. Unset: map works, search/directions report unconfigured."). Replace the paragraphs under the table with a short "Free allowances" list copied from spec §6.1 and one sentence: "Every call is cached (LRU per function), autocomplete waits for 3 characters and a 400 ms pause, and a 429 surfaces in the UI as a quota message."
- `docs/ARCHITECTURE.md`: in the `map` spec bullet, "proxies to GraphHopper Cloud (`GET /geo/profiles` tells the UI which modes the plan allows). Directions need `GRAPHHOPPER_API_KEY`;" → "proxies to TomTom (search, places and reverse geocoding go through `/geo/suggest`, `/geo/place`, `/geo/reverse` the same way; Vietnamese turn text is built in `geo/maneuvers.py`). Search and directions need `TOMTOM_API_KEY`;".
- `backend/render.yaml`: replace the `GRAPHHOPPER_API_KEY` and `MAPTILER_SERVER_KEY` entries with one `- key: TOMTOM_API_KEY` / `sync: false` (keep the comment line).
- `docs/superpowers/plans/2026-09-22-graphhopper-routing.md`: add under the title `> **Status:** implemented (9504cb6…256f01e), then superseded by \`2026-09-22-tomtom-maps.md\`.`

- [ ] **Step 4: Nothing points at the old providers**

Run: `git grep -n -i "maptiler\|graphhopper\|valhalla" -- . ":!docs/superpowers"`
Expected: no output.

- [ ] **Step 5: Full verification**

Run: `npm run verify`
Expected: lint, typecheck, unit, backend, contracts and UI suites all PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md backend/README.md docs/ARCHITECTURE.md backend/render.yaml docs/superpowers/plans/2026-09-22-graphhopper-routing.md
git commit -m "docs(map): TomTom setup, free allowances and key scoping"
```
