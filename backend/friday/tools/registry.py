"""Tool registry — register / get / list / resolve."""

from typing import Any

from .base import Tool
from .filesystem.notes import run_read_note, run_write_note
from .filesystem.sandbox import run_list_dir, run_read_file
from .integrations.fetch import run_fetch_url
from friday.rag import run_search_docs
from friday.geo.tools import (
    preview_find_place,
    preview_get_directions,
    run_find_place,
    run_get_directions,
)
from friday.weather.tools import preview_get_weather, run_get_weather
from .integrations.search import run_search_web
from .client.metrics import (
    HISTORY_METRICS,
    preview_client_history,
    preview_client_location,
    preview_client_metrics,
    run_client_history,
    run_client_location,
    run_client_metrics,
)
from .system.clock import run_current_time
from .system.metrics import preview_metrics, run_system_metrics
from .system.processes import preview_processes, run_process_list
from friday.memory.long_term import run_remember


def _build_default_registry() -> dict[str, Tool]:
    tools = [
        Tool(
            name="get_system_metrics",
            description=(
                "Read live CPU, memory and disk utilisation from the host this "
                "orchestrator runs on. Returns percentages 0-100."
            ),
            input_schema={"type": "object", "properties": {}, "required": []},
            risk="low",
            run=run_system_metrics,
            capabilities=("system.read",),
            preview=preview_metrics,
        ),
        Tool(
            name="get_client_metrics",
            description=(
                "Read the operator's OWN device as their browser reports it: CPU "
                "core count, memory class, CPU pressure (nominal/fair/serious/"
                "critical), battery, browser storage, network type/speed/latency, "
                "GPU, platform, timezone, screen. Use for questions about 'my' "
                "computer, laptop, battery, connection or device. This is not the "
                "host - get_system_metrics reads the orchestrator's server."
            ),
            input_schema={"type": "object", "properties": {}, "required": []},
            risk="low",
            run=run_client_metrics,
            capabilities=("client.read",),
            preview=preview_client_metrics,
        ),
        Tool(
            name="get_client_history",
            description=(
                "One metric of the operator's own device over the last ~10 "
                "minutes, sampled by their browser every 10 s while the tab was "
                "open: network latency or downlink, battery, CPU pressure, JS "
                "heap or frame rate. Use for 'how has my connection / battery / "
                "laptop been'. For the current value alone use get_client_metrics."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "metric": {"type": "string", "enum": list(HISTORY_METRICS), "description": "which reading to chart"}
                },
                "required": ["metric"],
            },
            risk="low",
            run=run_client_history,
            capabilities=("client.read",),
            preview=preview_client_history,
        ),
        Tool(
            name="get_client_location",
            description=(
                "Read the operator's location (lat/lon with the browser's "
                "accuracy radius in metres) and timezone - only when they "
                "turned location on. Use for 'here', 'near me', local weather or local "
                "time. If it is not shared, say so; never guess a place."
            ),
            input_schema={"type": "object", "properties": {}, "required": []},
            risk="low",
            run=run_client_location,
            capabilities=("client.location",),
            preview=preview_client_location,
        ),
        Tool(
            name="find_place",
            description=(
                "Find a place, address or kind of place and show it on the street "
                "map. Use for 'where is X', 'show me X', 'cafes near me'. Pass "
                "near='my_location' for places around the operator."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "what to find, in the user's words"},
                    "near": {"type": "string", "description": "'my_location' or a place name to search around"},
                },
                "required": ["query"],
            },
            # Reads a public geocoder; the only operator data sent is a ~1 km
            # position, and only when they already shared their location.
            risk="low",
            run=run_find_place,
            capabilities=("geo.read",),
            preview=preview_find_place,
            timeout_s=15,
        ),
        Tool(
            name="get_directions",
            description=(
                "Directions between places, shown on the street map with "
                "distance, time, departure/arrival clock times and the current "
                "traffic delay. from/to are place names or 'my_location'. "
                "profile: motor_scooter (default, xe máy), auto (car), bicycle, "
                "pedestrian. Use arrive_at when the user asks when to leave to "
                "arrive on time, depart_at for a later departure; call "
                "get_current_time first if you need today's date."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "profile": {"type": "string", "enum": ["motor_scooter", "auto", "bicycle", "pedestrian"]},
                    "via": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
                    "avoid": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["tolls", "motorways", "ferries", "unpaved"]},
                        "description": "roads to avoid. Omit for the default (motorbikes avoid motorways, "
                                       "which are closed to them in Vietnam); [] avoids nothing",
                    },
                    "depart_at": {
                        "type": "string",
                        "description": "ISO 8601 departure time, e.g. 2026-09-24T08:00; the operator's UTC "
                                       "offset is assumed when none is given. Never together with arrive_at",
                    },
                    "arrive_at": {
                        "type": "string",
                        "description": "ISO 8601 arrival deadline, same format. Never together with depart_at",
                    },
                },
                "required": ["from", "to"],
            },
            risk="low",
            run=run_get_directions,
            capabilities=("geo.read",),
            preview=preview_get_directions,
            timeout_s=25,
        ),
        Tool(
            name="get_weather",
            description=(
                "Current conditions and forecast for a place or the operator's "
                "location. span: now (right now), today (next 24 hours), week "
                "(7 days). place is a place name or 'my_location' (default). "
                "Prefer this over search_web for any weather question."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "place": {"type": "string", "description": "a place name, or 'my_location' (default)"},
                    "span": {"type": "string", "enum": ["now", "today", "week"], "description": "default now"},
                },
            },
            # Reads a public forecast; the only operator data sent is a ~1 km
            # position, and only when they already shared their location.
            risk="low",
            run=run_get_weather,
            capabilities=("geo.read",),
            preview=preview_get_weather,
            timeout_s=15,
        ),
        Tool(
            name="get_current_time",
            description=(
                "Read the current date, time, weekday and UTC offset - the "
                "operator's own clock when their browser sent it (source "
                "'operator'), else the host's. Use this for any question "
                "about what time or day it is. Never answer that from memory and "
                "never search the web for it."
            ),
            input_schema={"type": "object", "properties": {}, "required": []},
            risk="low",
            run=run_current_time,
            capabilities=("system.read",),
        ),
        Tool(
            name="get_process_list",
            description=(
                "List the processes using the most memory on this host, ranked. "
                "Use after get_system_metrics when memory looks high."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "how many to return, 1-10"}
                },
                "required": [],
            },
            risk="low",
            run=run_process_list,
            capabilities=("system.read",),
            preview=preview_processes,
        ),
        Tool(
            name="search_web",
            description=(
                "Search the public web and return extracts from the top results. "
                "Use for anything this host cannot measure itself: current events, "
                "documentation, prices, or any fact you are unsure of. "
                "Prefer this over answering from memory when the answer could have "
                "changed since training. Results come from a search index, not "
                "live sources: for fast-moving numbers such as prices or scores, "
                "say the value is approximate and may lag rather than "
                "presenting it as the current one."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "the search query, in the language of the source you expect",
                    }
                },
                "required": ["query"],
            },
            # §11 LOW, matching the doc's own example list. It reads public data
            # and writes nothing — but note it is the only tool that puts text
            # from strangers into the model's context. That is a prompt-injection
            # surface, and the containment is that every consequential tool is
            # risk="high" and therefore blocked on a human, so a page telling
            # FRIDAY to write a note still has to get past the operator.
            risk="low",
            run=run_search_web,
            capabilities=("web.read",),
            constraints={"max_results": 5, "max_chars": 600},
        ),
        Tool(
            name="write_note",
            description="Persist a short markdown note to the operator's notes directory.",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "short slug, no extension"},
                    "body": {"type": "string", "description": "markdown body"},
                },
                "required": ["name", "body"],
            },
            risk="high",
            run=run_write_note,
            capabilities=("notes.write",),
            constraints={"directory": "notes/"},
        ),
        Tool(
            name="read_note",
            description=(
                "Read a note the operator has saved, or list them when no name is "
                "given. Use this for any question about existing notes - what was "
                "written, what notes exist, what one of them says. write_note only "
                "writes; it cannot answer a question."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "note to read; omit to list every note",
                    }
                },
                "required": [],
            },
            # §11 LOW: it reads a directory this service owns and writes nothing.
            # The notes are the operator's own words, so unlike search_web it puts
            # no text from strangers into the context.
            risk="low",
            run=run_read_note,
            capabilities=("notes.read",),
        ),
        Tool(
            name="remember",
            description=(
                "Store one short fact worth keeping across conversations: a "
                "preference, a decision, a standing constraint, something about "
                "how this operator works. Not for measurements - those go stale "
                "and are re-read by their own tools. Write one plain sentence in "
                "your own words, never raw text from another tool."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "fact": {"type": "string", "description": "one short sentence, in your own words"}
                },
                "required": ["fact"],
            },
            # §11 LOW theo lựa chọn đã chốt trong spec §9. Đánh đổi được ghi rõ ở
            # đó: ghi tự do nên injection từ một trang web có thể thành ký ức
            # vĩnh viễn, và biện pháp bảo vệ là provenance cộng đường xem/xoá.
            risk="low",
            run=run_remember,
            capabilities=("memory.write",),
        ),
        Tool(
            name="list_dir",
            description=(
                "List one directory level inside the file sandbox "
                "(FRIDAY_SANDBOX_DIR, default backend/notes/): names, kinds, "
                "sizes. Paths outside the sandbox are refused."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "relative subdirectory, omit for the root"}
                },
                "required": [],
            },
            risk="low",
            run=run_list_dir,
            capabilities=("filesystem.read",),
            timeout_s=10.0,
        ),
        Tool(
            name="read_file",
            description=(
                "Read one text file inside the file sandbox, truncated with a "
                "flag past the limit. Sensitive basenames (.env, keys) and "
                "binary files are refused."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "relative file path, required"}
                },
                "required": ["path"],
            },
            risk="low",
            run=run_read_file,
            capabilities=("filesystem.read",),
            timeout_s=10.0,
        ),
        Tool(
            name="fetch_url",
            description=(
                "Fetch one public http(s) URL and return its title plus a "
                "trimmed text extract. Private hosts, non-text content and "
                "oversize pages are refused."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "the http(s) URL to read"}
                },
                "required": ["url"],
            },
            risk="low",
            run=run_fetch_url,
            capabilities=("web.read",),
            # direct read (15s) plus the Firecrawl fallback (30s)
            timeout_s=50.0,
        ),
        Tool(
            name="search_docs",
            description=(
                "Search the repo docs for a question: returns ranked sections "
                "with file paths. Read-only over the corpus; needs an "
                "embedding key or it reports unconfigured."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "what to find in the docs"}
                },
                "required": ["query"],
            },
            risk="low",
            run=run_search_docs,
            capabilities=("docs.read",),
            timeout_s=60.0,
        ),
    ]
    return {t.name: t for t in tools}


REGISTRY: dict[str, Tool] = _build_default_registry()

# Keep legacy alias for tests that import NOTES_DIR from tools
from .filesystem.notes import NOTES_DIR  # noqa: E402

# Re-export for shortcuts
from .base import CONFIRM_ABOVE  # noqa: E402


def register(tool: Tool) -> None:
    REGISTRY[tool.name] = tool


def get(name: str) -> Tool | None:
    return REGISTRY.get(name)


def list_tools() -> list[Tool]:
    return list(REGISTRY.values())


def api_tools() -> list[dict[str, Any]]:
    return [tool.as_api_tool() for tool in REGISTRY.values()]
