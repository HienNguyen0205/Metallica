"""P3 — /confirm honours run ownership, like cancel and replay do.

    PYTHONPATH=. python tests/integration/test_confirm_owner.py
"""

import asyncio
import os

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"

from fastapi.testclient import TestClient

from friday.api import dependencies as deps
from friday.core import config as core_config
from friday.main import app

client = TestClient(app)


def pending(request_id: str, owner: str | None) -> asyncio.Future:
    fut = asyncio.new_event_loop().create_future()
    deps.PENDING[request_id] = fut
    deps.PENDING_OWNERS[request_id] = owner
    return fut


def decide(request_id: str, user: str | None = None) -> int:
    headers = {"x-user-id": user} if user else {}
    return client.post("/confirm", json={"id": request_id, "approved": True}, headers=headers).status_code


def test_identified_run_refuses_other_callers() -> None:
    old = core_config.settings.trust_identity_headers
    core_config.settings.trust_identity_headers = True
    try:
        fut = pending("req_alice", "alice")
        assert decide("req_alice", "mallory") == 403
        assert decide("req_alice") == 403, "anonymous may not approve an identified run"
        assert not fut.done(), "a refused caller must not resolve the decision"
        assert decide("req_alice", "alice") == 200
        assert fut.result() is True
    finally:
        core_config.settings.trust_identity_headers = old
        deps.PENDING.clear()
        deps.PENDING_OWNERS.clear()


def test_anonymous_run_behaves_as_before() -> None:
    try:
        fut = pending("req_anon", None)
        assert decide("req_anon") == 200
        assert fut.result() is True
    finally:
        deps.PENDING.clear()
        deps.PENDING_OWNERS.clear()


if __name__ == "__main__":
    test_identified_run_refuses_other_callers()
    test_anonymous_run_behaves_as_before()
    print("ok")
