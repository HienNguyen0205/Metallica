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
ROUTE = {"routes": [{"distance_m": 2412, "duration_s": 545, "traffic_delay_s": 360,
                     "departure_time": "2026-09-23T07:52:00+07:00", "arrival_time": "2026-09-23T08:01:05+07:00",
                     "traffic_sections": [
                         {"start": 0, "end": 1, "category": "jam", "delay_s": 360, "magnitude": 3},
                         {"start": 1, "end": 2, "category": "road_work", "delay_s": 0, "magnitude": 1},
                     ], "coordinates": [], "maneuvers": [
    {"instruction": f"Bước {i}", "maneuver": "STRAIGHT", "distance_m": 10, "duration_s": 5, "begin_shape_index": i} for i in range(12)
]}]}


def run(coro, location=None, client=None):
    async def go():
        ctx = {**(client or {}), **({"location": location} if location else {})}
        cm.CLIENT.set(ClientContext(**ctx).model_dump(exclude_none=True) if ctx else {})
        return await coro

    return asyncio.run(go())


def fake(search_hits=None, route=None, route_exc=None):
    seen = {"search": [], "route": [], "options": []}

    async def search(query, near=None, limit=5):
        seen["search"].append((query, near, limit))
        return (search_hits or {}).get(query, [])[:limit]

    async def route_fn(waypoints, profile=None, **options):
        seen["route"].append((waypoints, profile))
        seen["options"].append(options)
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
    assert seen["options"] == [{"avoid": ["motorways"], "depart_at": None, "arrive_at": None}]
    assert out["distance_km"] == 2.4 and out["duration_min"] == 9 and out["profile"] == "motor_scooter"
    assert out["traffic_delay_min"] == 6
    assert out["avoid"] == ["motorways"] and out["jams"] == 1
    assert out["departure_time"] == {"local": "07:52", "iso": "2026-09-23T07:52:00+07:00"}
    assert out["arrival_time"]["local"] == "08:01"
    assert out["steps"] == [f"Bước {i}" for i in range(8)]
    spec = tools.preview_get_directions(out)
    assert spec["data"]["map"]["route"] == {"profile": "motor_scooter", "avoid": ["motorways"], "waypoints": [
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


def test_explicit_avoid_and_times() -> None:
    seen = fake({"a": [HG], "b": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "a", "to": "b", "profile": "auto", "arrive_at": "2099-01-01T08:00"}))
        assert "more than a year ahead" in out["error"]
        assert seen["route"] == [], "a bad time is refused before any request"

        run(tools.run_get_directions({"from": "a", "to": "b", "avoid": []}))
        assert seen["options"][-1]["avoid"] == [], "explicit [] avoids nothing, even on a motorbike"

        from datetime import datetime, timedelta, timezone

        local = (datetime.now(timezone(timedelta(hours=-5))) + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M")
        out = run(tools.run_get_directions({"from": "a", "to": "b", "profile": "auto", "avoid": ["tolls"],
                                            "depart_at": local}), client={"utc_offset_min": -300})
        assert seen["options"][-1] == {"avoid": ["tolls"], "depart_at": f"{local}:00-05:00", "arrive_at": None}
        route = tools.preview_get_directions(out)["data"]["map"]["route"]
        assert route["avoid"] == ["tolls"] and route["depart_at"] == f"{local}:00-05:00" and "arrive_at" not in route

        local7 = (datetime.now(timezone(timedelta(hours=7))) + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M")
        run(tools.run_get_directions({"from": "a", "to": "b", "arrive_at": local7}))
        assert seen["options"][-1]["arrive_at"] == f"{local7}:00+07:00", "no browser offset → +07:00"

        out = run(tools.run_get_directions({"from": "a", "to": "b", "avoid": ["cliffs"]}))
        assert "avoid" in out["error"]
    finally:
        restore()


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


def test_a_named_street_must_match_by_name() -> None:
    import unicodedata

    # What TomTom really answered for "đường trần thị năm", a street it does
    # not have: a restaurant near Hà Nội, a different street near Q12.
    mai = {"label": "Nhà Hàng Trần Thị Mai", "address": "Số 85, Đường Trần Duy Hưng, Hà Nội",
           "category": "poi", "lat": 21.011255, "lon": 105.800651}
    he = {"label": "Đường Trần Thị Hè, Hiệp Thành, Hồ Chí Minh", "address": "Đường Trần Thị Hè, Hiệp Thành, Hồ Chí Minh",
          "category": "street", "lat": 10.880219, "lon": 106.630647}
    nam = {"label": "Đường Trần Thị Năm, Tân Chánh Hiệp, Hồ Chí Minh", "address": "Tân Chánh Hiệp, Hồ Chí Minh",
           "category": "street", "lat": 10.86, "lon": 106.62}
    decomposed = unicodedata.normalize("NFD", "Đường Trần Thị Năm")
    try:
        seen = fake({"a": [HG], "đường trần thị năm": [mai, he]}, route=ROUTE)
        out = run(tools.run_get_directions({"from": "a", "to": "đường trần thị năm"}))
        assert out == tools.no_match("đường trần thị năm"), out
        assert "not in the map data" in out["error"], "the model is told to stop, not to retry"
        assert seen["route"] == [], "a wrong street is never routed to"
        # find_place drops the near-namesakes too, instead of offering them as leads.
        assert run(tools.run_find_place({"query": "đường trần thị năm"})) == tools.no_match("đường trần thị năm")

        fake({"a": [HG], "đường trần thị năm": [he, nam], decomposed: [mai, nam]}, route=ROUTE)
        assert run(tools.run_get_directions({"from": "a", "to": "đường trần thị năm"}))["to"] == nam
        assert run(tools.run_get_directions({"from": "a", "to": decomposed}))["to"] == nam, "NFD input still matches"
        fake({"a": [HG], "đường trần thị năm quận 12": [he, nam]}, route=ROUTE)
        out = run(tools.run_get_directions({"from": "a", "to": "đường trần thị năm quận 12"}))
        assert out["to"] == nam, "an area after the name still matches the street"
        # A short street name inside the asked one is not a match ("Đường Năm").
        short = {**he, "label": "Đường Năm, Hồ Chí Minh"}
        fake({"a": [HG], "đường trần thị năm": [short]}, route=ROUTE)
        assert "error" in run(tools.run_get_directions({"from": "a", "to": "đường trần thị năm"}))

        # Anything that is not "<street word> <name>" keeps the top hit: aliases
        # such as "lăng bác" → "Lăng Chủ tịch Hồ Chí Minh" must still resolve.
        fake({"a": [HG], "lăng bác": [mai]}, route=ROUTE)
        assert run(tools.run_get_directions({"from": "a", "to": "lăng bác"}))["to"] == mai
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
