"""get_weather (spec 2026-09-23 open-meteo §4) — read-only, low risk.

Places resolve the way get_directions resolves them (geo/tools.py); the
preview picks the viz from the span: now → gauges, today → 24 h line,
week → 7-day bars.
"""

import bisect
from datetime import datetime, timedelta, timezone
from typing import Any

from friday.geo import tomtom
from friday.geo.tools import MY_LOCATION, NO_LOCATION, QUOTA, _first, _is_me, _operator, no_match

from . import openmeteo
from .codes import describe

SPANS = ("now", "today", "week")
CURRENT = ["temperature_2m", "apparent_temperature", "relative_humidity_2m", "wind_speed_10m",
           "uv_index", "precipitation", "weather_code"]
HOURLY = ["temperature_2m", "precipitation_probability", "precipitation", "weather_code"]
DAILY = ["temperature_2m_max", "temperature_2m_min", "precipitation_probability_max",
         "precipitation_sum", "weather_code"]
MAX_TITLE = 40
SUFFIX = {"now": "BÂY GIỜ", "today": "24 GIỜ", "week": "7 NGÀY"}


def _utcnow() -> datetime:
    """Wall clock; tests swap it."""
    return datetime.now(timezone.utc)


async def _place(ref: str) -> dict[str, Any]:
    if _is_me(ref):
        me = _operator()
        if me is None:
            return NO_LOCATION
        return {"label": "Vị trí của bạn", "lat": me[0], "lon": me[1]}
    try:
        # Unbiased: weather is asked of cities, and biased to the operator
        # "Tokyo" came back as "Tokyo Store" down their street.
        hit = await _first(ref, None)
    except tomtom.QuotaExceeded:
        return QUOTA
    except tomtom.TomTomUnavailable as err:
        return {"error": f"place search unavailable: {err}"}
    if hit is None:
        return no_match(ref)
    return {"label": hit["label"], "lat": hit["lat"], "lon": hit["lon"]}


def _current(c: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": c["time"][11:16],
        "temp_c": c["temperature_2m"],
        "feels_like_c": c["apparent_temperature"],
        "humidity": c["relative_humidity_2m"],
        "wind_kmh": c["wind_speed_10m"],
        "uv": c["uv_index"],
        "precip_mm": c["precipitation"],
        "weather": describe(c["weather_code"]),
    }


def _hourly(loc: dict[str, Any]) -> list[dict[str, Any]]:
    """The next 24 hours, starting at the current local hour."""
    h = loc["hourly"]
    local_now = _utcnow() + timedelta(seconds=loc.get("utc_offset_seconds", 0))
    # Times are local "YYYY-MM-DDTHH:MM", so string order is time order.
    start = max(0, bisect.bisect_right(h["time"], local_now.strftime("%Y-%m-%dT%H:%M")) - 1)
    return [
        {
            "time": h["time"][i][11:16],
            "temp_c": h["temperature_2m"][i],
            "rain_prob": h["precipitation_probability"][i],
            "precip_mm": h["precipitation"][i],
            "weather": describe(h["weather_code"][i]),
        }
        for i in range(start, min(start + 24, len(h["time"])))
    ]


def _daily(loc: dict[str, Any]) -> list[dict[str, Any]]:
    d = loc["daily"]
    return [
        {
            "date": d["time"][i],
            "max_c": d["temperature_2m_max"][i],
            "min_c": d["temperature_2m_min"][i],
            "rain_prob": d["precipitation_probability_max"][i],
            "precip_mm": d["precipitation_sum"][i],
            "weather": describe(d["weather_code"][i]),
        }
        for i in range(len(d["time"]))
    ]


async def run_get_weather(payload: dict[str, Any]) -> dict[str, Any]:
    span = payload.get("span") or "now"
    if span not in SPANS:
        return {"error": f"unknown span '{span}'; use now, today or week"}
    place = await _place(str(payload.get("place") or MY_LOCATION).strip())
    if "error" in place:
        return place
    point = [(place["lat"], place["lon"])]
    try:
        # Looked up on the module so tests can swap openmeteo.forecast.
        if span == "now":
            [loc] = await openmeteo.forecast(point, current=CURRENT)
        elif span == "today":
            [loc] = await openmeteo.forecast(point, hourly=HOURLY, forecast_days=2)
        else:
            [loc] = await openmeteo.forecast(point, daily=DAILY, forecast_days=7)
    except openmeteo.WeatherUnavailable as err:
        return {"error": f"weather service unavailable: {err}"}
    out: dict[str, Any] = {"place": place, "span": span}
    if span == "now":
        out["current"] = _current(loc["current"])
    elif span == "today":
        out["hourly"] = _hourly(loc)
    else:
        out["daily"] = _daily(loc)
    return out


def _num(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) else 0.0


def _title(label: str, span: str) -> str:
    suffix = SUFFIX[span]
    return f"{label.upper()[: MAX_TITLE - len(suffix) - 3]} · {suffix}"


def preview_get_weather(output: dict[str, Any]) -> dict[str, Any]:
    span = output["span"]
    title = _title(output["place"]["label"], span)
    if span == "now":
        c = output["current"]
        # Gauges read 0–100 (spec §4.1): wind past 100 km/h pins, UV is a short arc.
        metrics = [
            {"label": "Nhiệt độ", "value": _num(c["temp_c"]), "unit": "°C"},
            {"label": "Độ ẩm", "value": _num(c["humidity"]), "unit": "%"},
            {"label": "Gió", "value": _num(c["wind_kmh"]), "unit": "km/h"},
            {"label": "UV", "value": _num(c["uv"])},
        ]
        return {"type": "radial_gauge", "title": title, "data": {"metrics": metrics}}
    if span == "today":
        rows = output["hourly"]
        return {"type": "line_3d", "title": title, "data": {"series": [
            {"label": "NHIỆT ĐỘ", "points": [_num(r["temp_c"]) for r in rows]},
            {"label": "% MƯA", "points": [_num(r["rain_prob"]) for r in rows]},
        ]}}
    rows = output["daily"]
    return {"type": "bar_3d", "title": title, "data": {"series": [
        {"label": "CAO", "points": [_num(r["max_c"]) for r in rows]},
        {"label": "THẤP", "points": [_num(r["min_c"]) for r in rows]},
        {"label": "% MƯA", "points": [_num(r["rain_prob"]) for r in rows]},
    ]}}
