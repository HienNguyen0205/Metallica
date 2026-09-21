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
