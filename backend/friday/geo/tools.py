"""find_place / get_directions (spec §6.4) — read-only: geo.read, low risk.

Each returns an error dict rather than raising, like every other tool, and a
`map` preview that the orchestrator passes through unchanged (routes.py).
"""

import re
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
#: Words that say which kind of place or admin level, not which place —
#: Vietnamese, and the English the model writes when it translates an address
#: ("10 Pham Van Bach Street"). Compared without diacritics, so "quan" is "quận".
FILLER = {
    "so", "duong", "pho", "ngo", "hem", "kiet", "quan", "huyen", "phuong", "xa", "thi", "tran", "thanh", "tp", "tinh",
    "no", "street", "st", "road", "rd", "avenue", "ave", "lane", "alley", "district", "ward", "city", "province",
}
#: Tone marks only: toà and tòa are one word, but lăng (breve) is not lãng.
TONE_MARKS = "\u0300\u0301\u0303\u0309\u0323"


def _words(text: str) -> list[str]:
    return re.findall(r"\w+", unicodedata.normalize("NFC", text).lower())


def _plain(word: str, every_mark: bool) -> str:
    """Tone marks off; with every_mark, all marks off and đ → d."""
    kept = "".join(c for c in unicodedata.normalize("NFD", word)
                   if not (unicodedata.combining(c) and (every_mark or c in TONE_MARKS)))
    kept = unicodedata.normalize("NFC", kept)
    return kept.replace("đ", "d") if every_mark else kept


def _street_name(text: str) -> str | None:
    """"Đường Trần Thị Năm" → "trần thị năm"; None when no street is named."""
    words = _words(text)
    return " ".join(words[1:]) if len(words) > 1 and words[0] in STREET_WORDS else None


def _names_street(asked: str, hit: dict[str, Any]) -> bool:
    """The hit is the asked street; words after its name ("… quận 12") are fine."""
    street = _street_name(hit["label"].split(",")[0])
    return bool(street) and (asked == street or asked.startswith(street + " "))


def _name_words(text: str) -> list[str]:
    """The words that name something: no numbers, no kind-of-place or admin words."""
    return [w for w in _words(text) if _plain(w, True) not in FILLER and not w.isdigit()]


def _name_rank(query: str, hit: dict[str, Any]) -> tuple[int, int] | None:
    """How well the hit is named by the query — lower is better, None when it is not.

    Only the query's first comma part names the place ("10 Phạm Văn Bạch, Cầu
    Giấy": TomTom addresses often skip the district). Tiers: 0 the hit's name
    is exactly that; 1 its name holds every word (plus extras, counted
    second); 2 the words are only found by adding its address — the weakest,
    since a ward can share a name ("Trường Đại Học Mở", ward Bách Khoa).
    A query typed without diacritics is compared without them.
    """
    asked_raw = _name_words(query.split(",")[0])
    bare = all(_plain(w, True) == w for w in asked_raw)
    asked = [_plain(w, bare) for w in asked_raw]
    name = [_plain(w, bare) for w in _name_words(hit["label"].split(",")[0])]
    if name == asked:
        return (0, 0)
    if all(w in name for w in asked):
        return (1, len(name) - len(asked))
    have = set(name) | {_plain(w, bare) for w in _words(f"{hit['label']} {hit.get('address', '')}")}
    return (2, 0) if all(w in have for w in asked) else None


#: How addresses name the two big cities, squashed (see _squash).
CITY_ALIASES = {"hcm": "hochiminh", "hcmc": "hochiminh", "saigon": "hochiminh", "hn": "hanoi"}


def _squash(text: str) -> str:
    """No diacritics, filler, numbers or spaces: "TP.HCM" and "Hồ Chí Minh" meet."""
    words = (_plain(w, True) for w in _words(text))
    joined = "".join(w for w in words if w not in FILLER and not w.isdigit())
    return CITY_ALIASES.get(joined, joined)


def _in_area(query: str, hit: dict[str, Any]) -> bool:
    """A later part of the query ("…, Hà Nội") names the hit's area, if any part names one."""
    areas = [a for a in (_squash(part) for part in query.split(",")[1:]) if a]
    if not areas:
        return True
    have = _squash(f"{hit['label']} {hit.get('address', '')}")
    return any(a in have for a in areas)


def no_match(ref: str) -> dict[str, str]:
    # Worded as final: a missing place used to send the model hunting through
    # spellings and find_place until MAX_TURNS. What works is one retry with a
    # name TomTom knows: the official one ("FPT Information System", not "FPT
    # IS") or the street address search_web finds.
    return {"error": (f"no place matches '{ref}' in the map data. Retry once with its full official name "
                      "(e.g. 'Lăng Chủ tịch Hồ Chí Minh' for 'lăng bác') or, from search_web, its street "
                      "address in Vietnamese as the source writes it; otherwise tell the operator. "
                      "Do not retry other spellings.")}


async def _search(
    query: str, near: tuple[float, float] | None, limit: int = 5, country: str | None = None,
) -> list[dict[str, Any]]:
    # Looked up on the module so tests can swap tomtom.search.
    hits = await tomtom.search(query, near=near, limit=limit, country=country)
    asked = _street_name(query.split(",")[0])
    if asked is None:
        return hits
    # Fuzzy search always answers something: for a street missing from the map
    # data it offers a near-namesake ("Trần Thị Hè" for "Trần Thị Năm") or a
    # shop. A named street must match by name, or it is not found.
    # ponytail: only "<street word> <name> …" is checked; "123 đường X" keeps
    # every hit — strip a leading house number if that needs it too.
    return [h for h in hits if _names_street(asked, h)]


#: Road trips start and end in Vietnam: an exact namesake abroad
#: ("FPT Information System" in Phnom Penh, 227 km from Q12) must not win.
#: Weather and find_place still look anywhere ("thời tiết Tokyo").
DIRECTIONS_COUNTRY = "VN"
#: A destination looks deeper than find_place's list: the right hit can sit
#: 7th behind namesakes ("Đại học Bách Khoa Hà Nội"). Still one request.
DESTINATION_HITS = 10


async def _first(
    query: str, near: tuple[float, float] | None, country: str | None = None,
) -> dict[str, Any] | None:
    """A destination: the hit the query names best ("FPT IS" is not "Fpt Shop").

    find_place does not use this — "quán cà phê gần tôi" names a kind of place.
    A nickname ("lăng bác") names nothing here; no_match sends the model back
    with the official name, which it knows.
    """
    def best(hits: list[dict[str, Any]], in_area: bool) -> dict[str, Any] | None:
        ranked = [(rank, i, h) for i, h in enumerate(hits)
                  if (rank := _name_rank(query, h)) is not None and (not in_area or _in_area(query, h))]
        return min(ranked, key=lambda r: r[:2])[2] if ranked else None

    biased = await _search(query, near, DESTINATION_HITS, country)
    hit = best(biased, in_area=True)
    if hit is None and near is not None:
        # The operator's position pulls results toward their own city: from
        # Q12 the top 10 for "…, Hà Nội" or "Lăng Chủ tịch Hồ Chí Minh" are all
        # in HCMC. A miss is looked up once more without it; only misses pay.
        unbiased = await _search(query, None, DESTINATION_HITS, country)
        # The area is a preference, not a rule: TomTom addresses often skip
        # the district ("…, Cầu Giấy"), so a name match still stands.
        hit = best(unbiased, in_area=True) or best(unbiased, in_area=False)
    return hit or best(biased, in_area=False)


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
            place = await _first(str(ref), me, DIRECTIONS_COUNTRY)
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
