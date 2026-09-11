"""Observability: usage metering, run/tool/approval/replay counters, the
/metrics endpoint, and request/trace metadata on runs.

    PYTHONPATH=. python tests/unit/test_observability.py
"""

import asyncio
import json
import os

from friday import observability
from friday.observability import (
    estimate_cost_usd,
    record_llm_usage,
    reset,
    snapshot,
)


class _Usage:
    def __init__(self, prompt=0, completion=0):
        self.prompt_tokens = prompt
        self.completion_tokens = completion


class _Response:
    def __init__(self, usage=None):
        if usage is not None:
            self.usage = usage


def test_usage_capture_with_and_without_usage() -> None:
    reset()
    p, c = record_llm_usage(_Response(_Usage(10, 20)), "m", 5.0)
    assert (p, c) == (10, 20)
    snap = snapshot()
    assert snap["counters"].get("llm_calls_total{model=m,status=ok}") == 1
    assert snap["counters"].get("llm_tokens_total{model=m}") == 30
    assert snap["latency_ms"]["llm_latency_ms{model=m}"]["count"] == 1
    # providers that omit usage meter calls, never crash
    assert record_llm_usage(_Response(), "m", 1.0) == (0, 0)
    assert "llm_tokens_total{model=m}" in snapshot()["counters"]


def test_usage_error_status_counted() -> None:
    reset()
    record_llm_usage(_Response(), "m", 1.0, status="error")
    assert snapshot()["counters"].get("llm_calls_total{model=m,status=error}") == 1


def test_cost_estimate_needs_explicit_prices() -> None:
    old = os.environ.get("FRIDAY_MODEL_PRICES_JSON")
    try:
        os.environ.pop("FRIDAY_MODEL_PRICES_JSON", None)
        assert estimate_cost_usd("m", 1000, 500) == 0.0, "no guessing"
        os.environ["FRIDAY_MODEL_PRICES_JSON"] = "not-json"
        assert estimate_cost_usd("m", 1000, 500) == 0.0
        os.environ["FRIDAY_MODEL_PRICES_JSON"] = json.dumps({"m": [1.0, 2.0]})
        assert estimate_cost_usd("m", 1_000_000, 1_000_000) == 3.0
        reset()
        record_llm_usage(_Response(_Usage(1_000_000, 1_000_000)), "m", 1.0)
        assert snapshot()["counters"].get("llm_cost_estimate_usd{model=m}") == 3.0
    finally:
        if old is None:
            os.environ.pop("FRIDAY_MODEL_PRICES_JSON", None)
        else:
            os.environ["FRIDAY_MODEL_PRICES_JSON"] = old


def _scripted_client(script):
    class Call:
        def __init__(self, name, args):
            self.id = f"call_{name}"
            self.function = type("F", (), {"name": name,
                                           "arguments": json.dumps(args)})()

        def model_dump(self):
            return {"id": self.id,
                    "function": {"name": self.function.name,
                                 "arguments": self.function.arguments}}

    class Message:
        def __init__(self, calls=None, content=""):
            self.tool_calls = calls
            self.content = content

    class Choice:
        def __init__(self, message):
            self.message = message

    class Completion:
        def __init__(self, message):
            self.choices = [Choice(message)]

    items = list(script)

    class FakeCompletions:
        async def create(self, **kwargs):
            item = items.pop(0)
            if isinstance(item, tuple):
                return Completion(Message(calls=[Call(item[1], item[2])]))
            return Completion(Message(content=item))

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    return FakeClient()


def _patch_llm(script):
    from friday import llm as llm_mod

    original = (llm_mod.client, llm_mod.model)
    llm_mod.client = lambda: _scripted_client(script)
    llm_mod.model = lambda: "eval-fake"
    return original


def _unpatch_llm(original):
    from friday import llm as llm_mod

    llm_mod.client, llm_mod.model = original


def _v2():
    from friday.core import config as core_config

    old = core_config.settings.events_v2
    core_config.settings.events_v2 = True
    return old


def test_full_turn_records_run_tool_and_verify_metrics() -> None:
    from friday import main
    from friday.schema import VizData, VisualizationPlan

    async def fake_plan(query, answer, evidence, pinned_type=None):
        return VisualizationPlan(type="radial_gauge", title="T",
                                 data=VizData(), answer="p")

    async def scenario():
        original = _patch_llm([("tool", "get_system_metrics", {}), "CPU 73 percent."])
        old_flag = _v2()
        original_plan = main.plan
        main.plan = fake_plan
        reset()
        try:
            frames = []
            async for chunk in main.run_query("meter me", session_id="s",
                                              request_id="req_1"):
                name, _, data = chunk.strip().partition("\n")
                body = json.loads(data.removeprefix("data: "))
                frames.append(body)
            return frames
        finally:
            _unpatch_llm(original)
            main.plan = original_plan
            core_old = old_flag
            from friday.core import config as core_config
            core_config.settings.events_v2 = core_old

    frames = asyncio.run(scenario())
    assert frames[-1]["event"] == "done"
    snap = snapshot()
    get = snap["counters"].get
    assert get("agent_runs_total{status=completed}") == 1, snap["counters"]
    assert get("tool_calls_total{status=ok,tool=get_system_metrics}") == 1
    assert get("llm_calls_total{model=eval-fake,status=ok}") == 2
    assert snap["latency_ms"]["tool_latency_ms{tool=get_system_metrics}"]["count"] == 1
    assert snap["latency_ms"]["llm_latency_ms{model=eval-fake}"]["count"] == 2

    from friday.runs import REGISTRY

    run = REGISTRY.get(frames[0]["run_id"])
    assert run.metadata.get("request_id") == "req_1"
    assert run.metadata.get("trace_id"), "every run carries a trace id"


def test_approval_wait_and_reconnect_and_metrics_endpoint() -> None:
    from friday import main
    from friday.api import routes
    from friday.schema import VizData, VisualizationPlan

    async def fake_plan(query, answer, evidence, pinned_type=None):
        return VisualizationPlan(type="radial_gauge", title="T",
                                 data=VizData(), answer="p")

    async def scenario():
        original = _patch_llm([("tool", "write_note", {"name": "x", "body": "y"}),
                               "Saved."])
        old_flag = _v2()
        original_plan = main.plan
        main.plan = fake_plan
        original_timeout, main.CONFIRM_TIMEOUT_S = main.CONFIRM_TIMEOUT_S, 5.0
        import dataclasses
        from friday.tools import registry as registry_mod

        async def fake_write_note(payload):
            return {"written": "eval.md"}

        orig_write = registry_mod.REGISTRY["write_note"]
        registry_mod.REGISTRY["write_note"] = dataclasses.replace(
            orig_write, run=fake_write_note)
        reset()
        try:
            frames = []

            async def drain():
                async for chunk in main.run_query("note me"):
                    name, _, data = chunk.strip().partition("\n")
                    body = json.loads(data.removeprefix("data: "))
                    frames.append(body)
                    if body["event"] == "confirm":
                        await main.confirm_endpoint(
                            main.Decision(id=body["payload"]["id"], approved=True))

            await drain()
            rid = frames[0]["run_id"]
            replay = await routes.replay_run(rid, 0)
            assert replay["terminal"] is True
            metrics = await routes.metrics_endpoint()
            return frames, metrics
        finally:
            _unpatch_llm(original)
            main.plan = original_plan
            main.CONFIRM_TIMEOUT_S = original_timeout
            registry_mod.REGISTRY["write_note"] = orig_write
            from friday.core import config as core_config
            core_config.settings.events_v2 = old_flag

    frames, metrics = asyncio.run(scenario())
    assert frames[-1]["event"] == "done"
    assert metrics["service"] == "friday-orchestrator"
    assert metrics["counters"].get("approval_wait_ms", None) is None  # latencies, not counters
    assert metrics["latency_ms"]["approval_wait_ms"]["count"] == 1
    assert metrics["counters"].get("sse_reconnect_total") == 1


def test_disconnect_counts_and_verify_counters() -> None:
    from friday import agent

    async def slow_tool(_input):
        await asyncio.sleep(30)
        return {}

    from friday.tools.base import Tool
    from friday.tools import registry as registry_mod

    tool = Tool(name="zz_hang", description="h", input_schema={}, risk="low",
                run=slow_tool, capabilities=())
    registry_mod.REGISTRY["zz_hang"] = tool

    async def scenario():
        original = _patch_llm([("tool", "zz_hang", {}), "never"])
        old_flag = _v2()
        reset()
        try:
            from friday import main

            frames = []

            async def drain():
                async for chunk in main.run_query("hang me"):
                    frames.append(chunk)

            task = asyncio.create_task(drain())
            for _ in range(500):
                if frames:
                    break
                await asyncio.sleep(0.01)
            rid = None
            for chunk in frames:
                name, _, data = chunk.strip().partition("\n")
                rid = json.loads(data.removeprefix("data: "))["run_id"]
                break
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            return rid
        finally:
            _unpatch_llm(original)
            from friday.core import config as core_config
            core_config.settings.events_v2 = old_flag
            registry_mod.REGISTRY.pop("zz_hang", None)

    rid = asyncio.run(scenario())
    from friday.runs import REGISTRY

    assert REGISTRY.get(rid).status == "cancelled"
    snap = snapshot()
    assert snap["counters"].get("sse_disconnect_total") == 1

    # verify + replan counters via an empty-then-recovered turn
    async def scenario2():
        original = _patch_llm(["", "recovered"])
        try:
            reset()
            from friday.agent.state import AgentResult

            async def approve(tool, risk, payload):
                return True

            result = AgentResult(text="")
            async for _ in agent.run("q", approve, result, emit_steps=True):
                pass
            return result
        finally:
            _unpatch_llm(original)

    result = asyncio.run(scenario2())
    assert result.text == "recovered"
    snap = snapshot()
    assert snap["counters"].get("verification_failures_total") == 1
    assert snap["counters"].get("replan_total") == 1


def test_memory_write_and_delete_are_timed() -> None:
    from friday.memory import long_term as lt

    async def fake_embed(texts):
        return [[1.0, 0.0] for _ in texts]

    orig = (lt.embed, lt.store_configured, lt.store_insert, lt.store_delete)
    lt.embed = fake_embed
    lt.store_configured = lambda: True
    lt.store_insert = lambda fact, prov, emb: {"id": 1, "fact": fact,
                                               "provenance": prov}
    lt.store_delete = lambda mid: None
    lt.clear()
    reset()
    try:
        memory = asyncio.run(lt.add("operator prefers dark mode", "user"))
        assert memory is not None and memory.id == 1
        assert asyncio.run(lt.forget(1)) is True
    finally:
        lt.embed, lt.store_configured, lt.store_insert, lt.store_delete = orig
        lt.clear()
    series = snapshot()["latency_ms"]
    assert series["memory_latency_ms{op=write}"]["count"] == 1
    assert series["memory_latency_ms{op=delete}"]["count"] == 1


def test_reset_clears_everything() -> None:
    reset()
    observability.incr("x_total")
    observability.observe("y_ms", 1.0)
    reset()
    assert snapshot()["counters"] == {} and snapshot()["latency_ms"] == {}


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
