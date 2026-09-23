"""§10 web search — the one tool that reaches outside this machine.

One provider: Tavily (TAVILY_API_KEY, optionally TAVILY_API_KEY_2). It returns
extracted page text rather than snippets, plus a synthesised answer. Its free
tier is a fixed credit balance that, once spent, stays spent — so a second key
is tried when the first answers 401, and with no key at all search_web returns
an error rather than pretending.

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
from typing import Any

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


def _tavily_keys() -> list[str]:
    """Every configured Tavily credential, in order of use.

    A second key is a second free balance: when the first is spent Tavily
    answers 401, and the next key starts from a full one.
    """
    names = ("TAVILY_API_KEY", "TAVILY_API_KEY_2")
    return [value for value in (os.getenv(n) for n in names) if value]


async def _tavily_once(query: str, key: str) -> dict[str, Any]:
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
        # 401 once the balance is spent, 429 while throttled — both are the
        # signal to try the next key rather than to give up.
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


def configured() -> list[str]:
    """Which search providers are available, for the startup log."""
    # Counted, not just present: a mistyped second key is otherwise invisible
    # until the first one runs out, which is the worst moment to discover it.
    keys = len(_tavily_keys())
    if not keys:
        return []
    return ["tavily" if keys == 1 else f"tavily x{keys}"]


async def run_search_web(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("query", "")).strip()
    if not query:
        return {"error": "empty query"}

    keys = _tavily_keys()
    if not keys:
        return {"error": "no search provider configured (set TAVILY_API_KEY)"}

    # Every failure named, so the operator can see which key to fix rather
    # than only that search is down.
    failures: list[str] = []
    for index, key in enumerate(keys, start=1):
        outcome = await _tavily_once(query, key)
        if "error" not in outcome:
            return {"query": query, **outcome}
        failures.append(f"key {index}: {outcome['error']}")
    return {"error": "; ".join(failures)}
