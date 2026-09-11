"""SSE wire-format serializer — domain event -> SSE frame."""

import json
from datetime import datetime, timezone
from typing import Any


def sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


def serialize(event: str, payload: dict[str, Any]) -> str:
    """Alias that matches the guide's `Serializer` concept."""
    return sse(event, payload)


def sse_envelope(
    run_id: str | None,
    session_id: str | None,
    turn_id: str,
    sequence: int,
    event: str,
    payload: dict[str, Any],
) -> str:
    """P0.2 §2 — FRIDAY_EVENTS_V2 wire form (contracts/events.v1.json)."""
    body = {
        "version": 1,
        "run_id": run_id,
        "session_id": session_id,
        "turn_id": turn_id,
        "sequence": sequence,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "event": event,
        "payload": payload,
    }
    return f"event: {event}\ndata: {json.dumps(body)}\n\n"
