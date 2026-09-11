"""§10 web search, against a local fake standing in for all three providers.

    PYTHONPATH=. python tests/integration/test_search.py

No key, no network. What is under test is the chain: that the renewable quota is
spent before the finite one, that a provider running out mid-conversation hands
over rather than failing the turn, that the keyless tail still works with nothing
configured, and that sponsored results never reach the model.
"""

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from friday.tools.integrations import search

PORT = 8129

#: How each provider should behave this test. Status 0 means "not reached".
plan: dict[str, int] = {}
#: Providers actually contacted, in order.
hits: list[str] = []

#: One advert and two organic results, in DuckDuckGo's own markup.
DDG_PAGE = """
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_provider%3Dbingv7aa">Sponsored</a>
<a class="result__snippet" href="#">Buy something.</a>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2Flibrary%2Fasyncio.html">asyncio &mdash; docs</a>
<a class="result__snippet" href="#">asyncio is a library to write <b>concurrent</b> code.</a>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frealpython.com%2Fasync-io-python%2F">Real Python</a>
<a class="result__snippet" href="#">A hands-on walkthrough.</a>
"""

BODIES = {
    "tavily": {
        "answer": "a synthesis",
        "results": [{"title": "T" * 500, "url": "https://t.example", "content": "x" * 5000}] * 12,
    },
    "google": {
        "items": [
            {"title": "G one", "link": "https://g.example/1", "snippet": "from google"},
            {"title": "G two", "link": "https://g.example/2", "snippet": "also google"},
        ]
    },
}


class Handler(BaseHTTPRequestHandler):
    def _who(self) -> str:
        if self.path.startswith("/search"):
            return "tavily"
        if self.path.startswith("/customsearch"):
            return "google"
        return "duckduckgo"

    def _respond(self) -> None:
        # Drain the request body first: leaving it unread makes the client see a
        # connection reset instead of the status we are trying to simulate.
        length = int(self.headers.get("content-length", 0))
        if length:
            self.rfile.read(length)

        who = self._who()
        hits.append(who)
        # Tavily may carry several keys; let a test fail one and not the other.
        token = self.headers.get("authorization", "").removeprefix("Bearer ")
        status = plan.get(f"{who}:{token}", plan.get(who, 200))

        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        if status >= 400:
            self.wfile.write(b'{"detail":"nope"}')
        elif who == "duckduckgo":
            self.wfile.write(DDG_PAGE.encode())
        else:
            self.wfile.write(json.dumps(BODIES[who]).encode())

    do_GET = do_POST = _respond

    def log_message(self, *_args) -> None:
        pass


def serve() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{PORT}"
    search.TAVILY_URL = f"{base}/search"
    search.GOOGLE_URL = f"{base}/customsearch/v1"
    search.DDG_URL = f"{base}/html/"
    return server


def setup(*, tavily: bool, google: bool, **statuses: int) -> None:
    hits.clear()
    plan.clear()
    plan.update(statuses)
    for name, on, keys in (
        ("tavily", tavily, {"TAVILY_API_KEY": "t-key"}),
        ("google", google, {"GOOGLE_SEARCH_API_KEY": "g-key", "GOOGLE_SEARCH_CX": "cx"}),
    ):
        for var, value in keys.items():
            if on:
                os.environ[var] = value
            else:
                os.environ.pop(var, None)


def run(query: str = "python asyncio") -> dict:
    return asyncio.run(search.run_search_web({"query": query}))


def test_the_renewable_quota_is_spent_before_the_finite_one() -> None:
    """Google's 100 come back tomorrow; Tavily's credits do not come back at all."""
    setup(tavily=True, google=True)
    out = run()

    assert out["source"] == "google"
    assert hits == ["google"], "the rest of the chain must not be called on success"


def test_an_exhausted_daily_quota_hands_over_to_tavily() -> None:
    """429 is what the daily 100 running out looks like, mid-conversation."""
    setup(tavily=True, google=True)
    plan["google"] = 429

    out = run()

    assert hits == ["google", "tavily"], hits
    assert out["source"] == "tavily"
    assert out["answer"] == "a synthesis"


def test_both_keyed_providers_down_falls_to_the_keyless_one() -> None:
    setup(tavily=True, google=True)
    plan["google"] = 429
    plan["tavily"] = 401

    out = run()

    assert hits == ["google", "tavily", "duckduckgo"], hits
    assert out["source"] == "duckduckgo"


def test_nothing_configured_still_searches() -> None:
    setup(tavily=False, google=False)
    out = run()

    assert hits == ["duckduckgo"], "unconfigured providers must not be contacted"
    assert out["source"] == "duckduckgo"
    # the redirect wrapper is unwrapped and the entities decoded
    assert out["results"][0]["title"] == "asyncio — docs"
    assert out["results"][0]["content"] == "asyncio is a library to write concurrent code."


def test_sponsored_results_never_reach_the_model() -> None:
    """Summarised into an answer, an advert is indistinguishable from a fact."""
    setup(tavily=False, google=False)
    out = run()

    assert all("y.js" not in r["url"] for r in out["results"])
    assert all("Buy something" not in r["content"] for r in out["results"])


def test_a_spent_key_hands_over_to_the_second_one() -> None:
    """Two Tavily keys are two balances: 401 on the first must not end the turn."""
    setup(tavily=True, google=False)
    os.environ["TAVILY_API_KEY_2"] = "t-key-2"
    plan["tavily:t-key"] = 401
    try:
        out = run()
    finally:
        os.environ.pop("TAVILY_API_KEY_2", None)

    assert hits == ["tavily", "tavily"], "the second key must be tried before moving on"
    assert out["source"] == "tavily"
    assert "error" not in out


def test_every_failure_is_named() -> None:
    setup(tavily=True, google=True)
    plan.update({"google": 429, "tavily": 401, "duckduckgo": 503})

    out = run()

    # the operator needs to know which provider to go and fix
    assert "tavily returned 401" in out["error"]
    assert "google search returned 429" in out["error"]
    assert "duckduckgo returned 503" in out["error"]


def test_results_reach_the_model_trimmed() -> None:
    setup(tavily=True, google=False)
    out = run()

    assert len(out["results"]) == search.MAX_RESULTS
    for item in out["results"]:
        assert len(item["content"]) <= search.MAX_CHARS
        assert len(item["title"]) <= 200


def test_empty_query_is_refused_without_touching_the_network() -> None:
    setup(tavily=True, google=True)
    assert "error" in run("   ")
    assert hits == []


if __name__ == "__main__":
    server = serve()
    try:
        for name, fn in sorted(globals().items()):
            if name.startswith("test_") and callable(fn):
                fn()
                print(f"  ok  {name}")
        print("all search checks passed")
    finally:
        server.shutdown()
