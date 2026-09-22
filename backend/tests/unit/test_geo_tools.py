"""find_place / get_directions with a fake TomTom module.

    PYTHONPATH=. python tests/unit/test_geo_tools.py
"""

import asyncio

from friday.api.schemas import ClientContext
from friday.geo import tomtom, tools
from friday.schemas.visualization import VisualizationPlan
from friday.tools import registry
from friday.tools.client import metrics as cm

HG = {"label": "Hồ Gươm", "address": "Hồ Hoàn Kiếm, Hà Nội", "category": "poi", "lat": 21.0288, "lon": 105.8525}
LB = {"label": "Lăng Bác", "address": "Ba Đình, Hà Nội", "category": "poi", "lat": 21.0368, "lon": 105.8346}
ROUTE = {"routes": [{"distance_m": 2412, "duration_s": 545, "traffic_delay_s": 360, "coordinates": [], "maneuvers": [
    {"instruction": f"Bước {i}", "maneuver": "STRAIGHT", "distance_m": 10, "duration_s": 5, "begin_shape_index": i} for i in range(12)
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

    async def route_fn(waypoints, profile=None):
        seen["route"].append((waypoints, profile))
        if route_exc:
            raise route_exc
        return route

    tomtom.search, tomtom.route = search, route_fn
    return seen


ORIG = (tomtom.search, tomtom.route)


def restore():
    tomtom.search, tomtom.route = ORIG


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
        assert seen["search"][0][1] == (21.028812, 105.852499)  # rounding happens in tomtom.search
    finally:
        restore()


def test_directions_default_to_motorbike_and_cap_steps() -> None:
    seen = fake({"hồ gươm": [HG], "lăng bác": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác"}))
    finally:
        restore()
    assert seen["route"] == [([{"lat": 21.0288, "lon": 105.8525}, {"lat": 21.0368, "lon": 105.8346}], "motor_scooter")]
    assert out["distance_km"] == 2.4 and out["duration_min"] == 9 and out["profile"] == "motor_scooter"
    assert out["traffic_delay_min"] == 6
    assert out["steps"] == [f"Bước {i}" for i in range(8)]
    spec = tools.preview_get_directions(out)
    assert spec["data"]["map"]["route"] == {"profile": "motor_scooter", "waypoints": [
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


def test_find_place_quota_is_an_error_dict() -> None:
    async def quota(query, near=None, limit=5):
        raise tomtom.QuotaExceeded()

    tomtom.search = quota
    try:
        assert "allowance" in run(tools.run_find_place({"query": "cafe"}))["error"]
    finally:
        restore()


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
