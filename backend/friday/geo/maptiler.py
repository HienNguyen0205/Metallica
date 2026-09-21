"""MapTiler geocoding for the agent tools (spec §6.4).

Server key MAPTILER_SERVER_KEY: the browser key is origin-locked and MapTiler
refuses it from a server. Only a ~1 km position ever leaves for proximity
bias (spec §6.5) — full precision stays on this side.
"""

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE = "https://api.maptiler.com/geocoding"
TIMEOUT_S = 8.0


class GeocodeUnavailable(Exception):
    """No key, network failure or a MapTiler error."""


def coarse(lat: float, lon: float) -> tuple[float, float]:
    return round(lat, 2), round(lon, 2)


def _get(url: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        raise GeocodeUnavailable(str(err)) from err


def _place(feature: dict[str, Any]) -> dict[str, Any]:
    lon, lat = feature["center"][:2]
    return {
        "label": feature.get("text") or feature.get("place_name", ""),
        "address": feature.get("place_name", ""),
        "category": (feature.get("place_type") or [None])[0],
        "lat": lat,
        "lon": lon,
    }


async def search(query: str, near: tuple[float, float] | None = None, limit: int = 5) -> list[dict[str, Any]]:
    key = os.getenv("MAPTILER_SERVER_KEY")
    if not key:
        raise GeocodeUnavailable("MAPTILER_SERVER_KEY is not set")
    params = {"key": key, "language": "vi", "limit": str(limit)}
    if near is not None:
        lat, lon = coarse(*near)
        params["proximity"] = f"{lon},{lat}"
    url = f"{BASE}/{urllib.parse.quote(query)}.json?{urllib.parse.urlencode(params)}"
    raw = await asyncio.to_thread(_get, url)
    return [_place(f) for f in raw.get("features", []) if f.get("center")][:limit]
