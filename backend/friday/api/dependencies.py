"""Shared API dependencies / state."""

import asyncio
import time
from collections import OrderedDict, deque

from fastapi import HTTPException, Request

from friday.core.config import settings

# §11 — in-flight approval requests, keyed by per-request id.
PENDING: dict[str, asyncio.Future[bool]] = {}

CONFIRM_TIMEOUT_S = 120

#: §22 — sliding window for both caps below.
WINDOW_S = 3600.0

#: Callers tracked at once, least-recently-seen evicted first. The key derives
#: from a header the caller controls, so an unbounded dict here is a way to
#: exhaust the server's memory with a loop of forged addresses — the same
#: reason `memory.py` caps sessions.
MAX_CLIENTS = 1000

_hits: OrderedDict[str, deque[float]] = OrderedDict()
_global: deque[float] = deque()


def require_known_origin(request: Request) -> None:
    """Reject a browser sending us someone else's page.

    The CORS middleware is not this check. CORS stops the *browser* from
    reading a cross-origin response, which happens after the handler has run —
    on `/query` that means the model calls were made and paid for, and only the
    answer was thrown away. Refusing the request up front is what actually
    protects the quota.

    A request with no `Origin` at all (curl, a health prober, another service)
    passes here and is left to the rate limit; there is nothing to check
    against and rejecting it would break every non-browser caller.
    """
    origin = request.headers.get("origin")
    if origin and origin not in settings.allowed_origins:
        raise HTTPException(status_code=403, detail="origin not allowed")


def _client(request: Request) -> str:
    # Behind Render/Vercel the peer address is their proxy, which would file
    # every visitor under one key. `X-Forwarded-For` carries the caller, and is
    # trivially forged — so this only separates honest callers from each other.
    # The global cap is what holds when someone rotates the header.
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def _bucket(key: str) -> deque[float]:
    bucket = _hits.get(key)
    if bucket is None:
        bucket = _hits[key] = deque()
    _hits.move_to_end(key)
    while len(_hits) > MAX_CLIENTS:
        _hits.popitem(last=False)
    return bucket


def _retry_after(bucket: deque[float], limit: int, now: float) -> int | None:
    """Seconds until this bucket has room again, or None if it has room now."""
    while bucket and now - bucket[0] >= WINDOW_S:
        bucket.popleft()
    if len(bucket) < limit:
        return None
    return int(WINDOW_S - (now - bucket[0])) + 1


async def guard(request: Request) -> None:
    """§22 — the gate on `/query`. Origin, then two sliding-window caps.

    Per-caller keeps one visitor from spending the whole allowance; the global
    cap is the one that survives a forged `X-Forwarded-For`, and is therefore
    the number that actually bounds the provider bill.

    Both are checked before either is charged, so a request refused by the
    global cap does not silently consume the caller's own budget.
    """
    require_known_origin(request)

    now = time.monotonic()
    mine = _bucket(_client(request))
    for bucket, limit in ((mine, settings.rate_limit_per_hour), (_global, settings.global_limit_per_hour)):
        retry = _retry_after(bucket, limit, now)
        if retry is not None:
            raise HTTPException(
                status_code=429,
                detail="rate limit exceeded",
                headers={"Retry-After": str(retry)},
            )

    mine.append(now)
    _global.append(now)


def reset() -> None:
    """Drop every counter. For tests, and for a restart-shaped reset."""
    _hits.clear()
    _global.clear()
