"""find_place / get_directions with a fake geocoder and a fake router.

    PYTHONPATH=. python tests/unit/test_geo_tools.py
"""

import asyncio
import os
import urllib.parse

from friday.api.schemas import ClientContext
from friday.geo import graphhopper, maptiler, tools
from friday.schemas.visualization import VisualizationPlan
from friday.tools import registry
from friday.tools.client import metrics as cm

HG = {"label": "Hồ Gươm", "address": "Hồ Hoàn Kiếm, Hà Nội", "category": "poi", "lat": 21.0288, "lon": 105.8525}
LB = {"label": "Lăng Bác", "address": "Ba Đình, Hà Nội", "category": "poi", "lat": 21.0368, "lon": 105.8346}
ROUTE = {"routes": [{"distance_m": 2412, "duration_s": 545, "coordinates": [], "maneuvers": [
    {"instruction": f"Bước {i}", "sign": 0, "distance_m": 10, "duration_s": 5, "begin_shape_index": i} for i in range(12)
]}]}


def run(coro, location=None):
    async def go():
        cm.CLIENT.set(ClientContext(location=location).model_dump(exclude_none=True) if location else {})
        return await coro

    return asyncio.run(go())


def fake(search_hits=None, route=None, route_exc=None):
    seen = {"search": [], "route": []}

    async def search(query, near=None, limit=5):
        seen["search"].append((query, near, limit))
        return (search_hits or {}).get(query, [])[:limit]

    async def route_fn(waypoints, profile=None, locale="vi"):
        seen["route"].append((waypoints, profile))
        if route_exc:
            raise route_exc
        return route

    maptiler.search, graphhopper.route = search, route_fn
    return seen


ORIG = (maptiler.search, graphhopper.route)


def restore():
    maptiler.search, graphhopper.route = ORIG


def test_find_place_returns_places_and_a_map_preview() -> None:
    seen = fake({"hồ gươm": [HG]})
    try:
        out = run(tools.run_find_place({"query": "hồ gươm"}))
    finally:
        restore()
    assert out == {"places": [HG]}, out
    assert seen["search"] == [("hồ gươm", None, 5)]
    spec = tools.preview_find_place(out)
    assert spec["type"] == "map" and spec["data"]["map"] == {"center": {"lat": 21.0288, "lon": 105.8525}, "zoom": 15}
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_find_place_many_results_frame_a_bbox() -> None:
    spec = tools.preview_find_place({"places": [HG, LB]})
    assert spec["data"]["map"] == {"bbox": [105.8346, 21.0288, 105.8525, 21.0368]}
    assert [p["label"] for p in spec["data"]["points"]] == ["Hồ Gươm", "Lăng Bác"]


def test_near_my_location_needs_a_shared_location() -> None:
    fake({"cafe": [HG]})
    try:
        assert run(tools.run_find_place({"query": "cafe", "near": "my_location"})) == tools.NO_LOCATION
        seen = fake({"cafe": [HG]})
        run(tools.run_find_place({"query": "cafe", "near": "my_location"}),
            location={"lat": 21.028812, "lon": 105.852499})
        assert seen["search"][0][1] == (21.028812, 105.852499)  # rounding happens in maptiler.search
    finally:
        restore()


def test_directions_default_to_the_plans_mode_and_cap_steps() -> None:
    seen = fake({"hồ gươm": [HG], "lăng bác": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác"}))
    finally:
        restore()
    # free plan (GRAPHHOPPER_PROFILES unset): car is the default
    assert seen["route"] == [([{"lat": 21.0288, "lon": 105.8525}, {"lat": 21.0368, "lon": 105.8346}], "auto")]
    assert out["distance_km"] == 2.4 and out["duration_min"] == 9 and out["profile"] == "auto"
    assert out["steps"] == [f"Bước {i}" for i in range(8)]
    spec = tools.preview_get_directions(out)
    assert spec["data"]["map"]["route"] == {"profile": "auto", "waypoints": [
        {"lat": 21.0288, "lon": 105.8525, "label": "Hồ Gươm"},
        {"lat": 21.0368, "lon": 105.8346, "label": "Lăng Bác"},
    ]}
    assert [p["id"] for p in spec["data"]["points"]] == ["A", "B"]
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_directions_from_my_location() -> None:
    fake({"lăng bác": [LB]}, route=ROUTE)
    try:
        assert run(tools.run_get_directions({"from": "my_location", "to": "lăng bác"})) == tools.NO_LOCATION
        seen = fake({"lăng bác": [LB]}, route=ROUTE)
        out = run(tools.run_get_directions({"from": "my_location", "to": "lăng bác", "profile": "pedestrian"}),
                  location={"lat": 21.03, "lon": 105.85})
        assert out["from"]["label"] == "Vị trí của bạn" and seen["route"][0][1] == "pedestrian"
    finally:
        restore()


def test_directions_errors_are_error_dicts() -> None:
    try:
        fake({"a": [HG], "b": [LB]}, route_exc=graphhopper.RoutingUnavailable("no key"))
        assert "not configured" in run(tools.run_get_directions({"from": "a", "to": "b"}))["error"]
        fake({"a": [HG], "b": [LB]}, route_exc=graphhopper.NoRoute("Connection between locations not found"))
        assert "no route" in run(tools.run_get_directions({"from": "a", "to": "b"}))["error"]
        # scooter is not on the free plan: refused up front, with the reason
        seen = fake({"a": [HG], "b": [LB]}, route=ROUTE)
        assert "scooter" in run(tools.run_get_directions({"from": "a", "to": "b", "profile": "motor_scooter"}))["error"]
        assert seen["search"] == [] and seen["route"] == []  # no credit, no geocoding spent
        fake({"a": [HG]}, route=ROUTE)
        assert "nowhere" in run(tools.run_get_directions({"from": "a", "to": "nowhere"}))["error"]
        assert "profile" in run(tools.run_get_directions({"from": "a", "to": "a", "profile": "rocket"}))["error"]
    finally:
        restore()


def test_maptiler_sends_only_a_coarse_position() -> None:
    captured = []
    orig_get = maptiler._get
    maptiler._get = lambda url: captured.append(url) or {"features": [
        {"text": "Hồ Gươm", "place_name": "Hồ Gươm, Hà Nội", "center": [105.8525, 21.0288], "place_type": ["poi"]},
    ]}
    old = os.environ.get("MAPTILER_SERVER_KEY")
    os.environ["MAPTILER_SERVER_KEY"] = "k"
    try:
        hits = asyncio.run(maptiler.search("hồ gươm", near=(21.028812, 105.852499)))
    finally:
        maptiler._get = orig_get
        if old is None:
            os.environ.pop("MAPTILER_SERVER_KEY", None)
        else:
            os.environ["MAPTILER_SERVER_KEY"] = old
    q = urllib.parse.parse_qs(urllib.parse.urlparse(captured[0]).query)
    assert q["proximity"] == ["105.85,21.03"], q
    assert hits == [{"label": "Hồ Gươm", "address": "Hồ Gươm, Hà Nội", "category": "poi", "lat": 21.0288, "lon": 105.8525}]


def test_maptiler_without_a_key_is_unavailable() -> None:
    old = os.environ.pop("MAPTILER_SERVER_KEY", None)
    try:
        asyncio.run(maptiler.search("x"))
    except maptiler.GeocodeUnavailable:
        pass
    else:
        raise AssertionError("no key must be GeocodeUnavailable")
    finally:
        if old is not None:
            os.environ["MAPTILER_SERVER_KEY"] = old


def test_registered_low_risk_geo_read() -> None:
    for name in ("find_place", "get_directions"):
        tool = registry.get(name)
        assert tool is not None and tool.risk == "low" and tool.capabilities == ("geo.read",), name
        assert tool.preview is not None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
