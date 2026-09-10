"""§10 web search — the one tool that reaches outside this machine.

Three providers, tried in order, each falling through to the next on failure.
Falling through on *failure* and not merely on a missing key is the point: a
credit balance runs out mid-conversation, and what arrives then is a 401, not an
absence of configuration.

    Google CSE    GOOGLE_SEARCH_API_KEY + _CX         100/day, resets daily
    Tavily        TAVILY_API_KEY                      best answers, credits run down
    DuckDuckGo    (none)                              free forever, rate-limited

Google leads on quota shape rather than answer quality. Its 100 queries a day
come back every day; Tavily's free tier is a fixed balance that, once spent,
stays spent. Spending the renewable allowance first and holding the finite one
in reserve is what keeps search working next week.

Tavily therefore sits second, where it is worth the most: it returns extracted
page text rather than snippets, so it is the better answer on the days the
Google quota has run out. The
DuckDuckGo endpoint is a scrape of an undocumented page and earns its place only
by needing no credential at all — measured, it serves roughly a dozen requests
before answering every query with a captcha for a few minutes, and it mixes
sponsored results in among the real ones.

One caveat this machine cannot test: search engines refuse datacenter addresses
far more readily than residential ones, and every measurement here ran from a
home connection. On a deployed host the keyless provider may be blocked from the
first call — which is the argument for configuring a keyed provider rather than
relying on the tail of the chain.

Requests go out on stdlib `urllib.request` in a thread. `httpx` is not a
declared dependency here; it arrives only under `openai`, which vendors it as
`httpx2`, having renamed it once already. Borrowing another package's HTTP
client is a dependency you did not declare and cannot see break.
"""

import asyncio
import html
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Awaitable, Callable
from typing import Any

TAVILY_URL = "https://api.tavily.com/search"
GOOGLE_URL = "https://www.googleapis.com/customsearch/v1"
DDG_URL = "https://html.duckduckgo.com/html/"

TIMEOUT_S = 15.0

#: Results returned to the model. Every one is re-sent on every later turn of
#: the same conversation, so this is a context budget, not a display choice.
MAX_RESULTS = 5

#: Characters kept per result. Tavily returns page extracts running to thousands
#: of characters; five of those would crowd out the question.
MAX_CHARS = 600

#: DuckDuckGo serves the plain endpoint only to something that looks like a
#: browser; the default urllib agent gets a different page.
DDG_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

#: One result block: link, title, snippet. Pairing them inside a single match
#: rather than collecting each separately keeps titles attached to their own
#: snippets when a result is missing one.
DDG_RESULT = re.compile(
    r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>'
    r'.*?class="result__snippet"[^>]*>(.*?)</a>',
    re.S,
)

_TAGS = re.compile(r"<[^>]+>")


def _text(fragment: str) -> str:
    return html.unescape(_TAGS.sub("", fragment)).strip()


def _fetch(request: urllib.request.Request) -> bytes:
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        return response.read()


def _trim(title: str, url: str, content: str) -> dict[str, str]:
    return {"title": title[:200], "url": url, "content": content[:MAX_CHARS]}


# ---------- providers ----------
# Each returns None when unconfigured, a dict with "error" when it failed, or
# results. Only the middle case advances the chain.


def _tavily_keys() -> list[str]:
    """Every configured Tavily credential, in order of use.

    A second key is a second free balance, not a second provider: when the first
    is spent Tavily answers 401, and the next key starts from a full one. Kept
    inside this provider rather than as another entry in the chain because the
    fallback order that matters — renewable quota before finite ones — is about
    providers, and two keys of the same provider are one step in it.
    """
    names = ("TAVILY_API_KEY", "TAVILY_API_KEY_2")
    return [value for value in (os.getenv(n) for n in names) if value]


async def _tavily(query: str) -> dict[str, Any] | None:
    keys = _tavily_keys()
    if not keys:
        return None

    failures: list[str] = []
    for index, key in enumerate(keys, start=1):
        outcome = await _tavily_once(query, key)
        if "error" not in outcome:
            return outcome
        failures.append(f"key {index}: {outcome['error']}")
    return {"error": "; ".join(failures)}


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


async def _google(query: str) -> dict[str, Any] | None:
    key = os.getenv("GOOGLE_SEARCH_API_KEY")
    cx = os.getenv("GOOGLE_SEARCH_CX")
    if not (key and cx):
        return None

    params = urllib.parse.urlencode(
        {"key": key, "cx": cx, "q": query, "num": MAX_RESULTS}
    )
    request = urllib.request.Request(GOOGLE_URL + "?" + params)
    try:
        data = json.loads(await asyncio.to_thread(_fetch, request))
    except urllib.error.HTTPError as err:
        # 429 is the daily 100 exhausted; 403 is usually a key without the
        # Custom Search API enabled, which reads the same from here.
        return {"error": f"google search returned {err.code}"}
    except (urllib.error.URLError, TimeoutError):
        return {"error": "google search unreachable"}
    except json.JSONDecodeError:
        return {"error": "google search returned malformed JSON"}

    results = [
        _trim(str(i.get("title", "")), str(i.get("link", "")), str(i.get("snippet", "")))
        for i in (data.get("items") or [])[:MAX_RESULTS]
    ]
    if not results:
        return {"error": "google search returned no results"}
    # no `answer`: this provider gives snippets only, and synthesising one here
    # would be the model's job done worse
    return {"results": results, "source": "google"}


async def _duckduckgo(query: str) -> dict[str, Any] | None:
    request = urllib.request.Request(
        DDG_URL + "?" + urllib.parse.urlencode({"q": query}),
        headers={"user-agent": DDG_AGENT},
    )
    try:
        page = (await asyncio.to_thread(_fetch, request)).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as err:
        return {"error": f"duckduckgo returned {err.code}"}
    except (urllib.error.URLError, TimeoutError):
        return {"error": "duckduckgo unreachable"}

    # A block is not an empty result set, and reporting it as one sends the model
    # hunting for a different phrasing of a query that will never work.
    if "anomaly" in page.lower() or "captcha" in page.lower():
        return {"error": "duckduckgo is rate-limiting this host"}

    results: list[dict[str, str]] = []
    for href, title, snippet in DDG_RESULT.findall(page):
        if href.startswith("//"):
            href = "https:" + href
        target = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("uddg")
        url = target[0] if target else href
        # sponsored results carry the tracker in the unwrapped URL, and once
        # summarised an advert is indistinguishable from a fact
        if "y.js" in url or "ad_provider" in url:
            continue
        results.append(_trim(_text(title), url, _text(snippet)))
        if len(results) == MAX_RESULTS:
            break

    if not results:
        return {"error": "duckduckgo returned no results"}
    return {"results": results, "source": "duckduckgo"}


#: Order matters: renewable quota first, finite balance second, no-credential
#: last. Not best-answers-first — see the note at the top of this module.
PROVIDERS: tuple[Callable[[str], Awaitable[dict[str, Any] | None]], ...] = (
    _google,
    _tavily,
    _duckduckgo,
)


def configured() -> list[str]:
    """Which keyed providers are available, in the order they will be tried."""
    names = []
    if os.getenv("GOOGLE_SEARCH_API_KEY") and os.getenv("GOOGLE_SEARCH_CX"):
        names.append("google")
    # Counted, not just present: a mistyped second key is otherwise invisible
    # until the first one runs out, which is the worst moment to discover it.
    keys = len(_tavily_keys())
    if keys:
        names.append("tavily" if keys == 1 else f"tavily x{keys}")
    return names


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
    return {"error": "; ".join(attempts) if attempts else "no search provider configured"}
