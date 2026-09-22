"""Valhalla routing client (spec §6.2) — self-hosted and optional.

An unset VALHALLA_URL means routing is off, not broken: callers get
RoutingUnavailable and say so plainly. Same urllib + to_thread shape as
tools/integrations/fetch.py; no HTTP dependency added for one POST.
"""

import asyncio
import json
import os
import urllib.error
import urllib.request
from collections import OrderedDict
from typing import Any

PROFILES = ("auto", "motor_scooter", "bicycle", "pedestrian")
TIMEOUT_S = 10.0
#: Drags and mode toggles re-ask the same question; answer those from memory.
CACHE_SIZE = 256

_CACHE: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


class RoutingUnavailable(Exception):
    """Not configured, unreachable, or failing — nothing the caller can fix."""


class NoRoute(Exception):
    """Valhalla ran and found no path (or the input is outside the extract)."""


def base_url() -> str | None:
    url = os.getenv("VALHALLA_URL", "").strip().rstrip("/")
    return url or None


def clear_cache() -> None:
    _CACHE.clear()


def _cache_key(waypoints: list[dict], profile: str, alternates: int, language: str) -> str:
    points = [(round(w["lat"], 5), round(w["lon"], 5)) for w in waypoints]
    return json.dumps([points, profile, alternates, language])


def _post(url: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        # "No path" (442) and "no edges near location" (171, i.e. outside the
        # Vietnam extract) both come back as 400 with a JSON body.
        if err.code == 400:
            raise NoRoute(_error_text(err)) from err
        raise RoutingUnavailable(f"valhalla HTTP {err.code}") from err
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        raise RoutingUnavailable(str(err)) from err


def _error_text(err: urllib.error.HTTPError) -> str:
    try:
        return str(json.loads(err.read()).get("error", "no route"))
    except (ValueError, OSError):
        return "no route"


def _normalize(trip: dict[str, Any]) -> dict[str, Any]:
    return {
        "distance_m": round(trip["summary"]["length"] * 1000),
        "duration_s": round(trip["summary"]["time"]),
        "legs": [
            {
                "shape": leg["shape"],
                "maneuvers": [
                    {
                        "instruction": m.get("instruction", ""),
                        "type": m.get("type", 0),
                        "distance_m": round(m.get("length", 0) * 1000),
                        "duration_s": round(m.get("time", 0)),
                        "begin_shape_index": m.get("begin_shape_index", 0),
                    }
                    for m in leg.get("maneuvers", [])
                ],
            }
            for leg in trip["legs"]
        ],
    }


async def route(
    waypoints: list[dict],
    profile: str = "motor_scooter",
    alternates: int = 2,
    language: str = "vi-VN",
) -> dict[str, Any]:
    url = base_url()
    if url is None:
        raise RoutingUnavailable("VALHALLA_URL is not set")
    # Valhalla only computes alternates between exactly two locations.
    if len(waypoints) > 2:
        alternates = 0
    key = _cache_key(waypoints, profile, alternates, language)
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    body = {
        "locations": [{"lat": w["lat"], "lon": w["lon"]} for w in waypoints],
        "costing": profile,
        "alternates": alternates,
        "directions_options": {"units": "kilometers", "language": language},
    }
    raw = await asyncio.to_thread(_post, f"{url}/route", body)
    trips = [raw["trip"], *(a["trip"] for a in raw.get("alternates", []))]
    result = {"routes": [_normalize(t) for t in trips]}
    _CACHE[key] = result
    if len(_CACHE) > CACHE_SIZE:
        _CACHE.popitem(last=False)
    return result
