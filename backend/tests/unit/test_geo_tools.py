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
    seen = {"search": [], "route": [], "options": [], "country": []}

    async def search(query, near=None, limit=5, country=None):
        seen["search"].append((query, near, limit))
        seen["country"].append(country)
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
        fake({"hồ gươm": [HG], "lăng bác": [LB]}, route_exc=tomtom.TomTomUnavailable("no key"))
        assert "not configured" in run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác"}))["error"]
        fake({"hồ gươm": [HG], "lăng bác": [LB]}, route_exc=tomtom.QuotaExceeded())
        assert "allowance" in run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác"}))["error"]
        fake({"hồ gươm": [HG], "lăng bác": [LB]}, route_exc=tomtom.NoRoute("not connected"))
        assert "no route" in run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác"}))["error"]
        fake({"hồ gươm": [HG]}, route=ROUTE)
        assert "nowhere" in run(tools.run_get_directions({"from": "hồ gươm", "to": "nowhere"}))["error"]
        assert "profile" in run(tools.run_get_directions({"from": "hồ gươm", "to": "hồ gươm", "profile": "rocket"}))["error"]
    finally:
        restore()


def test_find_place_quota_is_an_error_dict() -> None:
    async def quota(query, near=None, limit=5, country=None):
        raise tomtom.QuotaExceeded()

    tomtom.search = quota
    try:
        assert "allowance" in run(tools.run_find_place({"query": "cafe"}))["error"]
    finally:
        restore()


def test_explicit_avoid_and_times() -> None:
    seen = fake({"hồ gươm": [HG], "lăng bác": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác", "profile": "auto", "arrive_at": "2099-01-01T08:00"}))
        assert "more than a year ahead" in out["error"]
        assert seen["route"] == [], "a bad time is refused before any request"

        run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác", "avoid": []}))
        assert seen["options"][-1]["avoid"] == [], "explicit [] avoids nothing, even on a motorbike"

        from datetime import datetime, timedelta, timezone

        local = (datetime.now(timezone(timedelta(hours=-5))) + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M")
        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác", "profile": "auto", "avoid": ["tolls"],
                                            "depart_at": local}), client={"utc_offset_min": -300})
        assert seen["options"][-1] == {"avoid": ["tolls"], "depart_at": f"{local}:00-05:00", "arrive_at": None}
        route = tools.preview_get_directions(out)["data"]["map"]["route"]
        assert route["avoid"] == ["tolls"] and route["depart_at"] == f"{local}:00-05:00" and "arrive_at" not in route

        local7 = (datetime.now(timezone(timedelta(hours=7))) + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M")
        run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác", "arrive_at": local7}))
        assert seen["options"][-1]["arrive_at"] == f"{local7}:00+07:00", "no browser offset → +07:00"

        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác", "avoid": ["cliffs"]}))
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
    fake({"hồ gươm": [HG], "lăng bác": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác"}))
    finally:
        route_weather.attach_weather = orig
        restore()
    assert out["weather_status"] == "ok"
    assert out["rain"] == [{"from": "07:55", "to": "07:58", "category": "rain", "probability": 80, "near": "Bước 3"}]


def test_directions_without_weather_say_so() -> None:
    fake({"hồ gươm": [HG], "lăng bác": [LB]}, route=ROUTE)
    try:
        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác"}))
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
        seen = fake({"hồ gươm": [HG], "đường trần thị năm": [mai, he]}, route=ROUTE)
        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "đường trần thị năm"}))
        assert out == tools.no_match("đường trần thị năm"), out
        assert "Do not retry other spellings" in out["error"], "the model is told to stop hunting"
        assert seen["route"] == [], "a wrong street is never routed to"
        # find_place drops the near-namesakes too, instead of offering them as leads.
        assert run(tools.run_find_place({"query": "đường trần thị năm"})) == tools.no_match("đường trần thị năm")

        fake({"hồ gươm": [HG], "đường trần thị năm": [he, nam], decomposed: [mai, nam]}, route=ROUTE)
        assert run(tools.run_get_directions({"from": "hồ gươm", "to": "đường trần thị năm"}))["to"] == nam
        assert run(tools.run_get_directions({"from": "hồ gươm", "to": decomposed}))["to"] == nam, "NFD input still matches"
        fake({"hồ gươm": [HG], "đường trần thị năm quận 12": [he, nam]}, route=ROUTE)
        out = run(tools.run_get_directions({"from": "hồ gươm", "to": "đường trần thị năm quận 12"}))
        assert out["to"] == nam, "an area after the name still matches the street"
        # A short street name inside the asked one is not a match ("Đường Năm").
        short = {**he, "label": "Đường Năm, Hồ Chí Minh"}
        fake({"hồ gươm": [HG], "đường trần thị năm": [short]}, route=ROUTE)
        assert "error" in run(tools.run_get_directions({"from": "hồ gươm", "to": "đường trần thị năm"}))

    finally:
        restore()


def test_a_destination_must_be_named_by_the_query() -> None:
    # Live TomTom answers: "FPT IS" is not in the map data, so it offers shops.
    fpt_shop = {"label": "Fpt Shop", "address": "Phố Phan Bội Châu, Hà Nội", "category": "poi", "lat": 21.02, "lon": 105.84}
    toa = {"label": "Tòa Nhà FPT", "address": "Số 10, Phố Phạm Văn Bạch, Dịch Vọng Hậu, Hà Nội", "category": "poi",
           "lat": 21.03, "lon": 105.78}
    street = {"label": "Phố Phạm Văn Bạch, Dịch Vọng Hậu, Hà Nội", "address": "Phố Phạm Văn Bạch, Dịch Vọng Hậu, Hà Nội",
              "category": "street", "lat": 21.031, "lon": 105.785}
    danang = {"label": "Số 10, Đường Phạm Văn Bạch, Hòa Cường Nam, Đà Nẵng", "address": "Hòa Cường Nam, Đà Nẵng",
              "category": "point address", "lat": 16.03, "lon": 108.22}
    lau = {"label": "Lẩu Hơi Lãng Bạc", "address": "Hà Nội", "category": "poi", "lat": 21.0, "lon": 105.8}
    cases = {
        "FPT IS": ([fpt_shop], None),
        "toà nhà FPT": ([fpt_shop, toa], toa),  # old and new tone placement are one word
        "toa nha fpt": ([fpt_shop, toa], toa),  # typed without diacritics
        "10 Phạm Văn Bạch, Cầu Giấy": ([street, danang], street),  # the first part names it; numbers do not
        # What the model really sent after search_web: an English, unaccented address.
        "10 Pham Van Bach Street, Cau Giay, Hanoi": ([street], street),
        "so 10 pho pham van bach": ([street], street),
        "Đường Láng, Đống Đa":([{**street, "label": "Đường Láng, Đống Đa, Hà Nội"}], "Đường Láng, Đống Đa, Hà Nội"),
        "lăng bác": ([lau], None),  # lăng ≠ lãng: vowel marks still count
    }
    try:
        for query, (hits, want) in cases.items():
            seen = fake({"hồ gươm": [HG], query: hits}, route=ROUTE)
            out = run(tools.run_get_directions({"from": "hồ gươm", "to": query}))
            if want is None:
                assert out == tools.no_match(query), (query, out)
                assert seen["route"] == [], query
            elif isinstance(want, str):
                assert out["to"]["label"] == want, (query, out)
            else:
                assert out["to"] == want, (query, out)
        assert "search_web" in tools.no_match("FPT IS")["error"], "the model is pointed at finding an address"
        # find_place keeps every hit: "quán cà phê gần tôi" names a kind, not a place.
        fake({"FPT IS": [fpt_shop]})
        assert run(tools.run_find_place({"query": "FPT IS"})) == {"places": [fpt_shop]}
    finally:
        restore()


def test_an_address_naming_another_city_is_found_there() -> None:
    # Live: from Q12, "…, Hà Nội" came back as an alley of the same name in HCMC.
    alley = {"label": "Hẻm 571/10 Phạm Văn Bạch, Phường 15, Hồ Chí Minh", "address": "Phường 15, Hồ Chí Minh",
             "category": "street", "lat": 10.82, "lon": 106.64}
    hanoi = {"label": "Phố Phạm Văn Bạch, Dịch Vọng Hậu, Hà Nội", "address": "Dịch Vọng Hậu, Hà Nội, Hà Nội",
             "category": "street", "lat": 21.031, "lon": 105.785}
    ktx = {"label": "Khu Chế Xuất Tân Thuận", "address": "Tân Thuận Đông, Hồ Chí Minh", "category": "poi",
           "lat": 10.75, "lon": 106.74}
    calls = []

    async def search(query, near=None, limit=5, country=None):
        calls.append((query, near))
        if query.startswith("Khu"):
            return [ktx]
        return [alley] if near else [hanoi]  # proximity pulls toward the operator's city

    tomtom.search = search
    try:
        me = {"lat": 10.8628, "lon": 106.6254}
        for query in ("Số 10 Phạm Văn Bạch, Cầu Giấy, Hà Nội", "10 Pham Van Bach Street, Cau Giay, Hanoi"):
            calls.clear()
            assert run(tools._first(query, (me["lat"], me["lon"]))) == hanoi, query
            assert calls == [(query, (me["lat"], me["lon"])), (query, None)], calls
        # "TP.HCM" names Hồ Chí Minh; "Quận 7" names nothing a TomTom address carries.
        calls.clear()
        assert run(tools._first("Khu chế xuất Tân Thuận, Quận 7, TP.HCM", (10.86, 106.62))) == ktx
        assert len(calls) == 1, "a match near the operator needs no second search"
        # Any miss near the operator is looked up once more without their
        # position: from Q12 the top 10 for "Lăng Chủ tịch Hồ Chí Minh" are
        # all in HCMC, none of them the mausoleum.
        calls.clear()
        assert run(tools._first("FPT IS", (10.86, 106.62))) is None
        assert calls == [("FPT IS", (10.86, 106.62)), ("FPT IS", None)], calls
    finally:
        restore()


def test_the_best_named_hit_wins_not_the_first() -> None:
    # Live TomTom order for "Đại học Bách Khoa Hà Nội": the university itself is 7th,
    # behind a school in the Bách Khoa *ward* and the campus canteen.
    def poi(label, address="Bách Khoa, Hà Nội"):
        return {"label": label, "address": address, "category": "poi", "lat": 21.0, "lon": 105.84}

    mo = poi("Trường Đại Học Mở Hà Nội", "Đường Ngọc Hồi, Bách Khoa, Hà Nội")
    dhbk = poi("Đại Học Bách Khoa Hà Nội", "Đường Đại Cồ Việt, Bách Khoa, Hà Nội")
    hits = [mo, poi("Sân Vận Động Đại Học Bách Khoa"), poi("Trường Đại Học Bách Khoa Hà Nội-Khoa Đại Học Tại Chức"),
            poi("Trường Đại Học Bách Khoa Hà Nội-Nhà Ăn A1-5"), poi("Trường Đại Học Bách Khoa Hà Nội-Trung Tâm Phục Vụ"),
            poi("Ký Túc Xá Sinh Viên Trường Đại Học Bách Khoa Hà Nội"), dhbk, poi("Bể Bơi Đại Học Bách Khoa Hà Nội")]
    try:
        seen = fake({"Đại học Bách Khoa Hà Nội": hits})
        assert run(tools._first("Đại học Bách Khoa Hà Nội", None)) == dhbk
        assert seen["search"][-1][2] == 10, "a destination looks past the top 5"
        # Name words in the name beat name words found only in the address.
        fake({"Đại học Bách Khoa Hà Nội": [mo, hits[2]]})
        assert run(tools._first("Đại học Bách Khoa Hà Nội", None)) == hits[2]
        # Extra words in a name are fine when nothing closer exists.
        adidas = poi("adidas Vincom Bà Triệu", "Số 191, Phố Bà Triệu, Hà Nội")
        fake({"vincom bà triệu": [adidas]})
        assert run(tools._first("vincom bà triệu", None)) == adidas
    finally:
        restore()


def test_a_nickname_is_retried_by_its_official_name() -> None:
    error = tools.no_match("lăng bác")["error"]
    assert "official name" in error and "Lăng Chủ tịch Hồ Chí Minh" in error, error
    assert "Do not retry other spellings" in error
    for name in ("get_directions", "get_weather"):
        assert "official name" in registry.get(name).description, name


def test_directions_stay_in_vietnam_other_lookups_do_not() -> None:
    # Live: from Q12, "FPT Information System" matched its namesake in Phnom Penh
    # exactly, and won — a 227 km motorbike route across a border.
    try:
        seen = fake({"hồ gươm": [HG], "lăng bác": [LB]}, route=ROUTE)
        run(tools.run_get_directions({"from": "hồ gươm", "to": "lăng bác"}))
        assert seen["country"] == ["VN", "VN"], seen["country"]
        seen = fake({"cafe": [HG], "hồ gươm": [HG]})
        run(tools.run_find_place({"query": "cafe", "near": "hồ gươm"}))
        assert seen["country"] == [None, None], "find_place looks anywhere"
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
