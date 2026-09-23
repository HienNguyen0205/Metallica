"""§10 web search — the one tool that reaches outside this machine.

Two providers, tried in order, the second only when the first fails:

    Tavily      TAVILY_API_KEY       extracted page text plus a synthesised answer
    Firecrawl   FIRECRAWL_API_KEY    title + description per result, no answer

Both free tiers are fixed credit balances, so falling through on *failure* and
not merely on a missing key is the point: a balance runs out mid-conversation,
and what arrives then is a 401 or 402, not an absence of configuration. With
neither key set search_web returns an error rather than pretending.

Requests go out on stdlib `urllib.request` in a thread. `httpx` is not a
declared dependency here; it arrives only under `openai`, which vendors it as
`httpx2`, having renamed it once already. Borrowing another package's HTTP
client is a dependency you did not declare and cannot see break.
"""

import asyncio
import json
import os
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable
from typing import Any

from . import firecrawl

TAVILY_URL = "https://api.tavily.com/search"

TIMEOUT_S = 15.0

#: Results returned to the model. Every one is re-sent on every later turn of
#: the same conversation, so this is a context budget, not a display choice.
MAX_RESULTS = 5

#: Characters kept per result. Tavily returns page extracts running to thousands
#: of characters; five of those would crowd out the question.
MAX_CHARS = 600


def _fetch(request: urllib.request.Request) -> bytes:
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        return response.read()


def _trim(title: str, url: str, content: str) -> dict[str, str]:
    return {"title": title[:200], "url": url, "content": content[:MAX_CHARS]}


async def _tavily(query: str) -> dict[str, Any] | None:
    key = os.getenv("TAVILY_API_KEY")
    if not key:
        return None
    body = {"query": query, "max_results": MAX_RESULTS, "include_answer": True}
    request = urllib.request.Request(
        TAVILY_URL,
        data=json.dumps(body).encode(),
        # Bearer rather than the legacy `api_key` body field: both are accepted
        # today — verified against the live endpoint, which answers 401 to each
        # rather than 422 — but the header keeps the credential out of the body.
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        data = json.loads(await asyncio.to_thread(_fetch, request))
    except urllib.error.HTTPError as err:
        # 401/432 once the balance is spent, 429 while throttled — all the
        # signal to try the next provider rather than to give up.
        return {"error": f"tavily returned {err.code}"}
    except (urllib.error.URLError, TimeoutError):
        return {"error": "tavily unreachable"}
    except json.JSONDecodeError:
        return {"error": "tavily returned malformed JSON"}

    results = [
        _trim(str(i.get("title", "")), str(i.get("url", "")), str(i.get("content", "")))
        for i in (data.get("results") or [])[:MAX_RESULTS]
    ]
    if not results:
        return {"error": "tavily returned no results"}
    return {"results": results, "answer": data.get("answer"), "source": "tavily"}


async def _firecrawl(query: str) -> dict[str, Any] | None:
    if not firecrawl.key():
        return None
    # No scrapeOptions: page content costs credits per result, and the model
    # can fetch_url the one result it actually wants.
    data = await firecrawl.post("/search", {"query": query[:500], "limit": MAX_RESULTS})
    if "error" in data:
        return data
    results = [
        _trim(str(i.get("title", "")), str(i.get("url", "")), str(i.get("description", "")))
        for i in (data.get("web") or [])[:MAX_RESULTS]
    ]
    if not results:
        return {"error": "firecrawl returned no results"}
    return {"results": results, "source": "firecrawl"}


PROVIDERS: tuple[Callable[[str], Awaitable[dict[str, Any] | None]], ...] = (
    _tavily,
    _firecrawl,
)


def configured() -> list[str]:
    """Which search providers are available, in the order they will be tried."""
    return [
        name
        for name, on in (("tavily", os.getenv("TAVILY_API_KEY")), ("firecrawl", firecrawl.key()))
        if on
    ]


async def run_search_web(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("query", "")).strip()
    if not query:
        return {"error": "empty query"}

    attempts: list[str] = []
    for provider in PROVIDERS:
        outcome = await provider(query)
        if outcome is None:
            continue  # not configured
        if "error" not in outcome:
            return {"query": query, **outcome}
        attempts.append(outcome["error"])

    # Every failure named, so the operator can see which provider to fix rather
    # than only that search is down.
    return {
        "error": "; ".join(attempts)
        or "no search provider configured (set TAVILY_API_KEY or FIRECRAWL_API_KEY)"
    }
