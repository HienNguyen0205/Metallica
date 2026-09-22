"""GraphHopper Cloud routing (spec §6.2) — hosted, keyed, optional.

No GRAPHHOPPER_API_KEY means routing is off, not broken: callers get
RoutingUnavailable and say so plainly. The key never leaves this process;
the browser asks /geo/route. Same urllib + to_thread shape as
tools/integrations/fetch.py — no HTTP dependency for one GET.

The free plan routes car, bike and foot only. GRAPHHOPPER_PROFILES lists
what the key's plan allows; add "scooter" on a paid plan and the motorbike
mode appears everywhere (UI tabs, tool default) with no code change.
"""

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from typing import Any

BASE = "https://graphhopper.com/api/1"
TIMEOUT_S = 10.0
#: Every request costs credits (500/day on the free plan); drags and mode
#: toggles re-ask the same question, so answer those from memory.
CACHE_SIZE = 256
FREE_PLAN = "car,bike,foot"

#: Contract profile names (Valhalla-style, spec §5) in preference order —
#: the first one the plan allows is the default.
PROFILE_ORDER = ("motor_scooter", "auto", "bicycle", "pedestrian")
GH_PROFILE = {"motor_scooter": "scooter", "auto": "car", "bicycle": "bike", "pedestrian": "foot"}

_CACHE: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


class RoutingUnavailable(Exception):
    """No key, out of credits, unreachable or failing — nothing to retry here."""


class NoRoute(Exception):
    """GraphHopper ran and found no path, or a point is not near any road."""


class UnsupportedProfile(Exception):
    """The key's plan does not include this travel mode."""


def _base() -> str:
    # Test hook, like FRIDAY_ALLOW_PRIVATE_FETCH: point at a local fake.
    return os.getenv("FRIDAY_GRAPHHOPPER_URL", BASE).rstrip("/")


def available_profiles() -> list[str]:
    allowed = {p.strip() for p in os.getenv("GRAPHHOPPER_PROFILES", FREE_PLAN).split(",") if p.strip()}
    return [p for p in PROFILE_ORDER if GH_PROFILE[p] in allowed]


def default_profile() -> str:
    profiles = available_profiles()
    return profiles[0] if profiles else "auto"


def clear_cache() -> None:
    _CACHE.clear()


def _get(url: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        # Input is validated before it gets here, so a 400 is GraphHopper
        # saying "no connection" or "point not near a road".
        if err.code == 400:
            raise NoRoute(_message(err)) from err
        # 401 bad key, 429 out of credits, 5xx: the caller cannot fix any of it.
        raise RoutingUnavailable(f"graphhopper HTTP {err.code}: {_message(err)}") from err
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        raise RoutingUnavailable(str(err)) from err


def _message(err: urllib.error.HTTPError) -> str:
    try:
        return str(json.loads(err.read()).get("message", ""))
    except (ValueError, OSError):
        return ""


def _normalize(path: dict[str, Any]) -> dict[str, Any]:
    return {
        "distance_m": round(path["distance"]),
        "duration_s": round(path["time"] / 1000),
        "coordinates": [[round(c[0], 6), round(c[1], 6)] for c in path["points"]["coordinates"]],
        "maneuvers": [
            {
                "instruction": i.get("text", ""),
                "sign": i.get("sign", 0),
                "distance_m": round(i.get("distance", 0)),
                "duration_s": round(i.get("time", 0) / 1000),
                "begin_shape_index": (i.get("interval") or [0])[0],
            }
            for i in path.get("instructions", [])
        ],
    }


async def route(waypoints: list[dict], profile: str | None = None, locale: str = "vi") -> dict[str, Any]:
    key = os.getenv("GRAPHHOPPER_API_KEY")
    if not key:
        raise RoutingUnavailable("GRAPHHOPPER_API_KEY is not set")
    profile = profile or default_profile()
    if profile not in available_profiles():
        raise UnsupportedProfile(profile)
    cache_key = json.dumps([[(round(w["lat"], 5), round(w["lon"], 5)) for w in waypoints], profile, locale])
    if cache_key in _CACHE:
        _CACHE.move_to_end(cache_key)
        return _CACHE[cache_key]
    params: list[tuple[str, str]] = [("point", f"{w['lat']},{w['lon']}") for w in waypoints]
    params += [
        ("profile", GH_PROFILE[profile]),
        ("locale", locale),
        ("instructions", "true"),
        ("points_encoded", "false"),
        ("key", key),
    ]
    # Alternatives only exist between two points (and cost extra credits).
    if len(waypoints) == 2:
        params += [("algorithm", "alternative_route"), ("alternative_route.max_paths", "3")]
    raw = await asyncio.to_thread(_get, f"{_base()}/route?{urllib.parse.urlencode(params)}")
    result = {"routes": [_normalize(p) for p in raw.get("paths", [])]}
    if not result["routes"]:
        raise NoRoute("no paths")
    _CACHE[cache_key] = result
    if len(_CACHE) > CACHE_SIZE:
        _CACHE.popitem(last=False)
    return result
