"""Rain along a route with a fake Open-Meteo — sampling, hour lookup,
classification, sections, failure. No network.

    PYTHONPATH=. python tests/unit/test_route_weather.py
"""

import asyncio
import copy
from datetime import datetime, timedelta, timezone

from friday.weather import openmeteo
from friday.weather import route_weather as rw

NOW = datetime(2026, 9, 23, 0, 0, tzinfo=timezone.utc)  # 07:00 in Hà Nội
#: lat → (precipitation_probability, precipitation mm/h, weather_code)
WET = {21.0: (10, 0.0, 1), 21.02: (80, 0.5, 61), 21.04: (70, 1.2, 63), 21.06: (90, 5.0, 95)}


def trip(n_maneuvers=6, step_s=300, depart="2026-09-23T07:00:00+07:00"):
    """A straight line north, one coordinate per maneuver, 0.01° apart."""
    coords = [[105.8, round(21.0 + i * 0.01, 2)] for i in range(n_maneuvers + 1)]
    start = datetime.fromisoformat(depart)
    total = n_maneuvers * step_s
    return {
        "distance_m": 1000 * n_maneuvers, "duration_s": total,
        "departure_time": depart, "arrival_time": (start + timedelta(seconds=total)).isoformat(),
        "coordinates": coords, "traffic_sections": [],
        "maneuvers": [{"instruction": f"Bước {i}", "maneuver": "STRAIGHT", "distance_m": 1000,
                       "duration_s": step_s, "begin_shape_index": i} for i in range(n_maneuvers)]
        + [{"instruction": "Đến nơi", "maneuver": "ARRIVE", "distance_m": 0, "duration_s": 0,
            "begin_shape_index": n_maneuvers}],
    }


ORIG = (openmeteo.forecast, rw._utcnow)


def install(calls, exc=None):
    async def forecast(points, *, hourly=(), forecast_days=1, **_):
        calls.append({"points": list(points), "hourly": list(hourly), "days": forecast_days})
        if exc:
            raise exc
        out = []
        for lat, _lon in points:
            prob, mm, code = WET.get(round(lat, 2), (0, 0.0, 0))
            out.append({"utc_offset_seconds": 25200, "hourly": {
                "time": [f"2026-09-23T{h:02d}:00" for h in range(24)],
                "precipitation_probability": [prob] * 24, "precipitation": [mm] * 24, "weather_code": [code] * 24}})
        return out

    openmeteo.forecast = forecast
    rw._utcnow = lambda: NOW


def restore():
    openmeteo.forecast, rw._utcnow = ORIG


def test_samples_every_ten_minutes_with_start_and_end() -> None:
    s = rw.samples(trip())
    assert [x["index"] for x in s] == [0, 2, 4, 6], s
    assert [x["at"].strftime("%H:%M") for x in s] == ["07:00", "07:10", "07:20", "07:30"]
    assert (s[1]["lat"], s[1]["lon"]) == (21.02, 105.8)


def test_long_routes_cap_at_twelve_samples() -> None:
    s = rw.samples(trip(n_maneuvers=40))  # 200 minutes
    assert len(s) <= rw.MAX_SAMPLES, len(s)
    assert s[0]["index"] == 0 and s[-1]["index"] == 40


def test_hour_lookup_uses_the_points_local_time() -> None:
    loc = {"utc_offset_seconds": 25200, "hourly": {"time": ["2026-09-23T23:00", "2026-09-24T00:00"]}}
    assert rw._hour_index(loc, datetime(2026, 9, 23, 17, 10, tzinfo=timezone.utc)) == 1  # 00:10 on the 24th
    assert rw._hour_index(loc, datetime(2026, 9, 23, 16, 59, tzinfo=timezone.utc)) == 0
    assert rw._hour_index(loc, datetime(2026, 9, 25, tzinfo=timezone.utc)) is None


def test_classification_thresholds() -> None:
    assert rw.classify(10, 0.0, 95) == "thunderstorm"
    assert rw.classify(10, 4.0, 63) == "heavy_rain"
    assert rw.classify(10, 0.3, 61) == "rain"
    assert rw.classify(60, 0.0, 2) == "rain"
    assert rw.classify(59, 0.29, 3) is None
    assert rw.classify(None, None, None) is None


def test_sections_merge_consecutive_samples_and_leave_the_input_alone() -> None:
    calls: list = []
    install(calls)
    route = trip()
    before = copy.deepcopy(route)
    try:
        [out] = asyncio.run(rw.attach_weather([route]))
    finally:
        restore()
    assert route == before, "the cached original is never mutated"
    assert len(calls) == 1 and calls[0]["hourly"] == rw.FIELDS and calls[0]["days"] == 2
    assert calls[0]["points"] == [(21.0, 105.8), (21.02, 105.8), (21.04, 105.8), (21.06, 105.8)]
    assert out["weather"] == {"status": "ok", "sections": [
        {"start": 2, "end": 6, "category": "rain", "probability": 80, "precip_mm": 1.2,
         "from_time": "07:10", "to_time": "07:30"},
        {"start": 6, "end": 6, "category": "thunderstorm", "probability": 90, "precip_mm": 5.0,
         "from_time": "07:30", "to_time": "07:30"},
    ]}, out["weather"]


def test_alternatives_share_one_request_and_dry_is_empty() -> None:
    calls: list = []
    install(calls)
    try:
        out = asyncio.run(rw.attach_weather([trip(), trip(n_maneuvers=1)]))
    finally:
        restore()
    assert len(calls) == 1 and len(calls[0]["points"]) == 6, calls
    assert out[1]["weather"] == {"status": "ok", "sections": []}


def test_out_of_range_makes_no_request() -> None:
    calls: list = []
    install(calls)
    try:
        for depart in ("2026-10-13T07:00:00+07:00", "2026-09-23T04:00:00+07:00"):  # 20 days out; 3 h ago
            [out] = asyncio.run(rw.attach_weather([trip(depart=depart)]))
            assert out["weather"] == {"status": "out_of_range"}, depart
    finally:
        restore()
    assert calls == []


def test_outage_and_missing_geometry_are_unavailable() -> None:
    calls: list = []
    install(calls, exc=openmeteo.WeatherUnavailable("down"))
    try:
        [out] = asyncio.run(rw.attach_weather([trip()]))
        assert out["weather"] == {"status": "unavailable"}
        [bare] = asyncio.run(rw.attach_weather([{"distance_m": 1, "duration_s": 1, "coordinates": [], "maneuvers": []}]))
        assert bare["weather"] == {"status": "unavailable"}
    finally:
        restore()
    assert len(calls) == 1, "a route without geometry asks nothing"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
