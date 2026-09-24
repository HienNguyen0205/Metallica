"""get_weather with a fake TomTom search and a fake Open-Meteo.

    PYTHONPATH=. python tests/unit/test_weather_tool.py
"""

import asyncio
from datetime import datetime, timezone

from friday.api.schemas import ClientContext
from friday.geo import tomtom
from friday.geo import tools as geo_tools
from friday.schemas.visualization import VisualizationPlan
from friday.tools import registry
from friday.tools.client import metrics as cm
from friday.weather import openmeteo, tools

HN = {"label": "Hà Nội", "address": "Hà Nội", "category": "geography", "lat": 21.0285, "lon": 105.8542}
HOURS = [f"2026-09-23T{h:02d}:00" for h in range(24)] + [f"2026-09-24T{h:02d}:00" for h in range(24)]
PROBS: list = list(range(48))
PROBS[20] = None  # Open-Meteo sends null where a model has no value
LOC = {
    "utc_offset_seconds": 25200,
    "current": {"time": "2026-09-23T14:15", "temperature_2m": 33.1, "apparent_temperature": 38.0,
                "relative_humidity_2m": 62, "wind_speed_10m": 11.2, "uv_index": 7.4,
                "precipitation": 0.0, "weather_code": 2},
    "hourly": {"time": HOURS, "temperature_2m": [25.0 + (i % 24) * 0.5 for i in range(48)],
               "precipitation_probability": PROBS, "precipitation": [0.0] * 48, "weather_code": [61] * 48},
    "daily": {"time": [f"2026-09-{23 + i}" for i in range(7)], "temperature_2m_max": [34.0] * 7,
              "temperature_2m_min": [26.1] * 7, "precipitation_probability_max": [70] * 7,
              "precipitation_sum": [12.4] * 7, "weather_code": [81] * 7},
}
ORIG = (tomtom.search, openmeteo.forecast, tools._utcnow)


def run(coro, location=None):
    async def go():
        cm.CLIENT.set(ClientContext(location=location).model_dump(exclude_none=True) if location else {})
        return await coro

    return asyncio.run(go())


def fake(hits=None, exc=None, search_exc=None):
    seen = {"search": [], "forecast": []}

    async def search(query, near=None, limit=5, country=None):
        assert country is None, "weather looks anywhere: 'thời tiết Tokyo'"
        seen["search"].append((query, near))
        if search_exc:
            raise search_exc
        return (hits or {}).get(query, [])[:limit]

    async def forecast(points, **kwargs):
        seen["forecast"].append((points, kwargs))
        if exc:
            raise exc
        return [LOC for _ in points]

    tomtom.search, openmeteo.forecast = search, forecast
    tools._utcnow = lambda: datetime(2026, 9, 23, 7, 20, tzinfo=timezone.utc)  # 14:20 in Hà Nội
    return seen


def restore():
    tomtom.search, openmeteo.forecast, tools._utcnow = ORIG


def test_now_at_my_location_reads_current_conditions_as_gauges() -> None:
    seen = fake()
    try:
        out = run(tools.run_get_weather({}), location={"lat": 21.0285, "lon": 105.8542})
    finally:
        restore()
    assert seen["search"] == [], "my_location needs no geocoding"
    assert seen["forecast"] == [([(21.0285, 105.8542)], {"current": tools.CURRENT})]
    assert out["place"] == {"label": "Vị trí của bạn", "lat": 21.0285, "lon": 105.8542}
    assert out["current"] == {"time": "14:15", "temp_c": 33.1, "feels_like_c": 38.0, "humidity": 62,
                              "wind_kmh": 11.2, "uv": 7.4, "precip_mm": 0.0, "weather": "nhiều mây"}
    assert "hourly" not in out and "daily" not in out
    spec = tools.preview_get_weather(out)
    assert spec["type"] == "radial_gauge" and spec["title"] == "VỊ TRÍ CỦA BẠN · BÂY GIỜ"
    assert [(m["label"], m["value"]) for m in spec["data"]["metrics"]] == [
        ("Nhiệt độ", 33.1), ("Độ ẩm", 62.0), ("Gió", 11.2), ("UV", 7.4)]
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_today_is_the_next_24_hours_as_a_line() -> None:
    seen = fake({"hà nội": [HN]})
    try:
        out = run(tools.run_get_weather({"place": "hà nội", "span": "today"}), location={"lat": 10.86, "lon": 106.62})
    finally:
        restore()
    # A named place is looked up without the operator's position: biased to
    # them, "Tokyo" asked from Hà Nội came back as "Tokyo Store" in Hà Nội.
    assert seen["search"] == [("hà nội", None)], seen["search"]
    assert seen["forecast"] == [([(21.0285, 105.8542)], {"hourly": tools.HOURLY, "forecast_days": 2})]
    assert out["place"]["label"] == "Hà Nội"
    rows = out["hourly"]
    assert len(rows) == 24 and rows[0]["time"] == "14:00" and rows[-1]["time"] == "13:00"
    assert rows[0] == {"time": "14:00", "temp_c": 32.0, "rain_prob": 14, "precip_mm": 0.0, "weather": "mưa nhẹ"}
    spec = tools.preview_get_weather(out)
    assert spec["type"] == "line_3d" and spec["title"] == "HÀ NỘI · 24 GIỜ"
    assert [s["label"] for s in spec["data"]["series"]] == ["NHIỆT ĐỘ", "% MƯA"]
    assert spec["data"]["series"][1]["points"][6] == 0.0, "null probability plots as 0"
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_week_is_seven_days_as_bars() -> None:
    seen = fake({"hà nội": [HN]})
    try:
        out = run(tools.run_get_weather({"place": "hà nội", "span": "week"}))
    finally:
        restore()
    assert seen["forecast"][0][1] == {"daily": tools.DAILY, "forecast_days": 7}
    assert len(out["daily"]) == 7
    assert out["daily"][0] == {"date": "2026-09-23", "max_c": 34.0, "min_c": 26.1, "rain_prob": 70,
                               "precip_mm": 12.4, "weather": "mưa rào"}
    spec = tools.preview_get_weather(out)
    assert spec["type"] == "bar_3d" and spec["title"] == "HÀ NỘI · 7 NGÀY"
    assert [(s["label"], len(s["points"])) for s in spec["data"]["series"]] == [("CAO", 7), ("THẤP", 7), ("% MƯA", 7)]
    VisualizationPlan.model_validate({**spec, "answer": "x"})


def test_long_place_names_keep_the_span_in_the_title() -> None:
    spec = tools.preview_get_weather({"place": {"label": "Thành phố Hồ Chí Minh, Quận Bình Thạnh, Phường 25"},
                                      "span": "now", "current": {"temp_c": 1, "humidity": 1, "wind_kmh": 1, "uv": 1}})
    assert len(spec["title"]) <= 40 and spec["title"].endswith(" · BÂY GIỜ"), spec["title"]


def test_errors_are_error_dicts() -> None:
    try:
        fake()
        assert run(tools.run_get_weather({"span": "now"})) == geo_tools.NO_LOCATION
        assert "no place matches" in run(tools.run_get_weather({"place": "atlantis"}))["error"]
        assert "span" in run(tools.run_get_weather({"place": "hà nội", "span": "month"}))["error"]
        fake({"hà nội": [HN]}, exc=openmeteo.WeatherUnavailable("down"))
        assert run(tools.run_get_weather({"place": "hà nội"})) == {"error": "weather service unavailable: down"}
        fake(search_exc=tomtom.QuotaExceeded())
        assert run(tools.run_get_weather({"place": "hà nội"})) == geo_tools.QUOTA
    finally:
        restore()


def test_registered_and_search_web_no_longer_claims_weather() -> None:
    tool = registry.get("get_weather")
    assert tool is not None and tool.risk == "low" and tool.capabilities == ("geo.read",)
    assert tool.preview is not None
    assert tool.input_schema["properties"]["span"]["enum"] == ["now", "today", "week"]
    assert "weather" not in registry.get("search_web").description.lower()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
