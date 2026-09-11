"""Tool registry — register / get / list / resolve."""

from typing import Any

from .base import Tool
from .filesystem.notes import run_read_note, run_write_note
from .integrations.search import run_search_web
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
            preview=preview_metrics,
        ),
        Tool(
            name="get_current_time",
            description=(
                "Read the clock on the host this orchestrator runs on: current "
                "date, time, weekday and UTC offset. Use this for any question "
                "about what time or day it is. Never answer that from memory and "
                "never search the web for it."
            ),
            input_schema={"type": "object", "properties": {}, "required": []},
            risk="low",
            run=run_current_time,
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
            preview=preview_processes,
        ),
        Tool(
            name="search_web",
            description=(
                "Search the public web and return extracts from the top results. "
                "Use for anything this host cannot measure itself: current events, "
                "documentation, prices, weather, or any fact you are unsure of. "
                "Prefer this over answering from memory when the answer could have "
                "changed since training. Results come from a search index, not "
                "live sources: for fast-moving numbers such as prices, scores or "
                "weather, say the value is approximate and may lag rather than "
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
