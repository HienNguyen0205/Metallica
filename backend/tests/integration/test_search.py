"""§10 web search, against a local fake standing in for Tavily and Firecrawl.

    PYTHONPATH=. python tests/integration/test_search.py

No key, no network. What is under test is the chain: that Tavily answers first,
that it running out mid-conversation hands over to Firecrawl rather than failing
the turn, that unconfigured providers are never contacted, that failures are
named, and that results are trimmed before reaching the model.
"""

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from friday.tools.integrations import firecrawl, search

PORT = 8129

#: How each provider should behave this test; absent means 200.
plan: dict[str, int] = {}
#: Providers actually contacted, in order.
hits: list[str] = []
#: Last JSON body each provider received.
bodies: dict[str, dict] = {}

RESPONSES = {
    "tavily": {
        "answer": "a synthesis",
        "results": [{"title": "T" * 500, "url": "https://t.example", "content": "x" * 5000}] * 12,
    },
    "firecrawl": {
        "success": True,
        "data": {
            "web": [
                {"title": "F one", "url": "https://f.example/1", "description": "from firecrawl"},
                {"title": "F two", "url": "https://f.example/2", "description": "also firecrawl"},
            ]
        },
    },
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        # Drain the request body first: leaving it unread makes the client see a
        # connection reset instead of the status we are trying to simulate.
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length) if length else b"{}"

        who = "firecrawl" if self.path.startswith("/v2/") else "tavily"
        hits.append(who)
        bodies[who] = json.loads(raw)
        status = plan.get(who, 200)

        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"detail":"nope"}' if status >= 400 else json.dumps(RESPONSES[who]).encode())

    def log_message(self, *_args) -> None:
        pass


def serve() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    search.TAVILY_URL = f"http://127.0.0.1:{PORT}/search"
    firecrawl.FIRECRAWL_URL = f"http://127.0.0.1:{PORT}/v2"
    return server


def setup(*, tavily: bool, firecrawl: bool, **statuses: int) -> None:
    hits.clear()
    plan.clear()
    plan.update(statuses)
    for var, on in (("TAVILY_API_KEY", tavily), ("FIRECRAWL_API_KEY", firecrawl)):
        if on:
            os.environ[var] = "k"
        else:
            os.environ.pop(var, None)


def run(query: str = "python asyncio") -> dict:
    return asyncio.run(search.run_search_web({"query": query}))


def test_tavily_answers_first() -> None:
    setup(tavily=True, firecrawl=True)
    out = run()

    assert hits == ["tavily"], "the rest of the chain must not be called on success"
    assert out["source"] == "tavily"
    assert out["answer"] == "a synthesis"


def test_spent_tavily_hands_over_to_firecrawl() -> None:
    """401 is what Tavily's balance running out looks like, mid-conversation."""
    setup(tavily=True, firecrawl=True)
    plan["tavily"] = 401

    out = run()

    assert hits == ["tavily", "firecrawl"], hits
    assert out["source"] == "firecrawl"
    assert out["results"][0] == {
        "title": "F one", "url": "https://f.example/1", "content": "from firecrawl",
    }
    # page content costs credits per result; search must not ask for it
    assert "scrapeOptions" not in bodies["firecrawl"], bodies["firecrawl"]


def test_firecrawl_alone_searches() -> None:
    setup(tavily=False, firecrawl=True)
    out = run()

    assert hits == ["firecrawl"], "unconfigured providers must not be contacted"
    assert out["source"] == "firecrawl"


def test_every_failure_is_named() -> None:
    setup(tavily=True, firecrawl=True)
    plan.update({"tavily": 401, "firecrawl": 402})

    out = run()

    # the operator needs to know which provider to go and fix
    assert "tavily returned 401" in out["error"]
    assert "firecrawl returned 402" in out["error"]


def test_no_key_is_an_error_without_touching_the_network() -> None:
    setup(tavily=False, firecrawl=False)
    out = run()

    assert "TAVILY_API_KEY" in out["error"]
    assert hits == []


def test_results_reach_the_model_trimmed() -> None:
    setup(tavily=True, firecrawl=False)
    out = run()

    assert len(out["results"]) == search.MAX_RESULTS
    for item in out["results"]:
        assert len(item["content"]) <= search.MAX_CHARS
        assert len(item["title"]) <= 200


def test_empty_query_is_refused_without_touching_the_network() -> None:
    setup(tavily=True, firecrawl=True)
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
