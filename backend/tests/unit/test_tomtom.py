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
        sent = {k.lower(): v for k, v in call["headers"].items()}  # urllib title-cases on the wire
        assert sent["tomtom-api-key"] == "test-key" and sent["tomtom-api-version"] == "3"
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
