"""§15 short-term memory.

    PYTHONPATH=. python tests/unit/test_memory.py

The interesting assertion is not that a dict stores things — it is that the
stored exchanges actually reach the model's message list, in order, and that
one session cannot see another's.
"""

import asyncio
import json

from friday import agent, main, memory
from friday.schema import VisualizationPlan, VizData

PLAN = VisualizationPlan(
    type="radial_gauge",
    title="SYSTEM LOAD",
    data=VizData(metrics=[{"label": "CPU", "value": 73, "unit": "%"}]),
    answer="planner phrasing",
)


def parse(chunk: str) -> tuple[str, dict]:
    name, _, data = chunk.strip().partition("\n")
    return name.removeprefix("event: "), json.loads(data.removeprefix("data: "))


def run_turn(query: str, session: str | None, answer: str) -> list[dict]:
    """Drives one full turn and returns the history the agent was handed."""
    seen: list[dict] = []

    async def fake_agent(q, approve, result, history=(), memories=""):
        seen.extend(history)
        result.text = answer
        return
        yield  # pragma: no cover — makes this an async generator

    async def fake_plan(q, a, evidence, pinned_type=None):
        return PLAN

    agent_original, agent.run = agent.run, fake_agent
    main.plan = fake_plan
    try:

        async def drain():
            return [parse(c) async for c in main.run_query(query, session)]

        asyncio.run(drain())
    finally:
        agent.run = agent_original
    return seen


def test_history_reaches_the_next_prompt() -> None:
    memory.clear()
    assert run_turn("check the system", "s1", "CPU is at 73 percent.") == []

    # the whole point: turn two must be able to see turn one
    replayed = run_turn("and the disk?", "s1", "Disk is at 40 percent.")
    assert replayed == [
        {"role": "user", "content": "check the system"},
        {"role": "assistant", "content": "CPU is at 73 percent."},
    ], replayed


def test_sessions_do_not_leak_into_each_other() -> None:
    memory.clear()
    run_turn("my password is hunter2", "s1", "Noted.")
    assert run_turn("what did I just say?", "s2", "No idea.") == []


def test_no_session_id_keeps_no_history() -> None:
    """A client that sends no id gets the old stateless behaviour, not a shared bucket."""
    memory.clear()
    run_turn("check the system", None, "CPU is at 73 percent.")
    assert run_turn("and the disk?", None, "Disk is at 40 percent.") == []
    assert memory.history(None) == []


def test_a_failed_turn_is_not_recorded() -> None:
    memory.clear()

    async def exploding_agent(q, approve, result, history=(), memories=""):
        raise RuntimeError("provider down")
        yield  # pragma: no cover

    original, agent.run = agent.run, exploding_agent
    try:

        async def drain():
            return [parse(c) async for c in main.run_query("check the system", "s1")]

        events = asyncio.run(drain())
    finally:
        agent.run = original

    assert any(name == "error" for name, _ in events)
    # a turn that never produced an answer must not become context for the next
    assert memory.history("s1") == []


def test_only_the_last_turns_are_kept() -> None:
    memory.clear()
    for i in range(memory.MAX_TURNS + 3):
        memory.remember("s1", f"q{i}", f"a{i}")

    kept = memory.history("s1")
    assert len(kept) == memory.MAX_TURNS * 2, kept
    assert kept[0]["content"] == "q3", kept[0]


def test_sessions_are_bounded() -> None:
    """`/query` is public and the id is client-chosen: this dict cannot grow freely."""
    memory.clear()
    for i in range(memory.MAX_SESSIONS + 50):
        memory.remember(f"s{i}", "q", "a")

    assert len(memory._sessions) == memory.MAX_SESSIONS
    # least-recently-used goes first, so the oldest ids are the ones dropped
    assert memory.history("s0") == []
    assert memory.history(f"s{memory.MAX_SESSIONS + 49}") != []


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
