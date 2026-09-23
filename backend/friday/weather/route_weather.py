"""Rain along a route (spec 2026-09-23 open-meteo §5).

attach_weather returns copies of TomTom's normalized routes with a `weather`
key — the originals live in TomTom's route cache and are never touched. One
Open-Meteo request covers every sample of every route; any failure reads as
"unavailable", never as a failed route.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from . import openmeteo

log = logging.getLogger(__name__)

STEP_S = 600
MAX_SAMPLES = 12
#: A route further in the past than this is not a forecast question.
PAST_SLACK = timedelta(hours=1)
FIELDS = ["precipitation_probability", "precipitation", "weather_code"]


def _utcnow() -> datetime:
    """Wall clock; tests swap it."""
    return datetime.now(timezone.utc)


def samples(route: dict[str, Any]) -> list[dict[str, Any]]:
    """Where and when to ask: every ~10 min of travel, start and end always (§5.1)."""
    coords = route.get("coordinates") or []
    if not coords or not route.get("departure_time"):
        return []
    start = datetime.fromisoformat(route["departure_time"])
    total = route.get("duration_s") or 0
    # A long route widens the step so start + 10 marks + end stay within 12.
    step = max(STEP_S, total / (MAX_SAMPLES - 1))
    picked: list[tuple[int, datetime]] = [(0, start)]
    elapsed, mark = 0.0, step
    for m in route.get("maneuvers", []):
        if elapsed >= mark and m["begin_shape_index"] > picked[-1][0]:
            picked.append((m["begin_shape_index"], start + timedelta(seconds=elapsed)))
            while mark <= elapsed:
                mark += step
        elapsed += m.get("duration_s", 0)
    last = len(coords) - 1
    if last > picked[-1][0]:
        end = route.get("arrival_time")
        picked.append((last, datetime.fromisoformat(end) if end else start + timedelta(seconds=total)))
    if len(picked) > MAX_SAMPLES:
        picked = picked[: MAX_SAMPLES - 1] + picked[-1:]
    return [{"index": i, "at": at, "lat": coords[i][1], "lon": coords[i][0]} for i, at in picked]


def _hour_index(loc: dict[str, Any], at: datetime) -> int | None:
    """The forecast hour containing `at`, read in the point's own local time."""
    local = at.astimezone(timezone.utc) + timedelta(seconds=loc.get("utc_offset_seconds", 0))
    try:
        return loc["hourly"]["time"].index(local.strftime("%Y-%m-%dT%H:00"))
    except ValueError:
        # The hour simply is not covered. A missing hourly/time block is a
        # malformed response — the KeyError funnels to "unavailable".
        return None


def classify(probability: Any, precip_mm: Any, code: Any) -> str | None:
    """§5.3 — first match wins; None means dry."""
    if code is not None and 95 <= code <= 99:
        return "thunderstorm"
    if (precip_mm or 0) >= 4:
        return "heavy_rain"
    if (precip_mm or 0) >= 0.3 or (probability or 0) >= 60:
        return "rain"
    return None


def _reading(loc: dict[str, Any], at: datetime) -> dict[str, Any] | None:
    i = _hour_index(loc, at)
    if i is None:
        return None
    h = loc["hourly"]
    prob, precip, code = h["precipitation_probability"][i], h["precipitation"][i], h["weather_code"][i]
    return {"category": classify(prob, precip, code), "probability": prob or 0, "precip_mm": round(precip or 0, 1)}


def _sections(route: dict[str, Any], plan: list[dict[str, Any]], readings: list[dict[str, Any] | None]) -> list[dict[str, Any]]:
    """A sample stands for the stretch up to the next sample; same-category neighbours merge."""
    last = len(route["coordinates"]) - 1
    out: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for i, (s, r) in enumerate(zip(plan, readings)):
        category = r["category"] if r else None
        if category is None:
            current = None
            continue
        nxt = plan[i + 1] if i + 1 < len(plan) else None
        end, until = (nxt["index"], nxt["at"]) if nxt else (last, s["at"])
        if current and current["category"] == category:
            current.update(end=end, to_time=until.strftime("%H:%M"),
                           probability=max(current["probability"], r["probability"]),
                           precip_mm=max(current["precip_mm"], r["precip_mm"]))
        else:
            current = {"start": s["index"], "end": end, "category": category,
                       "probability": r["probability"], "precip_mm": r["precip_mm"],
                       "from_time": s["at"].strftime("%H:%M"), "to_time": until.strftime("%H:%M")}
            out.append(current)
    return out


async def attach_weather(routes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    copies = [dict(r) for r in routes]

    def mark(status: str) -> list[dict[str, Any]]:
        for c in copies:
            c["weather"] = {"status": status}
        return copies

    try:
        plans = [samples(r) for r in copies]
        wanted = [s for plan in plans for s in plan]
        if not wanted:
            return mark("unavailable")
        now = _utcnow()
        earliest = min(s["at"] for s in wanted)
        latest = max(s["at"] for s in wanted)
        if earliest < now - PAST_SLACK or latest > now + timedelta(days=openmeteo.MAX_DAYS):
            return mark("out_of_range")
        # +2: today counts, and a local date can run a day ahead of UTC.
        days = min(openmeteo.MAX_DAYS, (latest.astimezone(timezone.utc).date() - now.date()).days + 2)
        # Looked up on the module so tests can swap openmeteo.forecast.
        located = await asyncio.wait_for(
            openmeteo.forecast([(s["lat"], s["lon"]) for s in wanted], hourly=FIELDS, forecast_days=days),
            openmeteo.TIMEOUT_S,
        )
        readings = iter([_reading(loc, s["at"]) for loc, s in zip(located, wanted)])
        for c, plan in zip(copies, plans):
            if not plan:
                c["weather"] = {"status": "unavailable"}
                continue
            c["weather"] = {"status": "ok", "sections": _sections(c, plan, [next(readings) for _ in plan])}
        return copies
    except Exception as err:
        # Intentionally anything, not just WeatherUnavailable/TimeoutError: a
        # malformed route, a nonsense forecast body or a parsing bug must still
        # never break the route — weather adds no new failure mode.
        log.warning("route weather unavailable: %s", err)
        return mark("unavailable")
