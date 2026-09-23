"""find_place / get_directions (spec §6.4) — read-only: geo.read, low risk.

Each returns an error dict rather than raising, like every other tool, and a
`map` preview that the orchestrator passes through unchanged (routes.py).
"""

import unicodedata
from typing import Any

from friday.tools.client.metrics import CLIENT
from friday.weather import route_weather

from . import tomtom
from .route_time import DEFAULT_OFFSET_MIN, RouteTimeError, route_times

MY_LOCATION = "my_location"
MAX_STEPS = 8
AVOID_VALUES = ("tolls", "motorways", "ferries", "unpaved")
#: Motorbikes are banned from Vietnamese expressways (spec 2026-09-23 §2).
MOTORBIKE_AVOID = ["motorways"]
NO_LOCATION = {"error": "the operator has not shared their location"}
QUOTA = {"error": "the map provider's free allowance for this month is used up"}


def _operator() -> tuple[float, float] | None:
    loc = (CLIENT.get() or {}).get("location")
    return (loc["lat"], loc["lon"]) if loc else None


def _is_me(ref: Any) -> bool:
    return str(ref).strip().lower() == MY_LOCATION


def _operator_offset() -> int:
    offset = (CLIENT.get() or {}).get("utc_offset_min")
    return DEFAULT_OFFSET_MIN if offset is None else offset


def _clock(iso: str | None) -> dict[str, str] | None:
    """TomTom answers in the route's local time; HH:MM is what gets spoken."""
    return {"local": iso[11:16], "iso": iso} if iso else None


#: Words naming a kind of road, not the road itself.
STREET_WORDS = {"đường", "phố", "ngõ", "hẻm", "kiệt"}


def _street_name(text: str) -> str | None:
    """"Đường Trần Thị Năm" → "trần thị năm"; None when no street is named."""
    words = unicodedata.normalize("NFC", text).lower().split()
    return " ".join(words[1:]) if len(words) > 1 and words[0] in STREET_WORDS else None


def _names_street(asked: str, hit: dict[str, Any]) -> bool:
    """The hit is the asked street; words after its name ("… quận 12") are fine."""
    street = _street_name(hit["label"].split(",")[0])
    return bool(street) and (asked == street or asked.startswith(street + " "))


def no_match(ref: str) -> dict[str, str]:
    # Worded as final: a missing place used to send the model hunting through
    # spellings, find_place and search_web until MAX_TURNS.
    return {"error": f"no place matches '{ref}' — it is not in the map data; tell the operator instead of retrying"}


async def _search(query: str, near: tuple[float, float] | None) -> list[dict[str, Any]]:
    # Looked up on the module so tests can swap tomtom.search.
    hits = await tomtom.search(query, near=near)
    asked = _street_name(query)
    if asked is None:
        return hits
    # Fuzzy search always answers something: for a street missing from the map
    # data it offers a near-namesake ("Trần Thị Hè" for "Trần Thị Năm") or a
    # shop. A named street must match by name, or it is not found.
    # ponytail: only "<street word> <name> …" is checked; "123 đường X" keeps
    # every hit — strip a leading house number if that needs it too.
    return [h for h in hits if _names_street(asked, h)]


async def _first(query: str, near: tuple[float, float] | None) -> dict[str, Any] | None:
    hits = await _search(query, near)
    return hits[0] if hits else None


async def run_find_place(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("query", "")).strip()
    if not query:
        return {"error": "query is required"}
    near_ref = payload.get("near")
    near: tuple[float, float] | None = None
    try:
        if near_ref and _is_me(near_ref):
            near = _operator()
            if near is None:
                return NO_LOCATION
        elif near_ref:
            anchor = await _first(str(near_ref), None)
            if anchor is None:
                return no_match(str(near_ref))
            near = (anchor["lat"], anchor["lon"])
        places = await _search(query, near)
    except tomtom.QuotaExceeded:
        return QUOTA
    except tomtom.TomTomUnavailable as err:
        return {"error": f"place search unavailable: {err}"}
    if not places:
        return no_match(query)
    return {"places": places}


def _rain(route: dict[str, Any]) -> list[dict[str, Any]]:
    """Rainy stretches of one route, each named by the step it starts in."""
    out = []
    for s in route["weather"].get("sections", []):
        near = next((m["instruction"] for m in reversed(route["maneuvers"]) if m["begin_shape_index"] <= s["start"]), None)
        out.append({"from": s["from_time"], "to": s["to_time"], "category": s["category"],
                    "probability": s["probability"], "near": near})
    return out


async def run_get_directions(payload: dict[str, Any]) -> dict[str, Any]:
    profile = payload.get("profile") or tomtom.default_profile()
    if profile not in tomtom.PROFILE_ORDER:
        return {"error": f"unknown profile '{profile}'"}
    requested_avoid = payload.get("avoid")
    if requested_avoid is None:
        avoid = list(MOTORBIKE_AVOID) if profile == "motor_scooter" else []
    else:
        unknown = [a for a in requested_avoid if a not in AVOID_VALUES]
        if unknown:
            return {"error": f"unknown avoid value(s): {', '.join(map(str, unknown))}; use {', '.join(AVOID_VALUES)}"}
        avoid = sorted(set(requested_avoid))
    try:
        depart_at, arrive_at = route_times(
            payload.get("depart_at"), payload.get("arrive_at"), assume_offset_min=_operator_offset()
        )
    except RouteTimeError as err:
        # Checked before any geocoding, so a bad time costs no quota.
        return {"error": str(err)}
    refs = [payload.get("from"), *list(payload.get("via") or [])[:3], payload.get("to")]
    if not refs[0] or not refs[-1]:
        return {"error": "from and to are required"}
    me = _operator()
    if me is None and any(_is_me(r) for r in refs):
        return NO_LOCATION
    stops: list[dict[str, Any]] = []
    try:
        for ref in refs:
            if _is_me(ref):
                stops.append({"label": "Vị trí của bạn", "lat": me[0], "lon": me[1]})
                continue
            place = await _first(str(ref), me)
            if place is None:
                return no_match(str(ref))
            stops.append(place)
        # Looked up on the module so tests can swap tomtom.route.
        result = await tomtom.route(
            [{"lat": s["lat"], "lon": s["lon"]} for s in stops],
            profile,
            avoid=avoid,
            depart_at=depart_at,
            arrive_at=arrive_at,
        )
    except tomtom.QuotaExceeded:
        return QUOTA
    except tomtom.TomTomUnavailable:
        return {"error": "search and directions are not configured on this server"}
    except tomtom.NoRoute:
        return {"error": "no route found between these places"}
    except tomtom.UnsupportedProfile:
        return {"error": f"unknown profile '{profile}'"}
    # Looked up on the module so tests can swap route_weather.attach_weather.
    best = (await route_weather.attach_weather(result["routes"]))[0]
    return {
        "from": stops[0],
        "to": stops[-1],
        "via": stops[1:-1],
        "profile": profile,
        "distance_km": round(best["distance_m"] / 1000, 1),
        "duration_min": round(best["duration_s"] / 60),
        "traffic_delay_min": round(best.get("traffic_delay_s", 0) / 60),
        "avoid": avoid,
        "depart_at": depart_at,
        "arrive_at": arrive_at,
        "departure_time": _clock(best.get("departure_time")),
        "arrival_time": _clock(best.get("arrival_time")),
        "jams": sum(1 for s in best.get("traffic_sections", []) if s["category"] == "jam"),
        "weather_status": best["weather"]["status"],
        "rain": _rain(best),
        "steps": [m["instruction"] for m in best["maneuvers"]][:MAX_STEPS],
    }


def _point(place: dict[str, Any], point_id: str) -> dict[str, Any]:
    return {"id": point_id, "label": place["label"], "lat": place["lat"], "lon": place["lon"]}


def preview_find_place(output: dict[str, Any]) -> dict[str, Any]:
    places = output["places"]
    lats = [p["lat"] for p in places]
    lons = [p["lon"] for p in places]
    if min(lats) == max(lats) and min(lons) == max(lons):
        view: dict[str, Any] = {"center": {"lat": lats[0], "lon": lons[0]}, "zoom": 15}
    else:
        view = {"bbox": [min(lons), min(lats), max(lons), max(lats)]}
    return {
        "type": "map",
        "title": places[0]["label"].upper()[:40],
        "data": {"points": [_point(p, f"p{i}") for i, p in enumerate(places)], "map": view},
    }


def preview_get_directions(output: dict[str, Any]) -> dict[str, Any]:
    stops = [output["from"], *output["via"], output["to"]]
    last = len(stops) - 1
    ids = ["A" if i == 0 else "B" if i == last else f"V{i}" for i in range(len(stops))]
    route: dict[str, Any] = {
        "profile": output["profile"],
        "waypoints": [{"lat": s["lat"], "lon": s["lon"], "label": s["label"]} for s in stops],
    }
    if output.get("avoid"):
        route["avoid"] = output["avoid"]
    for key in ("depart_at", "arrive_at"):
        if output.get(key):
            route[key] = output[key]
    return {
        "type": "map",
        "title": "CHỈ ĐƯỜNG",
        "data": {
            "points": [_point(s, ids[i]) for i, s in enumerate(stops)],
            "map": {"route": route},
        },
    }
