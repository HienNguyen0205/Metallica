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


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
