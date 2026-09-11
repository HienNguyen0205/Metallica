"""P1.7/P1.8 — policy engine and capability-based tool security.

Every tool call passes evaluate() before it runs. The decision is computed
from server-side declarations only: the model can neither set a tool's risk
nor grant itself capabilities (risk is stripped from the API schema, and any
risk/decision keys smuggled inside arguments are ignored).

Decisions: allow (run it), ask_human (existing confirm flow), step_up (human
approval with constraints attached — same UX as ask_human today, separated
for audit), deny (refused without bothering the operator).

Capabilities (P1.8) replace the bare low/high split as the permission unit:
each tool declares what it needs, each session is granted a set, and a call
needing more than granted is denied. Sensitive capabilities (permanent writes)
escalate even when the tool itself is low-risk.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

Decision = Literal["allow", "deny", "ask_human", "step_up"]

#: Capabilities whose use always escalates to a human, regardless of the
#: tool's own risk level (permanent writes, including model-written memory).
SENSITIVE_CAPABILITIES: frozenset[str] = frozenset({"memory.write", "notes.write"})


@dataclass(frozen=True)
class PolicyDecision:
    tool: str
    decision: Decision
    reason: str
    constraints: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PolicyContext:
    """Everything evaluate() may look at. session_id is recorded for audit;
    per-session grants arrive with P3 identity — until then grants are global."""

    session_id: str | None = None
    granted_capabilities: frozenset[str] = frozenset({"*"})
    environment: str = "local"


def _validate_args(tool: Any, payload: dict[str, Any]) -> str | None:
    """Required-field + basic-type check against the tool's input schema.
    Returns an error string, or None when the arguments are acceptable."""
    schema = tool.input_schema or {}
    required = schema.get("required") or []
    properties = schema.get("properties") or {}
    for name in required:
        if name not in payload:
            return f"missing required argument {name!r}"
    for name, value in payload.items():
        want = (properties.get(name) or {}).get("type")
        if want == "string" and not isinstance(value, str):
            return f"argument {name!r} must be a string"
        if want == "integer" and not isinstance(value, int):
            return f"argument {name!r} must be an integer"
        if want == "number" and not isinstance(value, (int, float)):
            return f"argument {name!r} must be a number"
        if want == "boolean" and not isinstance(value, bool):
            return f"argument {name!r} must be a boolean"
    return None


def evaluate(
    tool: Any | None,
    tool_name: str,
    payload: dict[str, Any],
    ctx: PolicyContext | None = None,
) -> PolicyDecision:
    """The single gate. Unknown tools and capability overreach are denied;
    high risk asks a human; sensitive capabilities step up; the rest runs."""
    ctx = ctx or PolicyContext()
    if tool is None:
        return PolicyDecision(tool_name, "deny", "unknown tool", {})

    bad_args = _validate_args(tool, payload)
    if bad_args is not None:
        return PolicyDecision(tool.name, "deny", bad_args, {})

    required = set(getattr(tool, "capabilities", ()) or ())
    granted = ctx.granted_capabilities
    if "*" not in granted:
        missing = sorted(required - set(granted))
        if missing:
            return PolicyDecision(
                tool.name, "deny", f"missing capabilities: {', '.join(missing)}", {}
            )

    if tool.risk == "high":
        return PolicyDecision(tool.name, "ask_human", f"high-risk tool {tool.name}", {})

    sensitive = sorted(required & set(SENSITIVE_CAPABILITIES))
    if sensitive:
        return PolicyDecision(
            tool.name,
            "step_up",
            f"sensitive capabilities: {', '.join(sensitive)}",
            {"capabilities": sensitive},
        )

    return PolicyDecision(tool.name, "allow", "low-risk within granted capabilities", {})


def default_context(session_id: str | None = None) -> PolicyContext:
    """Granted set from FRIDAY_GRANTED_CAPABILITIES (comma-separated, "*" = all).
    Live env wins; the central Settings value is the fallback."""
    import os

    raw = os.getenv("FRIDAY_GRANTED_CAPABILITIES")
    if raw is None:
        try:
            from friday.core.config import settings

            raw = settings.granted_capabilities
        except Exception:
            raw = "*"
    granted = frozenset(c.strip() for c in raw.split(",") if c.strip())
    return PolicyContext(session_id=session_id, granted_capabilities=granted or frozenset({"*"}))
