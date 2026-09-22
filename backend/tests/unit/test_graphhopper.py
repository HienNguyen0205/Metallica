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
