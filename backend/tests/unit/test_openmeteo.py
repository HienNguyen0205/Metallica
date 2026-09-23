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
