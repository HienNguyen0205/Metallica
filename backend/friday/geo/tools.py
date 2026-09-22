"""find_place / get_directions (spec §6.4) — read-only: geo.read, low risk.

Each returns an error dict rather than raising, like every other tool, and a
`map` preview that the orchestrator passes through unchanged (routes.py).
"""

from typing import Any

from friday.tools.client.metrics import CLIENT

from . import graphhopper, maptiler

MY_LOCATION = "my_location"
MAX_STEPS = 8
NO_LOCATION = {"error": "the operator has not shared their location"}


def _operator() -> tuple[float, float] | None:
    loc = (CLIENT.get() or {}).get("location")
    return (loc["lat"], loc["lon"]) if loc else None


def _is_me(ref: Any) -> bool:
    return str(ref).strip().lower() == MY_LOCATION


async def _first(query: str, near: tuple[float, float] | None) -> dict[str, Any] | None:
    # Looked up on the module so tests can swap maptiler.search.
    hits = await maptiler.search(query, near=near, limit=1)
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
                return {"error": f"no place matches '{near_ref}'"}
            near = (anchor["lat"], anchor["lon"])
        places = await maptiler.search(query, near=near)
    except maptiler.GeocodeUnavailable as err:
        return {"error": f"place search unavailable: {err}"}
    if not places:
        return {"error": f"no place matches '{query}'"}
    return {"places": places}


async def run_get_directions(payload: dict[str, Any]) -> dict[str, Any]:
    profile = payload.get("profile") or graphhopper.default_profile()
    if profile not in graphhopper.PROFILE_ORDER:
        return {"error": f"unknown profile '{profile}'"}
    if profile not in graphhopper.available_profiles():
        # Checked before any geocoding so no credits are spent on a refusal.
        return {"error": "motorbike directions need a GraphHopper plan with the scooter profile; use auto, bicycle or pedestrian"}
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
                return {"error": f"no place matches '{ref}'"}
            stops.append(place)
        # Looked up on the module so tests can swap graphhopper.route.
        result = await graphhopper.route([{"lat": s["lat"], "lon": s["lon"]} for s in stops], profile)
    except maptiler.GeocodeUnavailable as err:
        return {"error": f"place search unavailable: {err}"}
    except graphhopper.RoutingUnavailable:
        return {"error": "routing is not configured on this server (or today's credits are used up)"}
    except graphhopper.NoRoute:
        return {"error": "no route found between these places"}
    except graphhopper.UnsupportedProfile:
        return {"error": "this travel mode is not available on the routing plan"}
    best = result["routes"][0]
    return {
        "from": stops[0],
        "to": stops[-1],
        "via": stops[1:-1],
        "profile": profile,
        "distance_km": round(best["distance_m"] / 1000, 1),
        "duration_min": round(best["duration_s"] / 60),
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
    return {
        "type": "map",
        "title": "CHỈ ĐƯỜNG",
        "data": {
            "points": [_point(s, ids[i]) for i, s in enumerate(stops)],
            "map": {"route": {
                "profile": output["profile"],
                "waypoints": [{"lat": s["lat"], "lon": s["lon"], "label": s["label"]} for s in stops],
            }},
        },
    }
