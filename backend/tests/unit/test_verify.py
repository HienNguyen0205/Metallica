"""Verification and bounded re-planning: structural verdicts, one recovery
pass, and a hard stop instead of an infinite loop.

    PYTHONPATH=. python tests/unit/test_verify.py
"""

import asyncio

from friday import agent, evidence as evidence_mod
from friday import verify
from friday.verify import MAX_REPLANS, verify_answer


def test_empty_answer_fails() -> None:
    v = verify_answer("   ", [])
    assert v.ok is False and v.issues == ["empty_answer"] and v.retryable is True
    assert v.hint, "a replan needs something actionable"


def test_failed_support_fails() -> None:
    bad = [evidence_mod.collect_tool_evidence("t", {"error": "x"}, 1)]
    v = verify_answer("looks fine", bad)
    assert v.ok is False and v.issues == ["failed_support"]


def test_supported_answer_passes() -> None:
    good = [evidence_mod.collect_tool_evidence("t", {"v": 1}, 1)]
    assert verify_answer("CPU 73 percent.", good).ok is True
    # direct answers without tools are legitimate, not defects
    assert verify_answer("hello!", []).ok is True


def _harness(script, tools=None):
    """Drive agent.run against a scripted completion list. Returns (result, events)."""
    from friday import llm as llm_mod
    from friday.tools import registry as registry_mod

    installed = []
    for tool in tools or []:
        registry_mod.REGISTRY[tool.name] = tool
        installed.append(tool.name)

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

    completions = list(script)

    class FakeCompletions:
        async def create(self, **kwargs):
            item = completions.pop(0)
            if isinstance(item, tuple):
                return Completion(Message(calls=[Call(item[1])]))
            return Completion(Message(content=item))

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    async def approve(tool, risk, payload):
        return True

    original_client, original_model = llm_mod.client, llm_mod.model
    llm_mod.client = lambda: FakeClient()
    llm_mod.model = lambda: "fake"
    try:
        async def scenario():
            from friday.agent.state import AgentResult

            result = AgentResult(text="")
            events = []
            async for ev in agent.run("q", approve, result, emit_steps=True):
                events.append(ev)
            return result, events

        return asyncio.run(scenario())
    finally:
        llm_mod.client, llm_mod.model = original_client, original_model
        for name in installed:
            registry_mod.REGISTRY.pop(name, None)


def test_replan_recovers_and_marks_supported() -> None:
    from friday.tools.base import Tool

    async def ok_tool(_input):
        return {"cpu_percent": 73}

    tool = Tool(name="zz_ok", description="m", input_schema={}, risk="low",
                run=ok_tool, capabilities=("system.read",))
    # turn 1 runs the tool, turn 2 answers empty (verify fails), turn 3 recovers
    result, events = _harness([("tool", "zz_ok"), "", "CPU 73 percent."], tools=[tool])

    assert result.text == "CPU 73 percent."
    assert len(result.claims) == 1
    assert result.claims[0]["status"] == "supported"
    assert result.claims[0]["evidence_ids"] == ["e1"]
    verifications = [e for e in events
                     if e.kind == "step" and e.payload.get("kind") == "verification"]
    assert len(verifications) == 1 and verifications[0].payload["status"] == "failed"


def test_replan_budget_exhaustion_stands_unverified() -> None:
    result, _ = _harness(["", ""])
    assert result.text == ""
    assert len(result.claims) == 1
    assert result.claims[0]["status"] == "unverified", "budget spent: stand, don't loop"


def test_max_replans_is_one() -> None:
    assert MAX_REPLANS == 1, "plan->verify->replan must stay bounded"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
