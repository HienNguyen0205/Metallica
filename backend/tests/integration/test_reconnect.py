"""P1.10 — reconnect/resume: the event log replays missed frames without
re-executing anything; unknown runs are a clear 404.

    PYTHONPATH=. python tests/integration/test_reconnect.py
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

INVOCATIONS: list[str] = []


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


async def fake_plan(query, answer, evidence, pinned_type=None):
    return PLAN


async def counting_agent(query, approve, result, history=(), memories="", emit_steps=False):
    INVOCATIONS.append(query)
    yield agent.AgentEvent("state", {"state": "tool_execution"})
    yield agent.AgentEvent("tool", {"tool": "get_system_metrics", "risk": "low"})
    result.text = "CPU is at 73 percent."


async def drive_full(query: str = "reconnect me") -> tuple[list, str]:
    frames = []
    async for chunk in main.run_query(query):
        frames.append(parse_enveloped(chunk))
    return frames, frames[0][1]["run_id"]


def setup():
    INVOCATIONS.clear()
    original_plan = main.plan
    main.plan = fake_plan
    old_flag = v2_on()
    original = agent.run
    agent.run = counting_agent
    return original, original_plan, old_flag


def teardown(original, original_plan, old_flag):
    agent.run = original
    main.plan = original_plan
    v2_off(old_flag)


def test_replay_full_turn_matches_stream() -> None:
    async def scenario():
        original, original_plan, old_flag = setup()
        try:
            frames, rid = await drive_full()
        finally:
            teardown(original, original_plan, old_flag)

        replay = await routes.replay_run(rid, 0)
        assert replay["run_id"] == rid
        assert replay["status"] == "completed" and replay["terminal"] is True
        live_seq = [(b["sequence"], n) for n, b, _ in frames]
        replayed = [(e["sequence"], e["event"]) for e in replay["events"]]
        assert replayed == [(s, n) for s, n in live_seq], "replay is the stream, verbatim"
        live_payloads = [p for _, _, p in frames]
        assert [e["payload"] for e in replay["events"]] == live_payloads

    asyncio.run(scenario())


def test_replay_after_sequence_filters() -> None:
    async def scenario():
        original, original_plan, old_flag = setup()
        try:
            frames, rid = await drive_full()
        finally:
            teardown(original, original_plan, old_flag)

        replay = await routes.replay_run(rid, 2)
        assert [e["sequence"] for e in replay["events"]] == list(range(3, len(frames) + 1))
        empty = await routes.replay_run(rid, len(frames))
        assert empty["events"] == [] and empty["terminal"] is True

    asyncio.run(scenario())


def test_replay_does_not_reexecute() -> None:
    async def scenario():
        original, original_plan, old_flag = setup()
        try:
            _, rid = await drive_full()
            before = list(INVOCATIONS)
            await routes.replay_run(rid, 0)
            await routes.replay_run(rid, 1)
        finally:
            teardown(original, original_plan, old_flag)

        assert INVOCATIONS == before == ["reconnect me"], INVOCATIONS

    asyncio.run(scenario())


def test_replay_unknown_run_is_404() -> None:
    async def scenario():
        try:
            await routes.replay_run("run_nope", 0)
        except HTTPException as err:
            assert err.status_code == 404, err.status_code
        else:
            raise AssertionError("unknown run must 404")

    asyncio.run(scenario())


def test_replay_live_run_is_partial_and_nonterminal() -> None:
    async def slow_agent(query, approve, result, history=(), memories="", emit_steps=False):
        yield agent.AgentEvent("state", {"state": "tool_execution"})
        await asyncio.sleep(30)

    async def scenario():
        original_plan = main.plan
        main.plan = fake_plan
        old_flag = v2_on()
        original = agent.run
        agent.run = slow_agent
        try:
            frames: list = []

            async def drain():
                async for chunk in main.run_query("slow reconnect"):
                    frames.append(parse_enveloped(chunk))

            task = asyncio.create_task(drain())
            for _ in range(500):
                if frames:
                    break
                await asyncio.sleep(0.01)
            rid = frames[0][1]["run_id"]
            replay = await routes.replay_run(rid, 0)
            assert replay["terminal"] is False
            assert len(replay["events"]) >= 1
            assert replay["status"] == "running"
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            assert REGISTRY.get(rid).status == "cancelled"
        finally:
            agent.run = original
            main.plan = original_plan
            v2_off(old_flag)

    asyncio.run(scenario())


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
