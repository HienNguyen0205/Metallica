"""P1.5 — cancellation: POST /runs/{run_id}/cancel while thinking, in tool,
waiting approval, after completion, duplicate, and unknown runs.

    PYTHONPATH=. python tests/integration/test_cancel.py
"""

import asyncio
import json

from fastapi import HTTPException

from friday import agent, main
from friday.api import routes
from friday.core import config as core_config
from friday.runs import REGISTRY
from friday.schema import VizData, VisualizationPlan

PLAN = VisualizationPlan(
    type="radial_gauge",
    title="SYSTEM LOAD",
    data=VizData(metrics=[{"label": "CPU", "value": 73, "unit": "%"}]),
    answer="planner phrasing",
)


def parse_enveloped(chunk: str) -> tuple[str, dict, dict]:
    assert chunk.endswith("\n\n"), f"malformed SSE frame: {chunk!r}"
    name, _, data = chunk.strip().partition("\n")
    body = json.loads(data.removeprefix("data: "))
    return name.removeprefix("event: "), body, body["payload"]


def v2_on():
    old = core_config.settings.events_v2
    core_config.settings.events_v2 = True
    return old


def v2_off(old):
    core_config.settings.events_v2 = old


def stub_planner():
    async def fake_plan(query, answer, evidence, pinned_type=None):
        return PLAN

    original = main.plan
    main.plan = fake_plan
    return original


async def wait_for_frames(frames: list, n: int) -> None:
    for _ in range(500):
        if len(frames) >= n:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"only {len(frames)} frames arrived, wanted {n}")


async def drive(frames: list) -> None:
    async for chunk in main.run_query("cancel me"):
        _, body, _ = parse_enveloped(chunk)
        frames.append(body)


def run_id_of(frames: list) -> str:
    return frames[0]["run_id"]


def test_cancel_while_thinking() -> None:
    async def slow_agent(query, approve, result, history=(), memories="", emit_steps=False):
        yield agent.AgentEvent("state", {"state": "tool_execution"})
        await asyncio.sleep(30)

    async def scenario():
        original_plan = stub_planner()
        old_flag = v2_on()
        original = agent.run
        agent.run = slow_agent
        try:
            frames: list = []
            task = asyncio.create_task(drive(frames))
            await wait_for_frames(frames, 1)
            rid = run_id_of(frames)
            first = await routes.cancel_run(rid)
            assert first == {"ok": True, "run_id": rid, "status": "cancelled", "cancelled": True}, first
            try:
                await task
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("drain should die with the run")
            run = REGISTRY.get(rid)
            assert run is not None and run.status == "cancelled", run.status
            assert not main.PENDING, "nothing may leak"
            # duplicate cancel of a finished run reports terminal status
            second = await routes.cancel_run(rid)
            assert second == {"ok": True, "run_id": rid, "status": "cancelled", "cancelled": False}, second
        finally:
            agent.run = original
            main.plan = original_plan
            v2_off(old_flag)

    asyncio.run(scenario())


def test_cancel_during_tool() -> None:
    async def tool_agent(query, approve, result, history=(), memories="", emit_steps=False):
        yield agent.AgentEvent("tool", {"tool": "get_system_metrics", "risk": "low"})
        await asyncio.sleep(30)

    async def scenario():
        original_plan = stub_planner()
        old_flag = v2_on()
        original = agent.run
        agent.run = tool_agent
        try:
            frames: list = []
            task = asyncio.create_task(drive(frames))
            await wait_for_frames(frames, 2)  # thinking + tool
            rid = run_id_of(frames)
            kinds = [f["event"] for f in frames]
            assert "tool" in kinds, kinds
            res = await routes.cancel_run(rid)
            assert res["cancelled"] is True, res
            try:
                await task
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("drain should die with the run")
            assert REGISTRY.get(rid).status == "cancelled"
        finally:
            agent.run = original
            main.plan = original_plan
            v2_off(old_flag)

    asyncio.run(scenario())


def test_cancel_while_waiting_approval() -> None:
    async def gated_agent(query, approve, result, history=(), memories="", emit_steps=False):
        ok = await approve("write_note", "high", {"name": "x", "body": "y"})
        result.text = "done" if ok else "denied"
        yield agent.AgentEvent("state", {"state": "processing"})

    async def scenario():
        original_plan = stub_planner()
        old_flag = v2_on()
        original_agent = agent.run
        agent.run = gated_agent
        original_timeout, main.CONFIRM_TIMEOUT_S = main.CONFIRM_TIMEOUT_S, 60.0
        try:
            frames: list = []
            task = asyncio.create_task(drive(frames))
            for _ in range(500):
                if any(f["event"] == "confirm" for f in frames):
                    break
                await asyncio.sleep(0.01)
            else:
                raise AssertionError("confirm never arrived")
            rid = run_id_of(frames)
            assert REGISTRY.get(rid).status == "waiting_approval"
            res = await routes.cancel_run(rid)
            assert res["cancelled"] is True, res
            try:
                await task
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("drain should die with the run")
            # the approval wait dies *as cancelled*, never as approved
            assert not main.PENDING, "expired decisions must not leak"
            assert REGISTRY.get(rid).status == "cancelled"
        finally:
            agent.run = original_agent
            main.plan = original_plan
            main.CONFIRM_TIMEOUT_S = original_timeout
            v2_off(old_flag)

    asyncio.run(scenario())


def test_cancel_after_completion_is_a_terminal_report() -> None:
    async def quick_agent(query, approve, result, history=(), memories="", emit_steps=False):
        result.text = "ok"
        yield agent.AgentEvent("state", {"state": "processing"})

    async def scenario():
        original_plan = stub_planner()
        old_flag = v2_on()
        original = agent.run
        agent.run = quick_agent
        try:
            frames: list = []
            await drive(frames)
            assert frames[-1]["event"] == "done"
            rid = run_id_of(frames)
            assert REGISTRY.get(rid).status == "completed"
            first = await routes.cancel_run(rid)
            assert first == {"ok": True, "run_id": rid, "status": "completed", "cancelled": False}, first
            second = await routes.cancel_run(rid)
            assert second == first, "duplicate cancel is idempotent"
        finally:
            agent.run = original
            main.plan = original_plan
            v2_off(old_flag)

    asyncio.run(scenario())


def test_cancel_unknown_run_is_404() -> None:
    async def scenario():
        try:
            await routes.cancel_run("run_nope")
        except HTTPException as err:
            assert err.status_code == 404, err.status_code
        else:
            raise AssertionError("unknown run must 404")

    asyncio.run(scenario())


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
