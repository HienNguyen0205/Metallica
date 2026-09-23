"""Firecrawl v2 — the paid fallback behind search_web and fetch_url.

Both tools try their free or already-paid path first and reach here only when
it fails: Tavily out of credit for search, a page stdlib cannot read (bot wall,
JS-rendered shell, PDF) for fetch. Firecrawl's own free tier is a fixed credit
balance too, which is why it sits second in both places rather than first.

FIRECRAWL_API_KEY unset means this module is never called.
"""

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Any

FIRECRAWL_URL = "https://api.firecrawl.dev/v2"

#: Server-side budget handed to Firecrawl; the socket waits a little longer so
#: its own timeout error arrives rather than ours.
SERVER_TIMEOUT_MS = 25_000
TIMEOUT_S = 30.0


def key() -> str | None:
    return os.getenv("FIRECRAWL_API_KEY") or None


def _fetch(request: urllib.request.Request) -> bytes:
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        return response.read()


async def post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST to one v2 endpoint. Returns the response's `data`, or {"error"}."""
    request = urllib.request.Request(
        FIRECRAWL_URL + path,
        data=json.dumps({**body, "timeout": SERVER_TIMEOUT_MS}).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {key()}"},
        method="POST",
    )
    try:
        data = json.loads(await asyncio.to_thread(_fetch, request))
    except urllib.error.HTTPError as err:
        # 402 is the credit balance spent, 429 throttled.
        return {"error": f"firecrawl returned {err.code}"}
    except (urllib.error.URLError, TimeoutError):
        return {"error": "firecrawl unreachable"}
    except json.JSONDecodeError:
        return {"error": "firecrawl returned malformed JSON"}
    if not data.get("success") or not isinstance(data.get("data"), dict):
        return {"error": "firecrawl reported failure"}
    return data["data"]
