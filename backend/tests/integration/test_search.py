"""§10 web search, against a local fake standing in for Tavily.

    PYTHONPATH=. python tests/integration/test_search.py

No key, no network. What is under test: that a spent key hands over to the
second one rather than failing the turn, that failures are named, that results
are trimmed before reaching the model, and that no key means an error rather
than a request.
"""

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from friday.tools.integrations import search

PORT = 8129

#: Status per bearer token this test; absent means 200.
plan: dict[str, int] = {}
#: Tokens actually used, in order.
hits: list[str] = []

BODY = {
    "answer": "a synthesis",
    "results": [{"title": "T" * 500, "url": "https://t.example", "content": "x" * 5000}] * 12,
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        # Drain the request body first: leaving it unread makes the client see a
        # connection reset instead of the status we are trying to simulate.
        length = int(self.headers.get("content-length", 0))
        if length:
            self.rfile.read(length)

        token = self.headers.get("authorization", "").removeprefix("Bearer ")
        hits.append(token)
        status = plan.get(token, 200)

        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"detail":"nope"}' if status >= 400 else json.dumps(BODY).encode())

    def log_message(self, *_args) -> None:
        pass


def serve() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    search.TAVILY_URL = f"http://127.0.0.1:{PORT}/search"
    return server


def setup(*keys: str, **statuses: int) -> None:
    hits.clear()
    plan.clear()
    plan.update(statuses)
    for var, value in zip(("TAVILY_API_KEY", "TAVILY_API_KEY_2"), (*keys, None, None)):
        if value:
            os.environ[var] = value
        else:
            os.environ.pop(var, None)


def run(query: str = "python asyncio") -> dict:
    return asyncio.run(search.run_search_web({"query": query}))


def test_one_key_answers() -> None:
    setup("k1")
    out = run()

    assert hits == ["k1"], hits
    assert out["source"] == "tavily"
    assert out["answer"] == "a synthesis"


def test_a_spent_key_hands_over_to_the_second_one() -> None:
    """Two Tavily keys are two balances: 401 on the first must not end the turn."""
    setup("k1", "k2", k1=401)
    out = run()

    assert hits == ["k1", "k2"], "the second key must be tried before giving up"
    assert out["source"] == "tavily"
    assert "error" not in out


def test_every_failure_is_named() -> None:
    setup("k1", "k2", k1=401, k2=429)
    out = run()

    # the operator needs to know which key to go and fix
    assert "key 1: tavily returned 401" in out["error"]
    assert "key 2: tavily returned 429" in out["error"]


def test_no_key_is_an_error_without_touching_the_network() -> None:
    setup()
    out = run()

    assert "TAVILY_API_KEY" in out["error"]
    assert hits == []


def test_results_reach_the_model_trimmed() -> None:
    setup("k1")
    out = run()

    assert len(out["results"]) == search.MAX_RESULTS
    for item in out["results"]:
        assert len(item["content"]) <= search.MAX_CHARS
        assert len(item["title"]) <= 200


def test_empty_query_is_refused_without_touching_the_network() -> None:
    setup("k1")
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
