"""P1.6 — budgets: wall-time and tool-call ceilings end the run with a
structured budget_exceeded error (never an ambiguous exception); per-tool
timeout and output caps hold at the agent loop.

    PYTHONPATH=. python tests/integration/test_budgets.py
"""

import asyncio
import json

from friday import agent, main
from friday.api.schemas import RunBudget
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


async def fake_plan(query, answer, evidence, pinned_type=None):
    return PLAN


async def drain(query: str, budget) -> list:
    out = []
    async for chunk in main.run_query(query, budget=budget):
        out.append(parse_enveloped(chunk))
    return out


def test_wall_time_budget_exceeded() -> None:
    async def chatty_agent(query, approve, result, history=(), memories="", emit_steps=False):
        for _ in range(50):
            await asyncio.sleep(0.05)
            yield agent.AgentEvent("state", {"state": "processing"})
        result.text = "too slow"

    async def scenario():
        original_plan = main.plan
        main.plan = fake_plan
        old_flag = v2_on()
        original = agent.run
        agent.run = chatty_agent
        try:
            frames = await drain("slow turn", RunBudget(max_wall_time_ms=120))
        finally:
            agent.run = original
            main.plan = original_plan
            v2_off(old_flag)

        names = [n for n, _, _ in frames]
        assert names[-3:] == ["error", "state", "done"], names
        error = next(p for n, _, p in frames if n == "error")
        assert error["code"] == "budget_exceeded", error
        assert "wall time" in error["message"], error
        seqs = [b["sequence"] for _, b, _ in frames]
        assert seqs == list(range(1, len(frames) + 1)), seqs
        rid = frames[0][1]["run_id"]
        run = REGISTRY.get(rid)
        assert run is not None and run.status == "failed", run.status
        assert run.error and "wall time" in run.error

    asyncio.run(scenario())


def test_tool_calls_budget_exceeded() -> None:
    async def spammy_agent(query, approve, result, history=(), memories="", emit_steps=False):
        for i in range(5):
            yield agent.AgentEvent("step", {"step_id": f"s{i}", "turn_id": "turn_1",
                                            "kind": "tool", "status": "running",
                                            "tool": "get_system_metrics"})
        result.text = "spam"

    async def scenario():
        original_plan = main.plan
        main.plan = fake_plan
        old_flag = v2_on()
        original = agent.run
        agent.run = spammy_agent
        try:
            frames = await drain("spammy turn", RunBudget(max_tool_calls=2))
        finally:
            agent.run = original
            main.plan = original_plan
            v2_off(old_flag)

        names = [n for n, _, _ in frames]
        assert names[-3:] == ["error", "state", "done"], names
        error = next(p for n, _, p in frames if n == "error")
        assert error == {"code": "budget_exceeded",
                         "message": "budget exceeded: 3 tool calls (max 2)"}, error
        rid = frames[0][1]["run_id"]
        assert REGISTRY.get(rid).status == "failed"

    asyncio.run(scenario())


def test_no_budget_means_no_ceiling() -> None:
    async def quick_agent(query, approve, result, history=(), memories="", emit_steps=False):
        result.text = "ok"
        yield agent.AgentEvent("state", {"state": "processing"})

    async def scenario():
        original_plan = main.plan
        main.plan = fake_plan
        old_flag = v2_on()
        original = agent.run
        agent.run = quick_agent
        try:
            frames = await drain("free turn", None)
        finally:
            agent.run = original
            main.plan = original_plan
            v2_off(old_flag)

        names = [n for n, _, _ in frames]
        assert "error" not in names and names[-1] == "done", names
        assert REGISTRY.get(frames[0][1]["run_id"]).status == "completed"

    asyncio.run(scenario())


def test_tool_timeout_and_output_cap() -> None:
    """Agent-loop level: a hanging tool dies as TimeoutError, a huge one is
    truncated — both ride the existing failed/completed step path."""
    from friday import llm as llm_mod
    from friday.tools.base import Tool
    from friday.tools import registry as registry_mod

    async def hang(_input):
        await asyncio.sleep(30)
        return {}

    async def flood(_input):
        return {"blob": "x" * 5000}

    slow = Tool(name="zz_slow", description="hangs", input_schema={}, risk="low",
                run=hang, timeout_s=0.05)
    big = Tool(name="zz_big", description="floods", input_schema={}, risk="low",
               run=flood, max_output_bytes=100)
    registry_mod.REGISTRY["zz_slow"] = slow
    registry_mod.REGISTRY["zz_big"] = big

    class Call:
        def __init__(self, name):
            self.id = f"call_{name}"
            self.function = type("F", (), {"name": name, "arguments": "{}"})()

        def model_dump(self):
            return {"id": self.id, "function": {"name": self.function.name}}

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

    script = [
        Completion(Message(calls=[Call("zz_slow")])),
        Completion(Message(calls=[Call("zz_big")])),
        Completion(Message(content="both handled")),
    ]

    class FakeCompletions:
        async def create(self, **kwargs):
            return script.pop(0)

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    original_client, original_model = llm_mod.client, llm_mod.model
    llm_mod.client = lambda: FakeClient()
    llm_mod.model = lambda: "fake"
    try:
        async def scenario():
            result = agent.AgentResult(text="")
            events = []
            async def approve(tool, risk, payload):
                return True
            async for ev in agent.run("q", approve, result, emit_steps=True):
                events.append(ev)
            return result, events

        result, events = asyncio.run(scenario())
    finally:
        llm_mod.client, llm_mod.model = original_client, original_model
        registry_mod.REGISTRY.pop("zz_slow", None)
        registry_mod.REGISTRY.pop("zz_big", None)

    steps = [e.payload for e in events if e.kind == "step"]
    slow_failed = [p for p in steps
                   if p.get("kind") == "tool" and p.get("error") == "TimeoutError"]
    assert slow_failed, steps
    assert result.text == "both handled"
    outputs = [e["output"] for e in result.evidence
               if isinstance(e, dict) and "output" in e]
    assert any(isinstance(o, dict) and o.get("truncated") is True for o in outputs), outputs


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
