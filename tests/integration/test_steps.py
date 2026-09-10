"""P0.2 §2 — agent.run step emission. Model calls run against the local fake
server from test_provider's fixture pattern; no key, no network.

    PYTHONPATH=. python tests/integration/test_steps.py
"""

# The fake-server fixture is imported from test_provider and driven the same
# way its own __main__ block runs — one fixture, not a second one. Where the
# fixture cannot express a scenario (a second tool turn, a gated tool) it is
# extended temporarily inside the helper and restored, like the fixture's own
# preview monkeypatch.

import asyncio
import dataclasses
import json

import test_provider
from test_provider import with_fake_provider

FINAL_ANSWER = "CPU is at 12.5 percent."


def _tool_call(n: int) -> dict:
    return {
        "id": f"call_{n}",
        "type": "function",
        "function": {"name": "get_system_metrics", "arguments": "{}"},
    }


async def _no_approval(*_):
    raise AssertionError("a low-risk tool must not ask for approval")


def _drive(emit_steps: bool, approve) -> list:
    """Run the real agent.run() to completion, gathering every event."""
    from friday import agent

    result = agent.AgentResult(text="")
    events: list[agent.AgentEvent] = []

    async def run():
        async for event in agent.run("how is the system", approve, result, emit_steps=emit_steps):
            events.append(event)

    asyncio.run(run())
    return events


def collect_events(emit_steps: bool) -> list:
    return _drive(emit_steps, _no_approval)


def collect_events_repeat_tool() -> list:
    """The base fixture answers after one tool turn; a repeat needs two.

    test_provider's FakeProvider hands back the final answer as soon as one
    tool result sits in the transcript, so for this test its do_POST is
    swapped for a variant that scripts the tool call on the first two
    requests — and restored right after.
    """

    def two_tool_turns(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        test_provider.FakeProvider.requests.append(body)
        asked = sum(1 for m in body["messages"] if m.get("tool_calls"))
        if asked < 2:
            self._send(200, self._message(tool_calls=[_tool_call(asked + 1)]))
        else:
            self._send(200, self._message(content=FINAL_ANSWER))

    original = test_provider.FakeProvider.do_POST
    test_provider.FakeProvider.do_POST = two_tool_turns
    try:
        return _drive(True, _no_approval)
    finally:
        test_provider.FakeProvider.do_POST = original


def collect_events_denied() -> list:
    """The base fixture calls get_system_metrics (low risk); the denial path
    needs a gated tool. Swap the registry entry for a high-risk copy for the
    duration — the dataclasses.replace idiom from test_remember_flow."""

    async def refuse(*_):
        return False

    from friday import tools

    original = tools.REGISTRY["get_system_metrics"]
    tools.REGISTRY["get_system_metrics"] = dataclasses.replace(original, risk="high")
    try:
        return _drive(True, refuse)
    finally:
        tools.REGISTRY["get_system_metrics"] = original


@with_fake_provider
def test_step_sequence_for_one_tool_turn() -> None:
    events = collect_events(emit_steps=True)
    steps = [e.payload for e in events if e.kind == "step"]
    kinds = [(p["kind"], p["status"]) for p in steps]
    assert kinds == [
        ("reason", "running"), ("reason", "completed"),
        ("tool", "running"), ("tool", "completed"),
        # the answer comes from turn 2's LLM call, which opens its own reason
        # step — §2 row 1 covers every LLM call start, not just the first
        ("reason", "running"),
        ("answer", "completed"),
    ], kinds
    tool = next(p for p in steps if p["kind"] == "tool")
    assert tool["tool"] == "get_system_metrics" and "retry_count" not in tool
    # turn_id is the LLM iteration (§2): the tool turn is turn_1, the answer turn_2
    assert [p["turn_id"] for p in steps] == ["turn_1"] * 4 + ["turn_2"] * 2
    # One id per logical step, stable across its transitions: the turn's reason
    # pair shares one id, the tool attempt's running/completed share another,
    # and the answer closes the run with its own fresh id.
    reason_ids = [p["step_id"] for p in steps if p["kind"] == "reason"]
    assert reason_ids[0] == reason_ids[1] != reason_ids[2], reason_ids
    tool_ids = {p["step_id"] for p in steps if p["kind"] == "tool"}
    assert len(tool_ids) == 1, tool_ids
    answer_id = next(p["step_id"] for p in steps if p["kind"] == "answer")
    assert answer_id not in set(reason_ids) | tool_ids
    # Operational metadata only:
    assert all("output" not in p and "input" not in p for p in steps)


@with_fake_provider
def test_no_step_events_when_disabled() -> None:
    events = collect_events(emit_steps=False)
    assert events, "the run produced no events at all"
    assert not [e for e in events if e.kind == "step"]


@with_fake_provider
def test_retry_count_counts_repeat_tool_calls() -> None:
    events = collect_events_repeat_tool()  # fake server returns tool_call twice, then answer
    # §2 documents retry_count on the "tool call starts" row; the completed
    # event of the same attempt carries the same count, so counting every
    # tool-kind event would read each attempt twice ([0, 0, 1, 1]).
    tools = [p for e in events if e.kind == "step" for p in [e.payload]
             if p["kind"] == "tool" and p["status"] == "running"]
    assert [p.get("retry_count", 0) for p in tools] == [0, 1]


@with_fake_provider
def test_denied_tool_marks_step_failed() -> None:
    events = collect_events_denied()  # approve() returns False
    tool = [p for e in events if e.kind == "step" for p in [e.payload] if p["kind"] == "tool"]
    statuses = [p["status"] for p in tool]
    assert "waiting_approval" in statuses and "failed" in statuses
    failed = next(p for p in tool if p["status"] == "failed")
    assert failed["error"] == "denied by operator"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all step checks passed")
