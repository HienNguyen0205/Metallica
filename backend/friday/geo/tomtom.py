"""TomTom Search, Places and Routing (spec §6) — one vendor, one server key.

TOMTOM_API_KEY never leaves this process; the browser's
NEXT_PUBLIC_TOMTOM_MAP_KEY is enabled for Map Display only. Unset means
search and directions are off, not broken. Free allowances are per API per
month (spec §6.1) — fuzzy search is only 2.5K — so every call is cached and
proximity is rounded to ~1 km before it leaves (spec §6.5). Same urllib +
to_thread shape as tools/integrations/fetch.py; no HTTP dependency.
"""

import asyncio
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from .maneuvers import vi_instruction

BASE = "https://api.tomtom.com"
TIMEOUT_S = 10.0
LANGUAGE = "vi-VN"
#: Contract profiles in preference order — all four are on the free plan.
PROFILE_ORDER = ("motor_scooter", "auto", "bicycle", "pedestrian")
TRAVEL_MODE = {"motor_scooter": "motorcycle", "auto": "car", "bicycle": "bicycle", "pedestrian": "pedestrian"}
#: A Places Details path ("pois/<id>"); anything else is refused, never fetched.
PLACE_REF = re.compile(r"^[a-z]+/[A-Za-z0-9_-]+$")


class TomTomUnavailable(Exception):
    """No key, rejected key, TomTom failing or unreachable."""


class QuotaExceeded(Exception):
    """429 — this month's free allowance for the API is used up."""


class NoRoute(Exception):
    """Routing ran and the stops are not connected by the road network."""


class UnsupportedProfile(Exception):
    """A travel mode outside the contract enum."""


def available_profiles() -> list[str]:
    return list(PROFILE_ORDER)


def default_profile() -> str:
    return PROFILE_ORDER[0]


def coarse(lat: float, lon: float) -> tuple[float, float]:
    return round(lat, 2), round(lon, 2)


class _Lru:
    def __init__(self, size: int) -> None:
        self.size = size
        self.data: "OrderedDict[str, Any]" = OrderedDict()

    def get(self, key: str) -> Any:
        if key not in self.data:
            return None
        self.data.move_to_end(key)
        return self.data[key]

    def put(self, key: str, value: Any) -> Any:
        self.data[key] = value
        if len(self.data) > self.size:
            self.data.popitem(last=False)
        return value


_CACHES = {"suggest": _Lru(512), "place": _Lru(256), "reverse": _Lru(256), "search": _Lru(256), "route": _Lru(256)}


def clear_cache() -> None:
    for cache in _CACHES.values():
        cache.data.clear()


def _base() -> str:
    # Test hook, like FRIDAY_ALLOW_PRIVATE_FETCH: point at a local fake.
    return os.getenv("FRIDAY_TOMTOM_URL", BASE).rstrip("/")


def _key() -> str:
    key = os.getenv("TOMTOM_API_KEY")
    if not key:
        raise TomTomUnavailable("TOMTOM_API_KEY is not set")
    return key


def _places_headers(attributes: str) -> dict[str, str]:
    return {"TomTom-Api-Key": _key(), "TomTom-Api-Version": "3", "Attributes": attributes, "Accept-Language": LANGUAGE}


def _message(err: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(err.read())
    except (ValueError, OSError):
        return ""
    return str((body.get("detailedError") or {}).get("message") or body.get("errorText") or body.get("message") or "")


def _http(url: str, *, body: dict | None = None, headers: dict | None = None, no_route_on_400: bool = False) -> Any:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json", **(headers or {})},
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        if err.code == 429:
            raise QuotaExceeded("TomTom free allowance used up") from err
        if err.code == 400 and no_route_on_400:
            raise NoRoute(_message(err)) from err
        raise TomTomUnavailable(f"tomtom HTTP {err.code}: {_message(err)}") from err
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        raise TomTomUnavailable(str(err)) from err


async def _cached(name: str, key: str, fetch: Callable[[], Any]) -> Any:
    cache = _CACHES[name]
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, await asyncio.to_thread(fetch))


# ---------- places (autocomplete) ----------

def _suggestion(result: dict[str, Any]) -> dict[str, Any] | None:
    more = result.get("more") or {}
    parts = more.get("pathParameters") or []
    if result.get("type") == "discoverAction" or more.get("operation") != "details" or not parts:
        return None
    ref = "/".join(str(p) for p in parts)
    if not PLACE_REF.match(ref):
        return None
    return {
        "ref": ref,
        "title": result.get("title", ""),
        "subtitle": ", ".join(result.get("subtitles") or []),
        "type": result.get("type", ""),
    }


async def suggest(query: str, near: tuple[float, float] | None = None, limit: int = 6) -> list[dict[str, Any]]:
    body: dict[str, Any] = {"query": query, "maxResults": limit}
    if near is not None:
        lat, lon = coarse(*near)
        body["origin"] = {"type": "Point", "coordinates": [lon, lat]}
    headers = _places_headers("results")
    url = f"{_base()}/maps/orbis/places/suggest"
    raw = await _cached("suggest", json.dumps([query.strip().lower(), body.get("origin"), limit]),
                        lambda: _http(url, body=body, headers=headers))
    return [s for s in (_suggestion(r) for r in raw.get("results", [])) if s]


async def place(ref: str) -> dict[str, float]:
    if not PLACE_REF.match(ref):
        raise ValueError(f"bad place ref {ref!r}")
    headers = _places_headers("position")
    raw = await _cached("place", ref, lambda: _http(f"{_base()}/maps/orbis/places/details/{ref}", headers=headers))
    coords = ((raw or {}).get("position") or {}).get("coordinates")
    if not coords:
        raise TomTomUnavailable("place has no position")
    return {"lat": coords[1], "lon": coords[0]}


# ---------- search / reverse ----------

async def reverse(lat: float, lon: float) -> str | None:
    params = urllib.parse.urlencode({"key": _key(), "language": LANGUAGE})
    url = f"{_base()}/search/2/reverseGeocode/{lat:.6f},{lon:.6f}.json?{params}"
    raw = await _cached("reverse", f"{lat:.5f},{lon:.5f}", lambda: _http(url))
    for entry in raw.get("addresses", []):
        text = (entry.get("address") or {}).get("freeformAddress")
        if text:
            return text
    return None


def _search_hit(result: dict[str, Any]) -> dict[str, Any]:
    address = (result.get("address") or {}).get("freeformAddress", "")
    return {
        "label": (result.get("poi") or {}).get("name") or address,
        "address": address,
        "category": (result.get("type") or "").lower() or None,
        "lat": result["position"]["lat"],
        "lon": result["position"]["lon"],
    }


async def search(query: str, near: tuple[float, float] | None = None, limit: int = 5) -> list[dict[str, Any]]:
    """Fuzzy search — agent tools only (2.5K/month; the UI uses suggest)."""
    params = {"key": _key(), "language": LANGUAGE, "limit": str(limit)}
    rounded = coarse(*near) if near is not None else None
    if rounded is not None:
        params["lat"], params["lon"] = str(rounded[0]), str(rounded[1])
    url = f"{_base()}/search/2/search/{urllib.parse.quote(query)}.json?{urllib.parse.urlencode(params)}"
    raw = await _cached("search", json.dumps([query.strip().lower(), rounded, limit]), lambda: _http(url))
    return [_search_hit(r) for r in raw.get("results", []) if r.get("position")][:limit]


# ---------- routing ----------

def _normalize(route: dict[str, Any]) -> dict[str, Any]:
    summary = route.get("summary") or {}
    total_m = summary.get("lengthInMeters", 0)
    total_s = summary.get("travelTimeInSeconds", 0)
    # pointIndex counts across the whole route, so the legs join in order.
    coords = [[round(p["longitude"], 6), round(p["latitude"], 6)] for leg in route.get("legs", []) for p in leg.get("points", [])]
    steps = (route.get("guidance") or {}).get("instructions", [])
    maneuvers = []
    for i, ins in enumerate(steps):
        nxt = steps[i + 1] if i + 1 < len(steps) else {}
        maneuvers.append({
            "instruction": vi_instruction(ins),
            "maneuver": ins.get("maneuver", ""),
            "distance_m": round(nxt.get("routeOffsetInMeters", total_m) - ins.get("routeOffsetInMeters", 0)),
            "duration_s": round(nxt.get("travelTimeInSeconds", total_s) - ins.get("travelTimeInSeconds", 0)),
            "begin_shape_index": ins.get("pointIndex", 0),
        })
    return {
        "distance_m": round(total_m),
        "duration_s": round(total_s),
        "traffic_delay_s": round(summary.get("trafficDelayInSeconds", 0)),
        "coordinates": coords,
        "maneuvers": maneuvers,
    }


async def route(waypoints: list[dict], profile: str | None = None) -> dict[str, Any]:
    key = _key()
    profile = profile or default_profile()
    if profile not in TRAVEL_MODE:
        raise UnsupportedProfile(profile)
    stops = ":".join(f"{w['lat']},{w['lon']}" for w in waypoints)
    params = {"key": key, "travelMode": TRAVEL_MODE[profile], "instructionsType": "coded",
              "traffic": "true", "routeRepresentation": "polyline"}
    # Alternatives only between two stops.
    if len(waypoints) == 2:
        params["maxAlternatives"] = "2"
    url = f"{_base()}/routing/1/calculateRoute/{stops}/json?{urllib.parse.urlencode(params)}"
    cache_key = json.dumps([[(round(w["lat"], 5), round(w["lon"], 5)) for w in waypoints], profile])
    raw = await _cached("route", cache_key, lambda: _http(url, no_route_on_400=True))
    routes = [_normalize(r) for r in raw.get("routes", [])]
    if not routes:
        raise NoRoute("no routes")
    return {"routes": routes}
