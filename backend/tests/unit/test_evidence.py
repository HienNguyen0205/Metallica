"""P2 — evidence and claims: sourced collection, answer linkage, and the
agent loop wiring that fills both.

    PYTHONPATH=. python tests/unit/test_evidence.py
"""

import asyncio

from friday import agent, evidence as evidence_mod
from friday.evidence import Claim, Evidence, build_answer_claim, collect_tool_evidence


def test_system_tool_evidence_is_confident() -> None:
    e = collect_tool_evidence("get_system_metrics", {"cpu_percent": 73}, 1)
    assert e.evidence_id == "e1" and e.source_type == "tool"
    assert e.source_id == "get_system_metrics"
    assert (e.confidence, e.provenance) == (1.0, "system")
    assert Evidence.from_dict(e.to_dict()) == e


def test_web_evidence_is_suspect() -> None:
    e = collect_tool_evidence("search_web", {"results": []}, 2)
    assert (e.confidence, e.provenance) == (0.7, "external_source")


def test_failed_tool_output_is_zero_confidence_evidence() -> None:
    e = collect_tool_evidence("get_system_metrics", {"error": "TimeoutError"}, 3)
    assert e.confidence == 0.0 and e.content["error"] == "TimeoutError"


def test_answer_claim_cites_everything_at_weakest_confidence() -> None:
    a = collect_tool_evidence("get_system_metrics", {"cpu_percent": 73}, 1)
    b = collect_tool_evidence("search_web", {"results": []}, 2)
    claim = build_answer_claim("CPU 73 percent, roughly.", [a, b])
    assert claim.claim_id == "c1" and claim.status == "unverified"
    assert claim.evidence_ids == ["e1", "e2"] and claim.confidence == 0.7


def test_answer_claim_without_evidence_defaults() -> None:
    claim = build_answer_claim("hi", [])
    assert claim.evidence_ids == [] and claim.confidence == 1.0
    assert Claim.from_dict(claim.to_dict()) == claim


def test_agent_loop_collects_evidence_and_claims() -> None:
    from friday import llm as llm_mod

    async def ok_tool(_input):
        return {"cpu_percent": 73}

    from friday.tools.base import Tool
    from friday.tools import registry as registry_mod

    tool = Tool(name="zz_meter", description="m", input_schema={}, risk="low",
                run=ok_tool, capabilities=("system.read",))
    registry_mod.REGISTRY["zz_meter"] = tool

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

    script = [Completion(Message(calls=[Call("zz_meter")])),
              Completion(Message(content="CPU 73 percent."))]

    class FakeCompletions:
        async def create(self, **kwargs):
            return script.pop(0)

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
            async for _ in agent.run("cpu?", approve, result, emit_steps=True):
                pass
            return result

        result = asyncio.run(scenario())
    finally:
        llm_mod.client, llm_mod.model = original_client, original_model
        registry_mod.REGISTRY.pop("zz_meter", None)

    # planner-shaped keys survive alongside the new evidence keys
    assert result.evidence[0]["tool"] == "zz_meter"
    assert result.evidence[0]["output"] == {"cpu_percent": 73}
    assert result.evidence[0]["evidence_id"] == "e1"
    assert result.evidence[0]["provenance"] == "system"
    assert len(result.claims) == 1
    claim = result.claims[0]
    assert claim["claim_id"] == "c1" and claim["status"] == "unverified"
    assert claim["evidence_ids"] == ["e1"] and claim["confidence"] == 1.0


def test_registry_mirrors_claims() -> None:
    from friday.runs import RunRegistry

    r = RunRegistry()
    run = r.create(None, "q")
    r.begin(run.run_id)
    claim = build_answer_claim("done", []).to_dict()
    r.record_claim(run.run_id, claim)
    assert run.claims == [claim]
    r.finish(run.run_id, "completed")
    r.record_claim(run.run_id, build_answer_claim("late", []).to_dict())
    assert len(run.claims) == 1, "claims stop at the terminal edge"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
