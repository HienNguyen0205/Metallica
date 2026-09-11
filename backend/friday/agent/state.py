"""Agent state — for future multi-turn / memory integration."""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentResult:
    text: str
    evidence: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class AgentEvent:
    kind: str
    payload: dict[str, Any] = field(default_factory=dict)
