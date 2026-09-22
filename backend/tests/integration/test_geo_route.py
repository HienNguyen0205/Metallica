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
