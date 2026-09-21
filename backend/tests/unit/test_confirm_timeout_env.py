"""§11 — FRIDAY_CONFIRM_TIMEOUT_S sets how long an approval may wait, read
live on every approval (settings.confirm_timeout_s_live).

This is also the knob every approval test must turn: a module constant used
to stand in for it, and once the route stopped reading that constant the
tests patching it silently waited the full 120s and still passed.

    PYTHONPATH=. python tests/unit/test_confirm_timeout_env.py
"""

import asyncio
import os
import time

from friday import agent
from friday.api import routes
from friday.schema import VisualizationPlan, VizData


def test_an_env_change_after_startup_bounds_the_next_approval() -> None:
    verdicts: list[bool] = []

    async def gated_agent(query, approve, result, history=(), memories="", **_):
        verdicts.append(await approve("write_note", "high", {"name": "x", "body": "y"}))
        result.text = "done"
        yield agent.AgentEvent("state", {"state": "processing"})

    async def fake_plan(query, answer, evidence, pinned_type=None):
        return VisualizationPlan(type="radial_gauge", title="t", data=VizData(metrics=[]), answer="a")

    async def drive():
        async for _ in routes.run_query("q"):
            pass  # nobody answers the confirm

    orig = (agent.run, routes.plan, os.environ.get("FRIDAY_CONFIRM_TIMEOUT_S"))
    agent.run, routes.plan = gated_agent, fake_plan
    os.environ["FRIDAY_CONFIRM_TIMEOUT_S"] = "0.2"  # after import: must still apply
    started = time.monotonic()
    try:
        asyncio.run(drive())
    finally:
        agent.run, routes.plan = orig[0], orig[1]
        if orig[2] is None:
            os.environ.pop("FRIDAY_CONFIRM_TIMEOUT_S", None)
        else:
            os.environ["FRIDAY_CONFIRM_TIMEOUT_S"] = orig[2]
    assert verdicts == [False], "silence is not consent"
    assert time.monotonic() - started < 10, "the 0.2s timeout must apply, not the 120s default"


if __name__ == "__main__":
    test_an_env_change_after_startup_bounds_the_next_approval()
    print("ok")
