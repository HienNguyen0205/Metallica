"""§22 — the gate on /query: origin check and the two rate-limit windows.

    PYTHONPATH=. python tests/unit/test_guard.py
"""

import asyncio
import os
import time
from types import SimpleNamespace

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"
os.environ["FRIDAY_RATE_LIMIT_PER_HOUR"] = "3"
os.environ["FRIDAY_GLOBAL_LIMIT_PER_HOUR"] = "5"

from fastapi import HTTPException

from friday.api import dependencies as deps


def request(ip: str = "1.1.1.1", origin: str | None = None) -> SimpleNamespace:
    headers = {"x-forwarded-for": ip}
    if origin is not None:
        headers["origin"] = origin
    return SimpleNamespace(headers=headers, client=SimpleNamespace(host="10.0.0.1"))


def call(req) -> int | None:
    """Status code the guard refused with, or None when it let the call through."""
    try:
        asyncio.run(deps.guard(req))
        return None
    except HTTPException as err:
        return err.status_code


def test_origin():
    deps.reset()
    assert call(request(origin="http://localhost:3000")) is None, "allowlisted origin must pass"
    assert call(request(origin="https://evil.example")) == 403, "foreign origin must be refused"
    # No Origin at all is curl or another service, not a cross-site page. It
    # passes here and is left to the rate limit below.
    assert call(request()) is None, "a request without Origin must not 403"

    # An Origin header never has a trailing slash, so pasting one into the
    # config would 403 every question with nothing in the logs to say why.
    deps.reset()
    os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000/"
    try:
        assert call(request(origin="http://localhost:3000")) is None, "config must tolerate a trailing slash"
    finally:
        os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"


def test_per_client_limit():
    deps.reset()
    for i in range(3):
        assert call(request("2.2.2.2")) is None, f"call {i} is inside the limit of 3"
    assert call(request("2.2.2.2")) == 429, "the fourth call exceeds the per-client limit"
    # A different caller has its own window — one visitor cannot lock out the rest.
    assert call(request("3.3.3.3")) is None


def test_global_limit():
    deps.reset()
    # Five distinct callers, each well inside its own limit of 3, still hit the
    # global cap of 5 — this is the one that holds when X-Forwarded-For is forged.
    for i in range(5):
        assert call(request(f"4.4.4.{i}")) is None
    assert call(request("4.4.4.99")) == 429, "global cap must bind across callers"


def test_refused_call_is_not_charged():
    deps.reset()
    for i in range(5):
        assert call(request(f"5.5.5.{i}")) is None  # global window now full
    fresh = "6.6.6.6"
    assert call(request(fresh)) == 429
    # The global cap refused it, so the fresh caller's own budget is untouched:
    # expiring the global window must leave all 3 of its calls available.
    deps._global.clear()
    for i in range(3):
        assert call(request(fresh)) is None, f"call {i} — global refusal must not consume client budget"


def test_window_expires():
    deps.reset()
    for _ in range(3):
        call(request("7.7.7.7"))
    assert call(request("7.7.7.7")) == 429
    # Age every recorded hit past the window rather than sleeping an hour.
    old = time.monotonic() - deps.WINDOW_S - 1
    for bucket in (*deps._hits.values(), deps._global):
        for i in range(len(bucket)):
            bucket[i] = old
    assert call(request("7.7.7.7")) is None, "the window must slide, not latch"


def test_client_table_is_bounded():
    deps.reset()
    for i in range(deps.MAX_CLIENTS + 50):
        deps._bucket(f"client-{i}")
    assert len(deps._hits) == deps.MAX_CLIENTS, "an unbounded table is a memory-exhaustion path"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all guard tests passed")
