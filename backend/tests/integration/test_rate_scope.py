"""§22 — only `/query` spends the rate limit; control routes never do.

Approving a tool, cancelling a run, reconnecting and reviewing memory make no
model call. Charging them against the query budget meant a user at their
limit could not approve (tool timed out as denied) or cancel (the run kept
spending) exactly when it mattered.

    PYTHONPATH=. python tests/integration/test_rate_scope.py
"""

import os

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"
os.environ["FRIDAY_RATE_LIMIT_PER_HOUR"] = "1"
os.environ["FRIDAY_GLOBAL_LIMIT_PER_HOUR"] = "1"

from fastapi.testclient import TestClient

from friday.api import dependencies as deps
from friday.main import app
from friday.memory import store

client = TestClient(app)
store.select_all = lambda: []


def exhaust_budget() -> None:
    deps.reset()
    # One charge fills both windows (limit 1); the next /query must be refused.
    import asyncio
    from types import SimpleNamespace

    req = SimpleNamespace(headers={"x-forwarded-for": "testclient"}, client=SimpleNamespace(host="testclient"))
    asyncio.run(deps.guard(req))


def test_control_routes_work_with_the_query_budget_spent() -> None:
    exhaust_budget()
    assert client.post("/confirm", json={"id": "nope", "approved": True}).status_code == 404
    assert client.post("/runs/nope/cancel").status_code == 404
    assert client.get("/runs/nope/events").status_code == 404
    for _ in range(3):
        assert client.get("/memory").status_code == 200
    assert client.get("/metrics").status_code == 200
    assert client.get("/audit").status_code == 200


def test_control_routes_still_check_origin() -> None:
    deps.reset()
    evil = {"origin": "https://evil.example"}
    assert client.post("/confirm", json={"id": "x", "approved": True}, headers=evil).status_code == 403
    assert client.get("/memory", headers=evil).status_code == 403


def test_query_is_still_rate_limited() -> None:
    exhaust_budget()
    assert client.post("/query", json={"query": "hi"}).status_code == 429


if __name__ == "__main__":
    test_control_routes_work_with_the_query_budget_spent()
    test_control_routes_still_check_origin()
    test_query_is_still_rate_limited()
    print("ok")
