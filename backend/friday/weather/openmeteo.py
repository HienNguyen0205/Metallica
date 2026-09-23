"""Open-Meteo forecast client (spec 2026-09-23 open-meteo §3) — no key needed.

Same urllib + to_thread shape as geo/tomtom.py; no HTTP dependency. Points
are rounded to ~1 km before they leave (privacy, and the cache key) and one
request carries every point. The free endpoint is non-commercial;
OPEN_METEO_API_KEY switches to the customer endpoint.
"""

import asyncio
import http.client
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from typing import Any

from friday.geo.tomtom import _Lru

BASE = "https://api.open-meteo.com/v1/forecast"
CUSTOMER = "https://customer-api.open-meteo.com/v1/forecast"
TIMEOUT_S = 4.0
#: Models update hourly at best.
TTL_S = 15 * 60
MAX_DAYS = 16

#: Expiry runs on tomtom._now (the shared LRU's clock); tests swap that.
_CACHE = _Lru(256)


class WeatherUnavailable(Exception):
    """Open-Meteo failing, unreachable, rate-limited or answering nonsense."""


def clear_cache() -> None:
    _CACHE.data.clear()


def _endpoint() -> tuple[str, dict[str, str]]:
    key = os.getenv("OPEN_METEO_API_KEY")
    # Test hook, like FRIDAY_TOMTOM_URL: point at a local fake.
    override = os.getenv("FRIDAY_OPEN_METEO_URL")
    url = f"{override.rstrip('/')}/v1/forecast" if override else (CUSTOMER if key else BASE)
    return url, ({"apikey": key} if key else {})


def _get(url: str) -> Any:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        try:
            reason = str(json.loads(err.read()).get("reason") or "")
        except (ValueError, OSError, AttributeError):
            reason = ""
        raise WeatherUnavailable(f"open-meteo HTTP {err.code}: {reason}".rstrip(": ")) from err
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, http.client.HTTPException) as err:
        raise WeatherUnavailable(str(err)) from err


async def forecast(
    points: Sequence[tuple[float, float]],
    *,
    current: Sequence[str] = (),
    hourly: Sequence[str] = (),
    daily: Sequence[str] = (),
    forecast_days: int = 1,
) -> list[dict[str, Any]]:
    """One Open-Meteo location object per point, in order."""
    if not points:
        return []
    rounded = [(round(lat, 2), round(lon, 2)) for lat, lon in points]
    unique = list(dict.fromkeys(rounded))
    params = {
        "latitude": ",".join(str(lat) for lat, _ in unique),
        "longitude": ",".join(str(lon) for _, lon in unique),
        "timezone": "auto",
        "wind_speed_unit": "kmh",
        "forecast_days": str(max(1, min(MAX_DAYS, forecast_days))),
    }
    for name, fields in (("current", current), ("hourly", hourly), ("daily", daily)):
        if fields:
            params[name] = ",".join(fields)
    cache_key = json.dumps([unique, list(current), list(hourly), list(daily), params["forecast_days"]])
    located = _CACHE.get(cache_key)
    if located is None:
        url, extra = _endpoint()
        raw = await asyncio.to_thread(_get, f"{url}?{urllib.parse.urlencode({**params, **extra})}")
        # A 200 can still carry {"error": true, "reason": ...} — check before it
        # ever reaches the cache.
        if isinstance(raw, dict) and raw.get("error"):
            raise WeatherUnavailable(str(raw.get("reason") or "open-meteo error"))
        located = raw if isinstance(raw, list) else [raw]
        if len(located) != len(unique) or not all(isinstance(loc, dict) for loc in located):
            raise WeatherUnavailable("unexpected response shape")
        _CACHE.put(cache_key, located, TTL_S)
    by_point = dict(zip(unique, located))
    return [by_point[p] for p in rounded]
