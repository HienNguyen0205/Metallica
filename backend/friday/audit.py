"""Audit log (P3): who did what, to which run, with what verdict.

Append-only in-memory ring (newest evicts oldest past the cap; entries are
never mutated). Actions covered: run lifecycle, tool execution, policy
denials, approval requested/granted/denied/timeout, memory created/deleted,
run cancellation, authentication (identity resolutions that yield a user).

No secrets, ever: values under secret-shaped keys are redacted, long strings
are trimmed, and tool arguments are logged by key NAME only — what ran and
how it was decided, not the data it touched.
"""

import re
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any

#: Past this many entries the oldest fall off. Sized for forensics on a
#: single process, not for compliance archiving (that needs a real sink).
MAX_ENTRIES = 1000

#: Values under these keys never reach the log.
_SECRET_KEYS = re.compile(r"key|secret|token|password|authoriz|credential", re.I)

_buffer: deque = deque(maxlen=MAX_ENTRIES)
_lock = threading.Lock()
_seq = 0


def scrub(value: Any, max_chars: int = 200) -> Any:
    """Redact secret-shaped mapping keys and trim long strings. Passes
    anything else through untouched (numbers, bools, None, short strings)."""
    if isinstance(value, dict):
        return {k: ("[redacted]" if _SECRET_KEYS.search(str(k)) else scrub(v, max_chars))
                for k, v in value.items()}
    if isinstance(value, str):
        return value if len(value) <= max_chars else value[:max_chars] + "…"
    return value


def record(action: str, *, actor: str | None = None, run_id: str | None = None,
           target: str | None = None, decision: str | None = None,
           reason: str | None = None, details: dict[str, Any] | None = None) -> dict:
    """Append one entry. Returns it (handy for tests)."""
    from friday import observability

    global _seq
    with _lock:
        _seq += 1
        entry = {
            "seq": _seq,
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "trace_id": observability.trace_id_var.get(),
            "action": action,
            "actor": actor,
            "run_id": run_id,
            "target": target,
            "decision": decision,
            "reason": reason,
            "details": scrub(details or {}),
        }
        _buffer.append(entry)
        return dict(entry)


def recent(limit: int = 100, run_id: str | None = None) -> list[dict]:
    """Newest-first read with an optional run filter. Operators only."""
    with _lock:
        entries = list(_buffer)
    if run_id is not None:
        entries = [e for e in entries if e.get("run_id") == run_id]
    return [dict(e) for e in reversed(entries[-max(1, min(limit, 500)):])]


def clear() -> None:
    """Tests only."""
    global _seq
    with _lock:
        _buffer.clear()
        _seq = 0
