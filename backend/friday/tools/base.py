"""Minimal tool abstraction — no framework, just a contract."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

RiskLevel = Literal["low", "medium", "high"]

Preview = Callable[[dict[str, Any]], dict[str, Any]]

CONFIRM_ABOVE: set[RiskLevel] = {"high"}


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    risk: RiskLevel
    run: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
    preview: Preview | None = None
    #: Per-tool ceiling in seconds (None = unbounded; the run wall-time still
    #: applies). Wire unit is timeout_ms in contracts/tool/tool.v1.json.
    timeout_s: float | None = None
    #: Serialized output cap in bytes (None = uncapped). Overruns are replaced
    #: with a truncated marker, never passed whole to the model.
    max_output_bytes: int | None = None

    def needs_confirmation(self) -> bool:
        return self.risk in CONFIRM_ABOVE

    def as_api_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }
