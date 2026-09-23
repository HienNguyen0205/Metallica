# Open-Meteo Weather Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `get_weather` agent tool and rain-along-the-route for both `get_directions` and the map, from Open-Meteo.

**Architecture:** A new `backend/friday/weather/` package: `openmeteo.py` (keyless HTTP client, cached), `codes.py` (WMO → Vietnamese), `tools.py` (`get_weather` + preview), `route_weather.py` (`attach_weather(routes)` samples each route by travel time and marks rainy stretches). `POST /geo/route` and `get_directions` both call `attach_weather`, so the map and the agent read one computation. The map draws `route.weather.sections` like it draws `traffic_sections`.

**Tech Stack:** Python 3.12 (FastAPI, stdlib `urllib`, no new deps), Next.js 16 + MapLibre, Playwright tests (`--project=unit` / `--project=ui`), backend tests via `python backend/runtests.py <filter>` (plain asserts, no pytest).

**Spec:** `docs/superpowers/specs/2026-09-23-open-meteo-weather-design.md`

## Global Constraints

- No new dependencies, backend or frontend.
- Open-Meteo: `https://api.open-meteo.com/v1/forecast`; with `OPEN_METEO_API_KEY` → `https://customer-api.open-meteo.com/v1/forecast` + `apikey=`; test hook `FRIDAY_OPEN_METEO_URL` (root URL; `/v1/forecast` is appended).
- Points rounded to 2 decimals before leaving; cache TTL 15 minutes; timeout 4 s; every failure → `WeatherUnavailable`.
- Route sampling: every 10 min of travel, start and end always, at most 12 samples per route.
- Classification, first match wins: `thunderstorm` code 95–99; `heavy_rain` ≥ 4 mm/h; `rain` ≥ 0.3 mm/h or probability ≥ 60.
- Weather never fails a route: failure → `weather.status = "unavailable"`.
- `attach_weather` never mutates its input (TomTom's route cache holds those dicts).
- Anything calling another module's function that tests swap does so through the module (`openmeteo.forecast`, `route_weather.attach_weather`, `tomtom.search`) — the existing pattern.
- UI credits "Thời tiết: Open-Meteo" wherever weather shows (CC BY 4.0).
- Commit messages: conventional (`feat(weather): …`), no trailer lines.
- Done when `npm run verify` is green.

---

### Task 1: Open-Meteo client and weather codes

**Files:**
- Create: `backend/friday/weather/__init__.py`
- Create: `backend/friday/weather/codes.py`
- Create: `backend/friday/weather/openmeteo.py`
- Create: `backend/tests/unit/test_openmeteo.py`
- Modify: `backend/.env.example` (after the `TOMTOM_API_KEY` block, ~line 118)
- Modify: `backend/README.md` (env table, after the `TOMTOM_API_KEY` row, ~line 412)

**Interfaces:**
- Consumes: `friday.geo.tomtom._Lru` (LRU with `get(key)` / `put(key, value, ttl)`, expiry via `tomtom._now`).
- Produces:
  - `openmeteo.forecast(points: list[tuple[float, float]], *, current=(), hourly=(), daily=(), forecast_days: int = 1) -> list[dict]` — one Open-Meteo location object per input point, same order.
  - `openmeteo.WeatherUnavailable(Exception)`, `openmeteo.TIMEOUT_S = 4.0`, `openmeteo.TTL_S = 900`, `openmeteo.MAX_DAYS = 16`, `openmeteo.BASE`, `openmeteo.CUSTOMER`, `openmeteo.clear_cache()`, `openmeteo._endpoint() -> tuple[str, dict[str, str]]`.
  - `codes.describe(code) -> str`.

- [ ] **Step 1: Write the failing test**

`backend/tests/unit/test_openmeteo.py`:

```python
"""Open-Meteo client against a local fake — query shape, fan-out, cache,
errors — plus the weather-code table. No external network.

    PYTHONPATH=. python tests/unit/test_openmeteo.py
"""

import asyncio
import json
import os
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from friday.geo import tomtom
from friday.weather import openmeteo as om
from friday.weather.codes import describe

CALLS: list[dict] = []
STATUS = {"code": 200}
ENV = ("FRIDAY_OPEN_METEO_URL", "OPEN_METEO_API_KEY")


def location(lat, lon):
    return {"latitude": lat, "longitude": lon, "utc_offset_seconds": 25200,
            "hourly": {"time": ["2026-09-23T07:00"], "precipitation": [0.0]}}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        CALLS.append({"path": url.path, "query": query})
        if STATUS["code"] != 200:
            body = {"error": True, "reason": "Latitude must be in range of -90 to 90°."}
        else:
            lats = [float(x) for x in query["latitude"][0].split(",")]
            lons = [float(x) for x in query["longitude"][0].split(",")]
            located = [location(a, b) for a, b in zip(lats, lons)]
            body = located if len(located) > 1 else located[0]
        data = json.dumps(body).encode()
        self.send_response(STATUS["code"])
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _set_env(values):
    for k, v in values.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def with_server(fn):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    old = {k: os.environ.get(k) for k in ENV}
    _set_env({"FRIDAY_OPEN_METEO_URL": f"http://127.0.0.1:{server.server_address[1]}", "OPEN_METEO_API_KEY": None})
    CALLS.clear()
    STATUS["code"] = 200
    om.clear_cache()
    try:
        fn()
    finally:
        server.shutdown()
        server.server_close()
        _set_env(old)


def raises(coro) -> str:
    try:
        asyncio.run(coro)
    except om.WeatherUnavailable as err:
        return str(err)
    raise AssertionError("expected WeatherUnavailable")


def test_many_points_one_request_rounded_and_fanned_out() -> None:
    def run():
        out = asyncio.run(om.forecast([(21.02881, 105.85249), (21.0368, 105.8346), (21.028812, 105.852499)],
                                      hourly=["precipitation"], forecast_days=2))
        assert len(CALLS) == 1, CALLS
        q = CALLS[0]["query"]
        assert CALLS[0]["path"] == "/v1/forecast"
        assert q["latitude"] == ["21.03,21.04"] and q["longitude"] == ["105.85,105.83"], q
        assert q["hourly"] == ["precipitation"] and q["forecast_days"] == ["2"]
        assert q["timezone"] == ["auto"] and q["wind_speed_unit"] == ["kmh"]
        assert "current" not in q and "daily" not in q and "apikey" not in q
        assert [(o["latitude"], o["longitude"]) for o in out] == [(21.03, 105.85), (21.04, 105.83), (21.03, 105.85)]

    with_server(run)


def test_one_point_is_wrapped_in_a_list_and_no_points_ask_nothing() -> None:
    def run():
        out = asyncio.run(om.forecast([(21.0, 105.8)], current=["temperature_2m"]))
        assert isinstance(out, list) and out[0]["latitude"] == 21.0
        assert CALLS[0]["query"]["current"] == ["temperature_2m"]
        assert asyncio.run(om.forecast([])) == [] and len(CALLS) == 1

    with_server(run)


def test_answers_are_cached_for_15_minutes() -> None:
    clock = [1000.0]
    orig = tomtom._now
    tomtom._now = lambda: clock[0]

    def run():
        asyncio.run(om.forecast([(21.0, 105.8)], hourly=["precipitation"]))
        asyncio.run(om.forecast([(21.001, 105.801)], hourly=["precipitation"]))  # same ~1 km cell
        assert len(CALLS) == 1
        clock[0] += om.TTL_S
        asyncio.run(om.forecast([(21.0, 105.8)], hourly=["precipitation"]))
        assert len(CALLS) == 2

    try:
        with_server(run)
    finally:
        tomtom._now = orig


def test_failures_raise_weather_unavailable() -> None:
    def run():
        STATUS["code"] = 400
        message = raises(om.forecast([(21.0, 105.8)], hourly=["precipitation"]))
        assert "400" in message and "Latitude" in message, message
        STATUS["code"] = 429
        assert "429" in raises(om.forecast([(21.0, 105.8)], hourly=["precipitation"]))

    with_server(run)
    old = {k: os.environ.get(k) for k in ENV}
    _set_env({"FRIDAY_OPEN_METEO_URL": "http://127.0.0.1:9", "OPEN_METEO_API_KEY": None})  # nothing listens
    om.clear_cache()
    try:
        raises(om.forecast([(21.0, 105.8)], hourly=["precipitation"]))
    finally:
        _set_env(old)


def test_api_key_switches_to_the_customer_endpoint() -> None:
    old = {k: os.environ.get(k) for k in ENV}
    _set_env({"FRIDAY_OPEN_METEO_URL": None, "OPEN_METEO_API_KEY": None})
    try:
        assert om._endpoint() == (om.BASE, {})
        os.environ["OPEN_METEO_API_KEY"] = "k"
        assert om._endpoint() == (om.CUSTOMER, {"apikey": "k"})
    finally:
        _set_env(old)


def test_weather_codes_read_in_vietnamese() -> None:
    assert describe(0) == "trời quang"
    assert describe(2) == "nhiều mây"
    assert describe(63) == "mưa vừa"
    assert describe(81) == "mưa rào"
    assert describe(95) == "dông"
    assert describe(99) == "dông kèm mưa đá"
    assert describe(12) == "không rõ" and describe(None) == "không rõ"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python backend/runtests.py test_openmeteo`
Expected: FAIL with `ModuleNotFoundError: No module named 'friday.weather'`

- [ ] **Step 3: Write minimal implementation**

`backend/friday/weather/__init__.py`: empty file.

`backend/friday/weather/codes.py`:

```python
"""WMO weather interpretation codes (Open-Meteo `weather_code`) → Vietnamese."""

from typing import Any

_TEXT = {
    0: "trời quang", 1: "ít mây", 2: "nhiều mây", 3: "u ám",
    45: "sương mù", 48: "sương mù",
    51: "mưa phùn", 53: "mưa phùn", 55: "mưa phùn", 56: "mưa phùn", 57: "mưa phùn",
    61: "mưa nhẹ", 63: "mưa vừa", 65: "mưa to", 66: "mưa lạnh", 67: "mưa lạnh",
    71: "tuyết", 73: "tuyết", 75: "tuyết", 77: "tuyết", 85: "tuyết", 86: "tuyết",
    80: "mưa rào nhẹ", 81: "mưa rào", 82: "mưa rào lớn",
    95: "dông", 96: "dông kèm mưa đá", 99: "dông kèm mưa đá",
}


def describe(code: Any) -> str:
    try:
        return _TEXT.get(int(code), "không rõ")
    except (TypeError, ValueError):
        return "không rõ"
```

`backend/friday/weather/openmeteo.py`:

```python
"""Open-Meteo forecast client (spec 2026-09-23 open-meteo §3) — no key needed.

Same urllib + to_thread shape as geo/tomtom.py; no HTTP dependency. Points
are rounded to ~1 km before they leave (privacy, and the cache key) and one
request carries every point. The free endpoint is non-commercial;
OPEN_METEO_API_KEY switches to the customer endpoint.
"""

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from typing import Any

from friday.geo.tomtom import _Lru

BASE = "https://api.open-meteo.com/v1/forecast"
CUSTOMER = "https://customer-api.open-meteo.com/v1/forecast"
TIMEOUT_S = 4.0
#: Models update hourly at best.
TTL_S = 15 * 60
MAX_DAYS = 16

#: Expiry runs on tomtom._now (the shared LRU's clock); tests swap that.
_CACHE = _Lru(256)


class WeatherUnavailable(Exception):
    """Open-Meteo failing, unreachable, rate-limited or answering nonsense."""


def clear_cache() -> None:
    _CACHE.data.clear()


def _endpoint() -> tuple[str, dict[str, str]]:
    key = os.getenv("OPEN_METEO_API_KEY")
    # Test hook, like FRIDAY_TOMTOM_URL: point at a local fake.
    override = os.getenv("FRIDAY_OPEN_METEO_URL")
    url = f"{override.rstrip('/')}/v1/forecast" if override else (CUSTOMER if key else BASE)
    return url, ({"apikey": key} if key else {})


def _get(url: str) -> Any:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        try:
            reason = str(json.loads(err.read()).get("reason") or "")
        except (ValueError, OSError, AttributeError):
            reason = ""
        raise WeatherUnavailable(f"open-meteo HTTP {err.code}: {reason}".rstrip(": ")) from err
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        raise WeatherUnavailable(str(err)) from err


async def forecast(
    points: Sequence[tuple[float, float]],
    *,
    current: Sequence[str] = (),
    hourly: Sequence[str] = (),
    daily: Sequence[str] = (),
    forecast_days: int = 1,
) -> list[dict[str, Any]]:
    """One Open-Meteo location object per point, in order."""
    if not points:
        return []
    rounded = [(round(lat, 2), round(lon, 2)) for lat, lon in points]
    unique = list(dict.fromkeys(rounded))
    params = {
        "latitude": ",".join(str(lat) for lat, _ in unique),
        "longitude": ",".join(str(lon) for _, lon in unique),
        "timezone": "auto",
        "wind_speed_unit": "kmh",
        "forecast_days": str(max(1, min(MAX_DAYS, forecast_days))),
    }
    for name, fields in (("current", current), ("hourly", hourly), ("daily", daily)):
        if fields:
            params[name] = ",".join(fields)
    cache_key = json.dumps([unique, list(current), list(hourly), list(daily), params["forecast_days"]])
    located = _CACHE.get(cache_key)
    if located is None:
        url, extra = _endpoint()
        raw = await asyncio.to_thread(_get, f"{url}?{urllib.parse.urlencode({**params, **extra})}")
        located = raw if isinstance(raw, list) else [raw]
        if len(located) != len(unique) or not all(isinstance(loc, dict) for loc in located):
            raise WeatherUnavailable("unexpected response shape")
        _CACHE.put(cache_key, located, TTL_S)
    by_point = dict(zip(unique, located))
    return [by_point[p] for p in rounded]
```

`backend/.env.example` — append after the `# TOMTOM_API_KEY=` line:

```
# Weather (spec 2026-09-23 open-meteo) — Open-Meteo, https://open-meteo.com
# No key needed: the free endpoint is non-commercial only (~10K calls/day).
# A commercial deployment sets its customer key here. Data is CC BY 4.0; the
# UI credits "Open-Meteo" wherever weather shows.
# OPEN_METEO_API_KEY=
```

`backend/README.md` — env table row after `TOMTOM_API_KEY`:

```
| `OPEN_METEO_API_KEY` | unset | Open-Meteo customer key, for commercial use. Unset: the free non-commercial endpoint (~10K calls/day), no key. Powers `get_weather` and rain along routes. |
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python backend/runtests.py test_openmeteo`
Expected: PASS (`all checks passed`)

- [ ] **Step 5: Commit**

```bash
git add backend/friday/weather backend/tests/unit/test_openmeteo.py backend/.env.example backend/README.md
git commit -m "feat(weather): Open-Meteo forecast client and WMO codes in Vietnamese"
```

---

### Task 2: `get_weather` tool

**Files:**
- Create: `backend/friday/weather/tools.py`
- Create: `backend/tests/unit/test_weather_tool.py`
- Modify: `backend/friday/tools/registry.py` (imports ~line 10–15; new `Tool` after `get_directions` ~line 160; `search_web` description ~line 197–204)
- Modify: `backend/friday/agent/agent.py:34`
- Modify: `backend/evals/cases.py` (append one case to `CASES`)
- Modify: `backend/README.md` (tool table, after the `get_directions` row ~line 327)

**Interfaces:**
- Consumes: `openmeteo.forecast`, `openmeteo.WeatherUnavailable` (Task 1); `codes.describe` (Task 1); from `friday.geo.tools`: `MY_LOCATION = "my_location"`, `NO_LOCATION`, `QUOTA`, `_first(query, near) -> dict | None`, `_is_me(ref) -> bool`, `_operator() -> tuple[float, float] | None`; `tomtom.QuotaExceeded`, `tomtom.TomTomUnavailable`.
- Produces: `weather.tools.run_get_weather(payload) -> dict`, `weather.tools.preview_get_weather(output) -> dict`, `weather.tools.SPANS`, `weather.tools._utcnow()`; registry tool `get_weather`.

- [ ] **Step 1: Write the failing test**

`backend/tests/unit/test_weather_tool.py`:

```python
"""get_weather with a fake TomTom search and a fake Open-Meteo.

    PYTHONPATH=. python tests/unit/test_weather_tool.py
"""

import asyncio
from datetime import datetime, timezone

from friday.api.schemas import ClientContext
from friday.geo import tomtom
from friday.geo import tools as geo_tools
from friday.schemas.visualization import VisualizationPlan
from friday.tools import registry
from friday.tools.client import metrics as cm
from friday.weather import openmeteo, tools

HN = {"label": "Hà Nội", "address": "Hà Nội", "category": "geography", "lat": 21.0285, "lon": 105.8542}
HOURS = [f"2026-09-23T{h:02d}:00" for h in range(24)] + [f"2026-09-24T{h:02d}:00" for h in range(24)]
PROBS: list = list(range(48))
PROBS[20] = None  # Open-Meteo sends null where a model has no value
LOC = {
    "utc_offset_seconds": 25200,
    "current": {"time": "2026-09-23T14:15", "temperature_2m": 33.1, "apparent_temperature": 38.0,
                "relative_humidity_2m": 62, "wind_speed_10m": 11.2, "uv_index": 7.4,
                "precipitation": 0.0, "weather_code": 2},
    "hourly": {"time": HOURS, "temperature_2m": [25.0 + (i % 24) * 0.5 for i in range(48)],
               "precipitation_probability": PROBS, "precipitation": [0.0] * 48, "weather_code": [61] * 48},
    "daily": {"time": [f"2026-09-{23 + i}" for i in range(7)], "temperature_2m_max": [34.0] * 7,
              "temperature_2m_min": [26.1] * 7, "precipitation_probability_max": [70] * 7,
              "precipitation_sum": [12.4] * 7, "weather_code": [81] * 7},
}
ORIG = (tomtom.search, openmeteo.forecast, tools._utcnow)


def run(coro, location=None):
    async def go():
        cm.CLIENT.set(ClientContext(location=location).model_dump(exclude_none=True) if location else {})
        return await coro

    return asyncio.run(go())


def fake(hits=None, exc=None, search_exc=None):
    seen = {"search": [], "forecast": []}

    async def search(query, near=None, limit=5):
        seen["search"].append((query, near))
        if search_exc:
            raise search_exc
        return (hits or {}).get(query, [])[:limit]

    async def forecast(points, **kwargs):
        seen["forecast"].append((points, kwargs))
        if exc:
            raise exc
        return [LOC for _ in points]

    tomtom.search, openmeteo.forecast = search, forecast
    tools._utcnow = lambda: datetime(2026, 9, 23, 7, 20, tzinfo=timezone.utc)  # 14:20 in Hà Nội
    return seen


def restore():
    tomtom.search, openmeteo.forecast, tools._utcnow = ORIG


def test_now_at_my_location_reads_current_conditions_as_gauges() -> None:
    seen = fake()
    try:
        out = run(tools.run_get_weather({}), location={"lat": 21.0285, "lon": 105.8542})
    finally:
        restore()
    assert seen["search"] == [], "my_location needs no geocoding"
    assert seen["forecast"] == [([(21.0285, 105.8542)], {"current": tools.CURRENT})]
    assert out["place"] == {"label": "Vị trí của bạn", "lat": 21.0285, "lon": 105.8542}
    assert out["current"] == {"time": "14:15", "temp_c": 33.1, "feels_like_c": 38.0, "humidity": 62,
                              "wind_kmh": 11.2, "uv": 7.4, "precip_mm": 0.0, "weather": "nhiều mây"}
    assert "hourly" not in out and "daily" not in out
    spec = tools.preview_get_weather(out)
    assert spec["type"] == "radial_gauge" and spec["title"] == "VỊ TRÍ CỦA BẠN · BÂY GIỜ"
    assert [(m["label"], m["value"]) for m in spec["data"]["metrics"]] == [
        ("Nhiệt độ", 33.1), ("Độ ẩm", 62.0), ("Gió", 11.2), ("UV", 7.4)]
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_today_is_the_next_24_hours_as_a_line() -> None:
    seen = fake({"hà nội": [HN]})
    try:
        out = run(tools.run_get_weather({"place": "hà nội", "span": "today"}))
    finally:
        restore()
    assert seen["forecast"] == [([(21.0285, 105.8542)], {"hourly": tools.HOURLY, "forecast_days": 2})]
    assert out["place"]["label"] == "Hà Nội"
    rows = out["hourly"]
    assert len(rows) == 24 and rows[0]["time"] == "14:00" and rows[-1]["time"] == "13:00"
    assert rows[0] == {"time": "14:00", "temp_c": 32.0, "rain_prob": 14, "precip_mm": 0.0, "weather": "mưa nhẹ"}
    spec = tools.preview_get_weather(out)
    assert spec["type"] == "line_3d" and spec["title"] == "HÀ NỘI · 24 GIỜ"
    assert [s["label"] for s in spec["data"]["series"]] == ["NHIỆT ĐỘ", "% MƯA"]
    assert spec["data"]["series"][1]["points"][6] == 0.0, "null probability plots as 0"
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_week_is_seven_days_as_bars() -> None:
    seen = fake({"hà nội": [HN]})
    try:
        out = run(tools.run_get_weather({"place": "hà nội", "span": "week"}))
    finally:
        restore()
    assert seen["forecast"][0][1] == {"daily": tools.DAILY, "forecast_days": 7}
    assert len(out["daily"]) == 7
    assert out["daily"][0] == {"date": "2026-09-23", "max_c": 34.0, "min_c": 26.1, "rain_prob": 70,
                               "precip_mm": 12.4, "weather": "mưa rào"}
    spec = tools.preview_get_weather(out)
    assert spec["type"] == "bar_3d" and spec["title"] == "HÀ NỘI · 7 NGÀY"
    assert [(s["label"], len(s["points"])) for s in spec["data"]["series"]] == [("CAO", 7), ("THẤP", 7), ("% MƯA", 7)]
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_long_place_names_keep_the_span_in_the_title() -> None:
    spec = tools.preview_get_weather({"place": {"label": "Thành phố Hồ Chí Minh, Quận Bình Thạnh, Phường 25"},
                                      "span": "now", "current": {"temp_c": 1, "humidity": 1, "wind_kmh": 1, "uv": 1}})
    assert len(spec["title"]) <= 40 and spec["title"].endswith(" · BÂY GIỜ"), spec["title"]


def test_errors_are_error_dicts() -> None:
    try:
        fake()
        assert run(tools.run_get_weather({"span": "now"})) == geo_tools.NO_LOCATION
        assert "no place matches" in run(tools.run_get_weather({"place": "atlantis"}))["error"]
        assert "span" in run(tools.run_get_weather({"place": "hà nội", "span": "month"}))["error"]
        fake({"hà nội": [HN]}, exc=openmeteo.WeatherUnavailable("down"))
        assert run(tools.run_get_weather({"place": "hà nội"})) == {"error": "weather service unavailable: down"}
        fake(search_exc=tomtom.QuotaExceeded())
        assert run(tools.run_get_weather({"place": "hà nội"})) == geo_tools.QUOTA
    finally:
        restore()


def test_registered_and_search_web_no_longer_claims_weather() -> None:
    tool = registry.get("get_weather")
    assert tool is not None and tool.risk == "low" and tool.capabilities == ("geo.read",)
    assert tool.preview is not None
    assert tool.input_schema["properties"]["span"]["enum"] == ["now", "today", "week"]
    assert "weather" not in registry.get("search_web").description.lower()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

(Temperatures: hour 14 → `25.0 + 14 * 0.5 = 32.0`; probability at hour 14 is `14`; `PROBS[20]` is the 7th row, index 6.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python backend/runtests.py test_weather_tool`
Expected: FAIL with `ImportError: cannot import name 'tools' from 'friday.weather'`

- [ ] **Step 3: Write minimal implementation**

`backend/friday/weather/tools.py`:

```python
"""get_weather (spec 2026-09-23 open-meteo §4) — read-only, low risk.

Places resolve the way get_directions resolves them (geo/tools.py); the
preview picks the viz from the span: now → gauges, today → 24 h line,
week → 7-day bars.
"""

import bisect
from datetime import datetime, timedelta, timezone
from typing import Any

from friday.geo import tomtom
from friday.geo.tools import MY_LOCATION, NO_LOCATION, QUOTA, _first, _is_me, _operator

from . import openmeteo
from .codes import describe

SPANS = ("now", "today", "week")
CURRENT = ["temperature_2m", "apparent_temperature", "relative_humidity_2m", "wind_speed_10m",
           "uv_index", "precipitation", "weather_code"]
HOURLY = ["temperature_2m", "precipitation_probability", "precipitation", "weather_code"]
DAILY = ["temperature_2m_max", "temperature_2m_min", "precipitation_probability_max",
         "precipitation_sum", "weather_code"]
MAX_TITLE = 40
SUFFIX = {"now": "BÂY GIỜ", "today": "24 GIỜ", "week": "7 NGÀY"}


def _utcnow() -> datetime:
    """Wall clock; tests swap it."""
    return datetime.now(timezone.utc)


async def _place(ref: str) -> dict[str, Any]:
    if _is_me(ref):
        me = _operator()
        if me is None:
            return NO_LOCATION
        return {"label": "Vị trí của bạn", "lat": me[0], "lon": me[1]}
    try:
        hit = await _first(ref, _operator())
    except tomtom.QuotaExceeded:
        return QUOTA
    except tomtom.TomTomUnavailable as err:
        return {"error": f"place search unavailable: {err}"}
    if hit is None:
        return {"error": f"no place matches '{ref}'"}
    return {"label": hit["label"], "lat": hit["lat"], "lon": hit["lon"]}


def _current(c: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": c["time"][11:16],
        "temp_c": c["temperature_2m"],
        "feels_like_c": c["apparent_temperature"],
        "humidity": c["relative_humidity_2m"],
        "wind_kmh": c["wind_speed_10m"],
        "uv": c["uv_index"],
        "precip_mm": c["precipitation"],
        "weather": describe(c["weather_code"]),
    }


def _hourly(loc: dict[str, Any]) -> list[dict[str, Any]]:
    """The next 24 hours, starting at the current local hour."""
    h = loc["hourly"]
    local_now = _utcnow() + timedelta(seconds=loc.get("utc_offset_seconds", 0))
    # Times are local "YYYY-MM-DDTHH:MM", so string order is time order.
    start = max(0, bisect.bisect_right(h["time"], local_now.strftime("%Y-%m-%dT%H:%M")) - 1)
    return [
        {
            "time": h["time"][i][11:16],
            "temp_c": h["temperature_2m"][i],
            "rain_prob": h["precipitation_probability"][i],
            "precip_mm": h["precipitation"][i],
            "weather": describe(h["weather_code"][i]),
        }
        for i in range(start, min(start + 24, len(h["time"])))
    ]


def _daily(loc: dict[str, Any]) -> list[dict[str, Any]]:
    d = loc["daily"]
    return [
        {
            "date": d["time"][i],
            "max_c": d["temperature_2m_max"][i],
            "min_c": d["temperature_2m_min"][i],
            "rain_prob": d["precipitation_probability_max"][i],
            "precip_mm": d["precipitation_sum"][i],
            "weather": describe(d["weather_code"][i]),
        }
        for i in range(len(d["time"]))
    ]


async def run_get_weather(payload: dict[str, Any]) -> dict[str, Any]:
    span = payload.get("span") or "now"
    if span not in SPANS:
        return {"error": f"unknown span '{span}'; use now, today or week"}
    place = await _place(str(payload.get("place") or MY_LOCATION).strip())
    if "error" in place:
        return place
    point = [(place["lat"], place["lon"])]
    try:
        # Looked up on the module so tests can swap openmeteo.forecast.
        if span == "now":
            [loc] = await openmeteo.forecast(point, current=CURRENT)
        elif span == "today":
            [loc] = await openmeteo.forecast(point, hourly=HOURLY, forecast_days=2)
        else:
            [loc] = await openmeteo.forecast(point, daily=DAILY, forecast_days=7)
    except openmeteo.WeatherUnavailable as err:
        return {"error": f"weather service unavailable: {err}"}
    out: dict[str, Any] = {"place": place, "span": span}
    if span == "now":
        out["current"] = _current(loc["current"])
    elif span == "today":
        out["hourly"] = _hourly(loc)
    else:
        out["daily"] = _daily(loc)
    return out


def _num(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) else 0.0


def _title(label: str, span: str) -> str:
    suffix = SUFFIX[span]
    return f"{label.upper()[: MAX_TITLE - len(suffix) - 3]} · {suffix}"


def preview_get_weather(output: dict[str, Any]) -> dict[str, Any]:
    span = output["span"]
    title = _title(output["place"]["label"], span)
    if span == "now":
        c = output["current"]
        # Gauges read 0–100 (spec §4.1): wind past 100 km/h pins, UV is a short arc.
        metrics = [
            {"label": "Nhiệt độ", "value": _num(c["temp_c"]), "unit": "°C"},
            {"label": "Độ ẩm", "value": _num(c["humidity"]), "unit": "%"},
            {"label": "Gió", "value": _num(c["wind_kmh"]), "unit": "km/h"},
            {"label": "UV", "value": _num(c["uv"])},
        ]
        return {"type": "radial_gauge", "title": title, "data": {"metrics": metrics}}
    if span == "today":
        rows = output["hourly"]
        return {"type": "line_3d", "title": title, "data": {"series": [
            {"label": "NHIỆT ĐỘ", "points": [_num(r["temp_c"]) for r in rows]},
            {"label": "% MƯA", "points": [_num(r["rain_prob"]) for r in rows]},
        ]}}
    rows = output["daily"]
    return {"type": "bar_3d", "title": title, "data": {"series": [
        {"label": "CAO", "points": [_num(r["max_c"]) for r in rows]},
        {"label": "THẤP", "points": [_num(r["min_c"]) for r in rows]},
        {"label": "% MƯA", "points": [_num(r["rain_prob"]) for r in rows]},
    ]}}
```

`backend/friday/tools/registry.py` — add the import next to the geo import:

```python
from friday.weather.tools import preview_get_weather, run_get_weather
```

Add after the `get_directions` `Tool(...)` entry (after its `timeout_s=25,\n        ),`):

```python
        Tool(
            name="get_weather",
            description=(
                "Current conditions and forecast for a place or the operator's "
                "location. span: now (right now), today (next 24 hours), week "
                "(7 days). place is a place name or 'my_location' (default). "
                "Prefer this over search_web for any weather question."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "place": {"type": "string", "description": "a place name, or 'my_location' (default)"},
                    "span": {"type": "string", "enum": ["now", "today", "week"], "description": "default now"},
                },
            },
            # Reads a public forecast; the only operator data sent is a ~1 km
            # position, and only when they already shared their location.
            risk="low",
            run=run_get_weather,
            capabilities=("geo.read",),
            preview=preview_get_weather,
            timeout_s=15,
        ),
```

Replace the `search_web` description with:

```python
            description=(
                "Search the public web and return extracts from the top results. "
                "Use for anything this host cannot measure itself: current events, "
                "documentation, prices, or any fact you are unsure of. "
                "Prefer this over answering from memory when the answer could have "
                "changed since training. Results come from a search index, not "
                "live sources: for fast-moving numbers such as prices or scores, "
                "say the value is approximate and may lag rather than "
                "presenting it as the current one."
            ),
```

`backend/friday/agent/agent.py:34` — replace

```
are ("here", "near me", local weather), call `get_client_location`.
```

with

```
are ("here", "near me"), call `get_client_location`. For weather, call \
`get_weather` — it finds their location itself.
```

`backend/evals/cases.py` — append to `CASES` (no location is shared in evals, so the tool answers without any network call):

```python
    {
        "id": "tool_selection/weather_uses_forecast",
        "area": "tool_selection",
        "input": "thời tiết hôm nay thế nào",
        "script": [("tool", "get_weather", {"span": "today"}), ("text", "Bạn chưa chia sẻ vị trí.")],
        "must_call": ["get_weather"],
        "must_not_call": ["search_web"],
        "approve": "never",
    },
```

`backend/README.md` — tool table row after `get_directions`:

```
| `get_weather` | low (`geo.read`) | Open-Meteo forecast for a place or `my_location` — span now/today/week pins gauges, a 24 h line or 7-day bars |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python backend/runtests.py test_weather_tool test_evals test_geo_tools`
Expected: PASS for all three files

- [ ] **Step 5: Commit**

```bash
git add backend/friday/weather/tools.py backend/tests/unit/test_weather_tool.py backend/friday/tools/registry.py backend/friday/agent/agent.py backend/evals/cases.py backend/README.md
git commit -m "feat(weather): get_weather tool with gauges, 24h line and 7-day bars"
```

---

### Task 3: Rain along a route

**Files:**
- Create: `backend/friday/weather/route_weather.py`
- Create: `backend/tests/unit/test_route_weather.py`

**Interfaces:**
- Consumes: `openmeteo.forecast`, `openmeteo.WeatherUnavailable`, `openmeteo.TIMEOUT_S`, `openmeteo.MAX_DAYS` (Task 1). Input routes have the `tomtom._normalize` shape: `duration_s`, `departure_time` / `arrival_time` (ISO with offset), `coordinates` (`[lon, lat]` pairs), `maneuvers[]` with `duration_s`, `begin_shape_index`.
- Produces:
  - `route_weather.attach_weather(routes: list[dict]) -> list[dict]` (async) — copies with `weather = {"status": "ok", "sections": [...]}` or `{"status": "unavailable" | "out_of_range"}`. Section: `{"start", "end", "category", "probability", "precip_mm", "from_time", "to_time"}`.
  - `route_weather.samples(route) -> list[{"index", "at", "lat", "lon"}]`, `route_weather.classify(prob, precip, code) -> str | None`, `route_weather._hour_index(loc, at) -> int | None`, `route_weather.FIELDS`, `route_weather.MAX_SAMPLES`, `route_weather._utcnow()`.

- [ ] **Step 1: Write the failing test**

`backend/tests/unit/test_route_weather.py`:

```python
"""Rain along a route with a fake Open-Meteo — sampling, hour lookup,
classification, sections, failure. No network.

    PYTHONPATH=. python tests/unit/test_route_weather.py
"""

import asyncio
import copy
from datetime import datetime, timedelta, timezone

from friday.weather import openmeteo
from friday.weather import route_weather as rw

NOW = datetime(2026, 9, 23, 0, 0, tzinfo=timezone.utc)  # 07:00 in Hà Nội
#: lat → (precipitation_probability, precipitation mm/h, weather_code)
WET = {21.0: (10, 0.0, 1), 21.02: (80, 0.5, 61), 21.04: (70, 1.2, 63), 21.06: (90, 5.0, 95)}


def trip(n_maneuvers=6, step_s=300, depart="2026-09-23T07:00:00+07:00"):
    """A straight line north, one coordinate per maneuver, 0.01° apart."""
    coords = [[105.8, round(21.0 + i * 0.01, 2)] for i in range(n_maneuvers + 1)]
    start = datetime.fromisoformat(depart)
    total = n_maneuvers * step_s
    return {
        "distance_m": 1000 * n_maneuvers, "duration_s": total,
        "departure_time": depart, "arrival_time": (start + timedelta(seconds=total)).isoformat(),
        "coordinates": coords, "traffic_sections": [],
        "maneuvers": [{"instruction": f"Bước {i}", "maneuver": "STRAIGHT", "distance_m": 1000,
                       "duration_s": step_s, "begin_shape_index": i} for i in range(n_maneuvers)]
        + [{"instruction": "Đến nơi", "maneuver": "ARRIVE", "distance_m": 0, "duration_s": 0,
            "begin_shape_index": n_maneuvers}],
    }


ORIG = (openmeteo.forecast, rw._utcnow)


def install(calls, exc=None):
    async def forecast(points, *, hourly=(), forecast_days=1, **_):
        calls.append({"points": list(points), "hourly": list(hourly), "days": forecast_days})
        if exc:
            raise exc
        out = []
        for lat, _lon in points:
            prob, mm, code = WET.get(round(lat, 2), (0, 0.0, 0))
            out.append({"utc_offset_seconds": 25200, "hourly": {
                "time": [f"2026-09-23T{h:02d}:00" for h in range(24)],
                "precipitation_probability": [prob] * 24, "precipitation": [mm] * 24, "weather_code": [code] * 24}})
        return out

    openmeteo.forecast = forecast
    rw._utcnow = lambda: NOW


def restore():
    openmeteo.forecast, rw._utcnow = ORIG


def test_samples_every_ten_minutes_with_start_and_end() -> None:
    s = rw.samples(trip())
    assert [x["index"] for x in s] == [0, 2, 4, 6], s
    assert [x["at"].strftime("%H:%M") for x in s] == ["07:00", "07:10", "07:20", "07:30"]
    assert (s[1]["lat"], s[1]["lon"]) == (21.02, 105.8)


def test_long_routes_cap_at_twelve_samples() -> None:
    s = rw.samples(trip(n_maneuvers=40))  # 200 minutes
    assert len(s) <= rw.MAX_SAMPLES, len(s)
    assert s[0]["index"] == 0 and s[-1]["index"] == 40


def test_hour_lookup_uses_the_points_local_time() -> None:
    loc = {"utc_offset_seconds": 25200, "hourly": {"time": ["2026-09-23T23:00", "2026-09-24T00:00"]}}
    assert rw._hour_index(loc, datetime(2026, 9, 23, 17, 10, tzinfo=timezone.utc)) == 1  # 00:10 on the 24th
    assert rw._hour_index(loc, datetime(2026, 9, 23, 16, 59, tzinfo=timezone.utc)) == 0
    assert rw._hour_index(loc, datetime(2026, 9, 25, tzinfo=timezone.utc)) is None


def test_classification_thresholds() -> None:
    assert rw.classify(10, 0.0, 95) == "thunderstorm"
    assert rw.classify(10, 4.0, 63) == "heavy_rain"
    assert rw.classify(10, 0.3, 61) == "rain"
    assert rw.classify(60, 0.0, 2) == "rain"
    assert rw.classify(59, 0.29, 3) is None
    assert rw.classify(None, None, None) is None


def test_sections_merge_consecutive_samples_and_leave_the_input_alone() -> None:
    calls: list = []
    install(calls)
    route = trip()
    before = copy.deepcopy(route)
    try:
        [out] = asyncio.run(rw.attach_weather([route]))
    finally:
        restore()
    assert route == before, "the cached original is never mutated"
    assert len(calls) == 1 and calls[0]["hourly"] == rw.FIELDS and calls[0]["days"] == 2
    assert calls[0]["points"] == [(21.0, 105.8), (21.02, 105.8), (21.04, 105.8), (21.06, 105.8)]
    assert out["weather"] == {"status": "ok", "sections": [
        {"start": 2, "end": 6, "category": "rain", "probability": 80, "precip_mm": 1.2,
         "from_time": "07:10", "to_time": "07:30"},
        {"start": 6, "end": 6, "category": "thunderstorm", "probability": 90, "precip_mm": 5.0,
         "from_time": "07:30", "to_time": "07:30"},
    ]}, out["weather"]


def test_alternatives_share_one_request_and_dry_is_empty() -> None:
    calls: list = []
    install(calls)
    try:
        out = asyncio.run(rw.attach_weather([trip(), trip(n_maneuvers=1)]))
    finally:
        restore()
    assert len(calls) == 1 and len(calls[0]["points"]) == 6, calls
    assert out[1]["weather"] == {"status": "ok", "sections": []}


def test_out_of_range_makes_no_request() -> None:
    calls: list = []
    install(calls)
    try:
        for depart in ("2026-10-13T07:00:00+07:00", "2026-09-23T04:00:00+07:00"):  # 20 days out; 3 h ago
            [out] = asyncio.run(rw.attach_weather([trip(depart=depart)]))
            assert out["weather"] == {"status": "out_of_range"}, depart
    finally:
        restore()
    assert calls == []


def test_outage_and_missing_geometry_are_unavailable() -> None:
    calls: list = []
    install(calls, exc=openmeteo.WeatherUnavailable("down"))
    try:
        [out] = asyncio.run(rw.attach_weather([trip()]))
        assert out["weather"] == {"status": "unavailable"}
        [bare] = asyncio.run(rw.attach_weather([{"distance_m": 1, "duration_s": 1, "coordinates": [], "maneuvers": []}]))
        assert bare["weather"] == {"status": "unavailable"}
    finally:
        restore()
    assert len(calls) == 1, "a route without geometry asks nothing"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
```

(Sampling walk for `trip()`: maneuvers of 300 s at indices 0–5 plus ARRIVE at 6; a sample lands on the first maneuver whose start time reaches each 600 s mark → indices 2 (600 s), 4 (1200 s), 6 (1800 s). `trip(n_maneuvers=1)` gives samples at 0 and the end, 1 → 4 + 2 = 6 points.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python backend/runtests.py test_route_weather`
Expected: FAIL with `ImportError: cannot import name 'route_weather' from 'friday.weather'`

- [ ] **Step 3: Write minimal implementation**

`backend/friday/weather/route_weather.py`:

```python
"""Rain along a route (spec 2026-09-23 open-meteo §5).

attach_weather returns copies of TomTom's normalized routes with a `weather`
key — the originals live in TomTom's route cache and are never touched. One
Open-Meteo request covers every sample of every route; any failure reads as
"unavailable", never as a failed route.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from . import openmeteo

log = logging.getLogger(__name__)

STEP_S = 600
MAX_SAMPLES = 12
#: A route further in the past than this is not a forecast question.
PAST_SLACK = timedelta(hours=1)
FIELDS = ["precipitation_probability", "precipitation", "weather_code"]


def _utcnow() -> datetime:
    """Wall clock; tests swap it."""
    return datetime.now(timezone.utc)


def samples(route: dict[str, Any]) -> list[dict[str, Any]]:
    """Where and when to ask: every ~10 min of travel, start and end always (§5.1)."""
    coords = route.get("coordinates") or []
    if not coords or not route.get("departure_time"):
        return []
    start = datetime.fromisoformat(route["departure_time"])
    total = route.get("duration_s") or 0
    # A long route widens the step so start + 10 marks + end stay within 12.
    step = max(STEP_S, total / (MAX_SAMPLES - 1))
    picked: list[tuple[int, datetime]] = [(0, start)]
    elapsed, mark = 0.0, step
    for m in route.get("maneuvers", []):
        if elapsed >= mark and m["begin_shape_index"] > picked[-1][0]:
            picked.append((m["begin_shape_index"], start + timedelta(seconds=elapsed)))
            while mark <= elapsed:
                mark += step
        elapsed += m.get("duration_s", 0)
    last = len(coords) - 1
    if last > picked[-1][0]:
        end = route.get("arrival_time")
        picked.append((last, datetime.fromisoformat(end) if end else start + timedelta(seconds=total)))
    if len(picked) > MAX_SAMPLES:
        picked = picked[: MAX_SAMPLES - 1] + picked[-1:]
    return [{"index": i, "at": at, "lat": coords[i][1], "lon": coords[i][0]} for i, at in picked]


def _hour_index(loc: dict[str, Any], at: datetime) -> int | None:
    """The forecast hour containing `at`, read in the point's own local time."""
    local = at.astimezone(timezone.utc) + timedelta(seconds=loc.get("utc_offset_seconds", 0))
    try:
        return loc["hourly"]["time"].index(local.strftime("%Y-%m-%dT%H:00"))
    except (KeyError, ValueError):
        return None


def classify(probability: Any, precip_mm: Any, code: Any) -> str | None:
    """§5.3 — first match wins; None means dry."""
    if code is not None and 95 <= code <= 99:
        return "thunderstorm"
    if (precip_mm or 0) >= 4:
        return "heavy_rain"
    if (precip_mm or 0) >= 0.3 or (probability or 0) >= 60:
        return "rain"
    return None


def _reading(loc: dict[str, Any], at: datetime) -> dict[str, Any] | None:
    i = _hour_index(loc, at)
    if i is None:
        return None
    h = loc["hourly"]
    prob, precip, code = h["precipitation_probability"][i], h["precipitation"][i], h["weather_code"][i]
    return {"category": classify(prob, precip, code), "probability": prob or 0, "precip_mm": round(precip or 0, 1)}


def _sections(route: dict[str, Any], plan: list[dict[str, Any]], readings: list[dict[str, Any] | None]) -> list[dict[str, Any]]:
    """A sample stands for the stretch up to the next sample; same-category neighbours merge."""
    last = len(route["coordinates"]) - 1
    out: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for i, (s, r) in enumerate(zip(plan, readings)):
        category = r["category"] if r else None
        if category is None:
            current = None
            continue
        nxt = plan[i + 1] if i + 1 < len(plan) else None
        end, until = (nxt["index"], nxt["at"]) if nxt else (last, s["at"])
        if current and current["category"] == category:
            current.update(end=end, to_time=until.strftime("%H:%M"),
                           probability=max(current["probability"], r["probability"]),
                           precip_mm=max(current["precip_mm"], r["precip_mm"]))
        else:
            current = {"start": s["index"], "end": end, "category": category,
                       "probability": r["probability"], "precip_mm": r["precip_mm"],
                       "from_time": s["at"].strftime("%H:%M"), "to_time": until.strftime("%H:%M")}
            out.append(current)
    return out


async def attach_weather(routes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    copies = [dict(r) for r in routes]
    plans = [samples(r) for r in copies]
    wanted = [s for plan in plans for s in plan]

    def mark(status: str) -> list[dict[str, Any]]:
        for c in copies:
            c["weather"] = {"status": status}
        return copies

    if not wanted:
        return mark("unavailable")
    now = _utcnow()
    earliest = min(s["at"] for s in wanted)
    latest = max(s["at"] for s in wanted)
    if earliest < now - PAST_SLACK or latest > now + timedelta(days=openmeteo.MAX_DAYS):
        return mark("out_of_range")
    # +2: today counts, and a local date can run a day ahead of UTC.
    days = min(openmeteo.MAX_DAYS, (latest.astimezone(timezone.utc).date() - now.date()).days + 2)
    try:
        # Looked up on the module so tests can swap openmeteo.forecast.
        located = await asyncio.wait_for(
            openmeteo.forecast([(s["lat"], s["lon"]) for s in wanted], hourly=FIELDS, forecast_days=days),
            openmeteo.TIMEOUT_S,
        )
    except (openmeteo.WeatherUnavailable, TimeoutError) as err:
        log.warning("route weather unavailable: %s", err)
        return mark("unavailable")
    readings = iter([_reading(loc, s["at"]) for loc, s in zip(located, wanted)])
    for c, plan in zip(copies, plans):
        if not plan:
            c["weather"] = {"status": "unavailable"}
            continue
        c["weather"] = {"status": "ok", "sections": _sections(c, plan, [next(readings) for _ in plan])}
    return copies
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python backend/runtests.py test_route_weather`
Expected: PASS (`all checks passed`)

- [ ] **Step 5: Commit**

```bash
git add backend/friday/weather/route_weather.py backend/tests/unit/test_route_weather.py
git commit -m "feat(weather): rain sections along a route from travel-time samples"
```

---

### Task 4: Weather on `POST /geo/route` and `get_directions`

**Files:**
- Modify: `backend/friday/api/routes.py` (import near line 20; `geo_route` ~lines 705–720)
- Modify: `backend/friday/geo/tools.py` (imports; `run_get_directions` after the `tomtom.route` try-block)
- Modify: `backend/friday/tools/registry.py` (`get_directions` description ~line 123–130)
- Modify: `backend/tests/integration/test_geo_route.py`
- Modify: `backend/tests/unit/test_geo_tools.py`

**Interfaces:**
- Consumes: `route_weather.attach_weather(routes) -> list[dict]` (Task 3), called as `route_weather.attach_weather(...)` so tests can swap it; `openmeteo.forecast`, `openmeteo.WeatherUnavailable` (Task 1).
- Produces: `/geo/route` → `{"routes": [<route + "weather">]}`; `get_directions` output gains `weather_status: str` and `rain: list[{"from", "to", "category", "probability", "near"}]`; `geo.tools._rain(route) -> list[dict]`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/integration/test_geo_route.py` — in `test_route_defaults_to_the_plans_mode`, replace

```python
        assert res.status_code == 200 and res.json() == ROUTE, res.text
```

with

```python
        # No geometry in the fake route, so weather is unavailable without any request.
        assert res.status_code == 200 and res.json() == {
            "routes": [{**ROUTE["routes"][0], "weather": {"status": "unavailable"}}]}, res.text
```

and add before `if __name__ == "__main__":`

```python
def test_route_carries_weather_and_survives_an_outage() -> None:
    from datetime import datetime, timedelta, timezone

    from friday.weather import openmeteo

    depart = datetime.now(timezone(timedelta(hours=7))).replace(microsecond=0)
    timed = {"distance_m": 2412, "duration_s": 545, "traffic_delay_s": 0,
             "departure_time": depart.isoformat(), "arrival_time": (depart + timedelta(seconds=545)).isoformat(),
             "coordinates": [[105.8525, 21.0288], [105.8346, 21.0368]],
             "maneuvers": [{"instruction": "a", "maneuver": "DEPART", "distance_m": 2412, "duration_s": 545,
                            "begin_shape_index": 0}]}
    days = [(depart + timedelta(days=d)).strftime("%Y-%m-%d") for d in (0, 1)]
    times = [f"{d}T{h:02d}:00" for d in days for h in range(24)]

    async def dry(points, **_):
        return [{"utc_offset_seconds": 25200, "hourly": {"time": times, "precipitation_probability": [0] * 48,
                                                          "precipitation": [0.0] * 48, "weather_code": [0] * 48}}
                for _ in points]

    async def down(*_args, **_kwargs):
        raise openmeteo.WeatherUnavailable("down")

    fake("route", {"routes": [timed]})
    orig = openmeteo.forecast
    try:
        openmeteo.forecast = dry
        res = client.post("/geo/route", json={"waypoints": [A, B]})
        assert res.status_code == 200 and res.json()["routes"][0]["weather"] == {"status": "ok", "sections": []}, res.text
        openmeteo.forecast = down
        res = client.post("/geo/route", json={"waypoints": [A, B]})
        assert res.status_code == 200 and res.json()["routes"][0]["weather"] == {"status": "unavailable"}, res.text
    finally:
        openmeteo.forecast = orig
        restore()
```

`backend/tests/unit/test_geo_tools.py` — add before `test_registered_low_risk_geo_read`:

```python
def test_directions_report_rain_near_a_street() -> None:
    from friday.weather import route_weather

    orig = route_weather.attach_weather

    async def wet(routes):
        return [{**r, "weather": {"status": "ok", "sections": [
            {"start": 3, "end": 5, "category": "rain", "probability": 80, "precip_mm": 1.2,
             "from_time": "07:55", "to_time": "07:58"}]}} for r in routes]

    route_weather.attach_weather = wet
    fake({"a": [HG], "b": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "a", "to": "b"}))
    finally:
        route_weather.attach_weather = orig
        restore()
    assert out["weather_status"] == "ok"
    assert out["rain"] == [{"from": "07:55", "to": "07:58", "category": "rain", "probability": 80, "near": "Bước 3"}]


def test_directions_without_weather_say_so() -> None:
    fake({"a": [HG], "b": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "a", "to": "b"}))
    finally:
        restore()
    # ROUTE has no coordinates, so no forecast is asked for.
    assert out["weather_status"] == "unavailable" and out["rain"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python backend/runtests.py test_geo_route test_geo_tools`
Expected: FAIL — `test_route_defaults_to_the_plans_mode` (no `weather` key) and `test_directions_report_rain_near_a_street` (`KeyError: 'weather_status'`)

- [ ] **Step 3: Write minimal implementation**

`backend/friday/api/routes.py` — next to `from friday.geo import tomtom`:

```python
from friday.weather import route_weather
```

Replace the body of `geo_route`:

```python
@router.post("/geo/route", dependencies=[Depends(require_known_origin)])
async def geo_route(body: RouteRequest) -> Any:
    """Spec §6.3 — one route question for the map UI; cached in the client.

    Rain along each route rides on the same answer (spec 2026-09-23
    open-meteo §6.1); weather never turns a route into an error.
    """
    try:
        # Looked up on the module so tests can swap tomtom.route.
        result = await tomtom.route(
            [w.model_dump() for w in body.waypoints],
            body.profile,
            avoid=body.avoid,
            depart_at=body.depart_at,
            arrive_at=body.arrive_at,
        )
    except (tomtom.TomTomUnavailable, tomtom.QuotaExceeded) as err:
        return _geo_error(err, "routing_unavailable")
    except tomtom.NoRoute:
        return JSONResponse(status_code=422, content={"error": "no_route"})
    except tomtom.UnsupportedProfile:
        return JSONResponse(status_code=422, content={"error": "unsupported_profile"})
    return {"routes": await route_weather.attach_weather(result["routes"])}
```

`backend/friday/geo/tools.py` — imports:

```python
from friday.tools.client.metrics import CLIENT
from friday.weather import route_weather

from . import tomtom
from .route_time import DEFAULT_OFFSET_MIN, RouteTimeError, route_times
```

Add above `run_get_directions`:

```python
def _rain(route: dict[str, Any]) -> list[dict[str, Any]]:
    """Rainy stretches of one route, each named by the step it starts in."""
    out = []
    for s in route["weather"].get("sections", []):
        near = next((m["instruction"] for m in reversed(route["maneuvers"]) if m["begin_shape_index"] <= s["start"]), None)
        out.append({"from": s["from_time"], "to": s["to_time"], "category": s["category"],
                    "probability": s["probability"], "near": near})
    return out
```

In `run_get_directions`, replace `best = result["routes"][0]` with

```python
    # Looked up on the module so tests can swap route_weather.attach_weather.
    best = (await route_weather.attach_weather(result["routes"]))[0]
```

and add to the returned dict, after `"jams": ...`:

```python
        "weather_status": best["weather"]["status"],
        "rain": _rain(best),
```

`backend/friday/tools/registry.py` — `get_directions` description becomes:

```python
            description=(
                "Directions between places, shown on the street map with "
                "distance, time, departure/arrival clock times and the current "
                "traffic delay. from/to are place names or 'my_location'. "
                "profile: motor_scooter (default, xe máy), auto (car), bicycle, "
                "pedestrian. Use arrive_at when the user asks when to leave to "
                "arrive on time, depart_at for a later departure; call "
                "get_current_time first if you need today's date. Also reports "
                "rain along the way at the time the operator will pass (rain, "
                "with the step it starts near); mention it when present, "
                "especially on a motorbike."
            ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python backend/runtests.py test_geo_route test_geo_tools test_route_weather`
Expected: PASS for all three files

- [ ] **Step 5: Commit**

```bash
git add backend/friday/api/routes.py backend/friday/geo/tools.py backend/friday/tools/registry.py backend/tests/integration/test_geo_route.py backend/tests/unit/test_geo_tools.py
git commit -m "feat(geo): routes and get_directions carry rain along the way"
```

---

### Task 5: Frontend route weather model

**Files:**
- Modify: `src/components/friday/map/mapApi.ts` (types after `TrafficSection` ~line 193; `Route` ~line 195–206; helpers after `trafficSegments` ~line 280)
- Modify: `tests/unit/mapApi.spec.ts`

**Interfaces:**
- Consumes: the `/geo/route` route shape from Task 4 (`weather.status`, `weather.sections[]`).
- Produces: `WeatherSection`, `RouteWeather` types; `Route.weather?: RouteWeather`; `weatherSegments(route: Route): GeoJSON.FeatureCollection<GeoJSON.LineString, { category: WeatherSection["category"] }>`; `weatherLine(route: Route): string | null`.

- [ ] **Step 1: Write the failing test**

`tests/unit/mapApi.spec.ts` — add `weatherLine, weatherSegments,` to the import list (alphabetical, after `trafficSegments,`), and append:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts`
Expected: FAIL — `weatherSegments` / `weatherLine` are not exported

- [ ] **Step 3: Write minimal implementation**

`src/components/friday/map/mapApi.ts` — after the `TrafficSection` interface:

```ts
/** A rainy stretch of a route (spec 2026-09-23 open-meteo §5.3). */
export interface WeatherSection {
  start: number;
  end: number;
  category: "rain" | "heavy_rain" | "thunderstorm";
  probability: number;
  precip_mm: number;
  /** Local HH:MM when the rider enters / leaves the stretch. */
  from_time: string;
  to_time: string;
}

export interface RouteWeather {
  status: "ok" | "unavailable" | "out_of_range";
  /** Present only with status "ok"; [] means a dry route. */
  sections?: WeatherSection[];
}
```

In `Route`, after `traffic_sections: TrafficSection[];`:

```ts
  /** Rain along the way at the time it is passed (Open-Meteo). */
  weather?: RouteWeather;
```

After `trafficSegments`:

```ts
/** Rainy stretches of one route as line features for the weather overlay. */
export function weatherSegments(route: Route): GeoJSON.FeatureCollection<GeoJSON.LineString, { category: WeatherSection["category"] }> {
  return {
    type: "FeatureCollection",
    features: (route.weather?.sections ?? []).flatMap((s) => {
      const coordinates = route.coordinates.slice(s.start, s.end + 1);
      if (coordinates.length < 2) return [];
      return [{
        type: "Feature" as const,
        properties: { category: s.category },
        geometry: { type: "LineString" as const, coordinates },
      }];
    }),
  };
}

const WEATHER_LABELS: Record<WeatherSection["category"], string> = { rain: "mưa", heavy_rain: "mưa to", thunderstorm: "dông" };

/** The directions panel's one weather line, or null when there is nothing to say. */
export function weatherLine(route: Route): string | null {
  const weather = route.weather;
  if (weather?.status !== "ok") return null;
  const parts = (weather.sections ?? []).map((s) => {
    const when = s.from_time === s.to_time ? s.from_time : `${s.from_time}–${s.to_time}`;
    return `${WEATHER_LABELS[s.category]} ${when} (${Math.round(s.probability)}%)`;
  });
  if (parts.length === 0) return "Không mưa trên đường";
  const line = parts.join(" · ");
  return line[0].toUpperCase() + line.slice(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --project=unit tests/unit/mapApi.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/friday/map/mapApi.ts tests/unit/mapApi.spec.ts
git commit -m "feat(map): route weather types, rain segments and the panel line"
```

---

### Task 6: Rain on the map and in the directions panel

**Files:**
- Modify: `src/components/friday/map/DirectionsPanel.tsx` (imports ~line 8–25; constants ~line 27–29; `drawRoutes` ~line 55–84; `clearRoutes` ~line 86–94; summary JSX after the `directions-times` block ~line 318)
- Modify: `tests/ui/map.spec.ts` (`ROUTE` fixture ~line 116; first test ~lines 160–164)

**Interfaces:**
- Consumes: `weatherSegments(route)`, `weatherLine(route)` (Task 5).
- Produces: MapLibre source `friday-route-weather-src`, layer `friday-route-weather`; DOM `data-testid="directions-weather"`.

- [ ] **Step 1: Write the failing test**

`tests/ui/map.spec.ts` — in the `ROUTE` fixture's first route, after `traffic_sections: [...]`, add:

```ts
      weather: {
        status: "ok",
        sections: [{ start: 1, end: 2, category: "rain", probability: 80, precip_mm: 1.2, from_time: "07:57", to_time: "08:01" }],
      },
```

In `"an agent route opens directions with the summary, steps and route layers"`, after

```ts
    await expect(panel.getByRole("listitem")).toContainText(["Rẽ phải vào Hùng Vương"]);
```

add

```ts
    await expect(page.getByTestId("directions-weather")).toContainText("Mưa 07:57–08:01 (80%)");
    await expect(page.getByTestId("directions-weather")).toContainText("Thời tiết: Open-Meteo");
```

and extend the layer check's return expression to

```ts
      return !!m?.getLayer("friday-route-line") && !!m?.getLayer("friday-route-casing") && !!m?.getLayer("friday-route-traffic") && !!m?.getLayer("friday-route-weather");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts -g "an agent route opens directions"`
Expected: FAIL — `directions-weather` not found

- [ ] **Step 3: Write minimal implementation**

`src/components/friday/map/DirectionsPanel.tsx`:

Imports — add `weatherLine,` and `weatherSegments,` to the `./mapApi` import list (after `trafficSegments,`).

Constants — after `const TRAFFIC_SRC = "friday-route-traffic";`:

```ts
const WEATHER_SRC = "friday-route-weather-src";
```

In `drawRoutes`, after the `trafficData` line:

```ts
  const weatherData = routes[selected] ? weatherSegments(routes[selected]) : empty;
```

in the refresh branch, after the `TRAFFIC_SRC` `setData` line:

```ts
    (map.getSource(WEATHER_SRC) as GeoJSONSource).setData(weatherData);
```

after `map.addSource(TRAFFIC_SRC, ...)`:

```ts
  map.addSource(WEATHER_SRC, { type: "geojson", data: weatherData });
```

and after the `friday-route-closure` layer, before `friday-route-step`:

```ts
  // Rain on the selected route (spec 2026-09-23 open-meteo §7.2): dashed and offset so congestion stays visible.
  map.addLayer({
    id: "friday-route-weather", type: "line", source: WEATHER_SRC,
    layout: { "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "category"], "heavy_rain", "#2563eb", "thunderstorm", "#a855f7", "#38bdf8"],
      "line-width": 4, "line-offset": 5, "line-dasharray": [1, 1.5],
    },
  });
```

`clearRoutes` — the two loops become:

```ts
    for (const id of ["friday-route-step", "friday-route-weather", "friday-route-closure", "friday-route-traffic", "friday-route-line", "friday-route-casing"]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [STEP_SRC, WEATHER_SRC, TRAFFIC_SRC, ROUTE_SRC]) if (map.getSource(id)) map.removeSource(id);
```

Next to `const best = routes[selected];` (~line 211):

```ts
  const rain = best ? weatherLine(best) : null;
```

JSX — right after the `{best.departure_time && best.arrival_time && (...)}` block:

```tsx
          {rain && (
            <div data-testid="directions-weather" className="mt-1 text-xs text-sky-200">
              {rain}
              {/* CC BY 4.0 — credit wherever weather shows (spec §2). */}
              <span className="ml-2 text-[10px] text-slate-500">Thời tiết: Open-Meteo</span>
            </div>
          )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx playwright test --project=ui tests/ui/map.spec.ts`
Expected: PASS (all map UI tests)

- [ ] **Step 5: Full verification**

Run: `npm run verify`
Expected: lint, typecheck, frontend unit, backend suite, contracts and e2e all green

- [ ] **Step 6: Commit**

```bash
git add src/components/friday/map/DirectionsPanel.tsx tests/ui/map.spec.ts
git commit -m "feat(map): rain along the route on the map and in the directions panel"
```
