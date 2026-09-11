"""Permission / risk logic — separated from tool implementations."""

from typing import Literal

RiskLevel = Literal["low", "medium", "high"]

LOW: Literal["low"] = "low"
MEDIUM: Literal["medium"] = "medium"
HIGH: Literal["high"] = "high"
DENY: Literal["deny"] = "deny"  # reserved for future blocklist

CONFIRM_ABOVE: set[RiskLevel] = {"high"}


def needs_confirmation(risk: RiskLevel) -> bool:
    return risk in CONFIRM_ABOVE


def is_allowed(risk: RiskLevel, approved: bool | None = None) -> bool:
    """Low/medium always allowed; high requires explicit approval."""
    if risk not in CONFIRM_ABOVE:
        return True
    return approved is True
