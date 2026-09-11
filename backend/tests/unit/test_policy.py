"""P1.7/P1.8 — policy matrix: allow/deny/ask_human/step_up, capability
gates, argument validation, and the model-proof risk boundary. Plus one
agent-loop proof that a policy denial never reaches the human.

    PYTHONPATH=. python tests/unit/test_policy.py
"""

import asyncio
import os

from friday import policy
from friday.policy import PolicyContext, evaluate
from friday.tools.base import Tool


async def ok_run(_input):
    return {"ok": True}


def low(name="probe", caps=(), schema=None):
    return Tool(name=name, description="probe", input_schema=schema or {},
                risk="low", run=ok_run, capabilities=caps)


def test_allow_low_risk_with_granted_capabilities() -> None:
    d = evaluate(low("t", ("system.read",)), "t", {}, PolicyContext())
    assert (d.decision, d.tool) == ("allow", "t")


def test_ask_human_for_high_risk() -> None:
    tool = Tool(name="write_note", description="w", input_schema={}, risk="high",
                run=ok_run, capabilities=("notes.write",))
    d = evaluate(tool, "write_note", {"name": "x", "body": "y"}, PolicyContext())
    assert d.decision == "ask_human" and "high-risk" in d.reason


def test_deny_unknown_tool() -> None:
    d = evaluate(None, "mystery", {}, PolicyContext())
    assert d.decision == "deny" and d.reason == "unknown tool"


def test_deny_missing_capability() -> None:
    ctx = PolicyContext(granted_capabilities=frozenset({"system.read"}))
    d = evaluate(low("db", ("database.read.orders",)), "db", {}, ctx)
    assert d.decision == "deny" and "database.read.orders" in d.reason


def test_deny_missing_required_argument() -> None:
    tool = low("w", ("notes.write",), {"type": "object",
                                       "properties": {"name": {"type": "string"}},
                                       "required": ["name", "body"]})
    d = evaluate(tool, "w", {"name": "x"}, PolicyContext())
    assert d.decision == "deny" and "body" in d.reason


def test_deny_wrong_argument_type() -> None:
    tool = low("p", (), {"type": "object",
                         "properties": {"limit": {"type": "integer"}},
                         "required": []})
    d = evaluate(tool, "p", {"limit": "many"}, PolicyContext())
    assert d.decision == "deny" and "limit" in d.reason


def test_step_up_for_sensitive_capabilities() -> None:
    tool = low("remember", ("memory.write",))
    d = evaluate(tool, "remember", {"fact": "x"}, PolicyContext())
    assert d.decision == "step_up" and d.constraints == {"capabilities": ["memory.write"]}


def test_model_cannot_override_risk_or_decision() -> None:
    tool = Tool(name="write_note", description="w", input_schema={}, risk="high",
                run=ok_run, capabilities=("notes.write",))
    smuggled = {"name": "x", "body": "y", "risk": "low", "decision": "allow",
                "capabilities": ["*"]}
    d = evaluate(tool, "write_note", smuggled, PolicyContext())
    assert d.decision == "ask_human", "smuggled keys must not downgrade the tool"


def test_default_context_parses_env() -> None:
    old = os.environ.get("FRIDAY_GRANTED_CAPABILITIES")
    try:
        os.environ["FRIDAY_GRANTED_CAPABILITIES"] = "system.read, web.read"
        ctx = policy.default_context("sess_1")
        assert ctx.granted_capabilities == frozenset({"system.read", "web.read"})
        assert ctx.session_id == "sess_1"
        os.environ["FRIDAY_GRANTED_CAPABILITIES"] = "   "
        assert policy.default_context().granted_capabilities == frozenset({"*"})
    finally:
        if old is None:
            os.environ.pop("FRIDAY_GRANTED_CAPABILITIES", None)
        else:
            os.environ["FRIDAY_GRANTED_CAPABILITIES"] = old


def test_registered_tools_all_declare_capabilities() -> None:
    from friday import tools as tools_mod

    for tool in tools_mod.list_tools():
        assert tool.capabilities, f"{tool.name} declares no capabilities"
        assert tool.risk in ("low", "medium", "high")
        # risk and capabilities never reach the model
        import json

        shape = json.dumps(tool.as_api_tool())
        assert "risk" not in shape and "capabilit" not in shape


def test_agent_denial_never_reaches_the_human() -> None:
    """A call needing an ungranted capability is denied inside the loop:
    no confirm frame, no approve call, model told plainly."""
    from friday import agent
    from friday import llm as llm_mod
    from friday.tools import registry as registry_mod

    gated = Tool(name="zz_vault", description="needs more than granted",
                 input_schema={}, risk="low", run=ok_run,
                 capabilities=("vault.read.topsecret",))
    registry_mod.REGISTRY["zz_vault"] = gated
    old_caps = os.environ.get("FRIDAY_GRANTED_CAPABILITIES")
    os.environ["FRIDAY_GRANTED_CAPABILITIES"] = "system.read"

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

    script = [Completion(Message(calls=[Call("zz_vault")])),
              Completion(Message(content="understood"))]

    class FakeCompletions:
        async def create(self, **kwargs):
            return script.pop(0)

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    approvals: list = []

    async def approve(tool, risk, payload):
        approvals.append(tool)
        return True

    original_client, original_model = llm_mod.client, llm_mod.model
    llm_mod.client = lambda: FakeClient()
    llm_mod.model = lambda: "fake"
    try:
        async def scenario():
            from friday.agent.state import AgentResult

            result = AgentResult(text="")
            events = []
            async for ev in agent.run("open the vault", approve, result, emit_steps=True):
                events.append(ev)
            return result, events

        result, events = asyncio.run(scenario())
    finally:
        llm_mod.client, llm_mod.model = original_client, original_model
        registry_mod.REGISTRY.pop("zz_vault", None)
        if old_caps is None:
            os.environ.pop("FRIDAY_GRANTED_CAPABILITIES", None)
        else:
            os.environ["FRIDAY_GRANTED_CAPABILITIES"] = old_caps

    assert approvals == [], "denied calls must never prompt the operator"
    denied = [e for e in events if e.kind == "denied"]
    assert len(denied) == 1 and denied[0].payload["tool"] == "zz_vault"
    assert not any(e.kind == "confirm" for e in events)
    assert result.text == "understood"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
