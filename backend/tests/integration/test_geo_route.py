"""POST /geo/route — validation, error mapping, origin guard.

    PYTHONPATH=. python tests/integration/test_geo_route.py
"""

import os

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"

from fastapi.testclient import TestClient

from friday.geo import valhalla
from friday.main import app

client = TestClient(app)
A = {"lat": 21.0288, "lon": 105.8525}
B = {"lat": 21.0368, "lon": 105.8346}
ROUTE = {"routes": [{"distance_m": 2400, "duration_s": 540, "legs": []}]}


def fake_route(result=None, exc=None):
    calls = []

    async def route(waypoints, profile="motor_scooter", alternates=2, language="vi-VN"):
        calls.append((waypoints, profile))
        if exc is not None:
            raise exc
        return result

    valhalla.route = route
    return calls


ORIGINAL = valhalla.route


def test_happy_path_defaults_to_motorbike() -> None:
    calls = fake_route(ROUTE)
    try:
        res = client.post("/geo/route", json={"waypoints": [A, B]})
    finally:
        valhalla.route = ORIGINAL
    assert res.status_code == 200 and res.json() == ROUTE, res.text
    assert calls == [([A, B], "motor_scooter")]


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
        valhalla.route = ORIGINAL


def test_error_mapping() -> None:
    fake_route(exc=valhalla.RoutingUnavailable("VALHALLA_URL is not set"))
    try:
        res = client.post("/geo/route", json={"waypoints": [A, B]})
        assert res.status_code == 503 and res.json() == {"error": "routing_unavailable"}, res.text
        fake_route(exc=valhalla.NoRoute("No path could be found for input"))
        res = client.post("/geo/route", json={"waypoints": [A, B]})
        assert res.status_code == 422 and res.json() == {"error": "no_route"}, res.text
    finally:
        valhalla.route = ORIGINAL


def test_origin_guard() -> None:
    fake_route(ROUTE)
    try:
        res = client.post("/geo/route", json={"waypoints": [A, B]}, headers={"origin": "https://evil.example"})
    finally:
        valhalla.route = ORIGINAL
    assert res.status_code == 403


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
