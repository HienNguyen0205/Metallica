"""Checks for the transport and the §11 permission gate.

Runs without an API key — the model calls are stubbed, because what is under
test is the event contract and the approval wiring, not the model.

    PYTHONPATH=. python tests/integration/test_stream.py
"""

import asyncio
import json
from contextlib import contextmanager

from friday import agent, main, tools
from friday.core import config as core_config
from friday.schema import VisualizationPlan, VizData

PLAN = VisualizationPlan(
    type="radial_gauge",
    title="SYSTEM LOAD",
    data=VizData(metrics=[{"label": "CPU", "value": 73, "unit": "%"}]),
    answer="planner phrasing",
)


def parse(chunk: str) -> tuple[str, dict]:
    assert chunk.endswith("\n\n"), f"malformed SSE frame: {chunk!r}"
    name, _, data = chunk.strip().partition("\n")
    return name.removeprefix("event: "), json.loads(data.removeprefix("data: "))


def collect(query: str = "q") -> list[tuple[str, dict]]:
    async def drain():
        return [parse(c) async for c in main.run_query(query)]

    return asyncio.run(drain())


#: What the last fake_plan call was pinned to, for the assertion below.
PINNED: list[str | None] = []


def stub_planner():
    async def fake_plan(query, answer, evidence, pinned_type=None):
        PINNED.append(pinned_type)
        # The real planner is pinned through its JSON schema, so a pinned type
        # is one it cannot return anything else for. Mirror that here, or this
        # stub keeps asserting a swap production can no longer produce.
        return PLAN.model_copy(update={"type": pinned_type}) if pinned_type else PLAN

    PINNED.clear()
    main.plan = fake_plan


# ---------- transport ----------


def test_tool_flow_event_order() -> None:
    stub_planner()

    async def fake_agent(query, approve, result, history=(), memories=""):
        yield agent.AgentEvent("state", {"state": "tool_execution"})
        yield agent.AgentEvent("tool", {"tool": "get_system_metrics", "risk": "low"})
        yield agent.AgentEvent("state", {"state": "processing"})
        result.text = "CPU is at 73 percent."
        result.evidence.append({"tool": "get_system_metrics", "output": {"cpu_percent": 73}})

    original, agent.run = agent.run, fake_agent
    try:
        events = collect()
    finally:
        agent.run = original

    names = [n for n, _ in events]
    assert names == ["state", "state", "tool", "state", "state", "viz", "state", "answer", "done"], names

    states = [p["state"] for n, p in events if n == "state"]
    assert states == ["thinking", "tool_execution", "processing", "visualizing", "speaking"], states

    viz = next(p for n, p in events if n == "viz")
    assert viz["type"] == "radial_gauge"
    # No preview in this flow, so the planner is left free to choose.
    assert PINNED == [None], PINNED
    assert "answer" not in viz, "the spoken line rides its own event"

    # the agent's own words win over the planner's restatement
    assert next(p for n, p in events if n == "answer")["text"] == "CPU is at 73 percent."


def test_preview_reaches_the_ui_before_the_planner_runs() -> None:
    """§18 — the hologram materializes as data lands, not after the turn ends."""
    stub_planner()

    async def fake_agent(query, approve, result, history=(), memories=""):
        yield agent.AgentEvent("state", {"state": "tool_execution"})
        yield agent.AgentEvent(
            "preview",
            {"type": "radial_gauge", "title": "SYSTEM LOAD",
             "data": {"metrics": [{"label": "CPU", "value": 22, "unit": "%"}]}},
        )
        yield agent.AgentEvent("state", {"state": "tool_execution"})
        yield agent.AgentEvent(
            "preview",
            {"type": "bar_3d", "title": "TOP PROCESSES",
             "data": {"series": [{"label": "MEM", "points": [10.8, 5.8]}]}},
        )
        result.text = "done"

    original, agent.run = agent.run, fake_agent
    try:
        events = collect()
    finally:
        agent.run = original

    vizzes = [p for n, p in events if n == "viz"]
    # two previews plus the planner's final spec — a sequence, not one payload
    assert len(vizzes) == 3, [v["title"] for v in vizzes]
    # The final spec keeps the component the last preview already materialised.
    # Letting the planner re-decide made the UI build bars and then replace them
    # with gauges on the same data, which reads as a bug rather than a refinement.
    assert [v["type"] for v in vizzes] == ["radial_gauge", "bar_3d", "bar_3d"]
    assert PINNED == ["bar_3d"], PINNED
    assert [v["title"] for v in vizzes] == ["SYSTEM LOAD", "TOP PROCESSES", "SYSTEM LOAD"]

    # previews are not interactive: they are mid-flight, and their elements are
    # about to be replaced by the planner's spec
    assert vizzes[0]["interaction"] == "none"


def test_agent_failure_still_closes_the_stream() -> None:
    """A dead model must not leave the UI stuck in THINKING."""
    stub_planner()

    async def broken(query, approve, result, history=(), memories=""):
        raise RuntimeError("boom")
        yield  # pragma: no cover - makes this an async generator

    original, agent.run = agent.run, broken
    try:
        events = collect()
    finally:
        agent.run = original

    assert [n for n, _ in events] == ["state", "error", "state", "done"]
    assert events[2][1]["state"] == "error"


# ---------- the UI's state machine ----------

#: Mirrored from TRANSITIONS in src/lib/store.ts (UI repo). The frontend uses a
#: *guarded* transition that drops illegal edges silently, so emitting a state
#: it will not accept strands the HUD without any error anywhere. Keep in sync.
UI_TRANSITIONS = {
    "idle": ["listening", "thinking", "warning", "error"],
    "listening": ["thinking", "idle", "warning", "error"],
    "thinking": ["searching", "tool_execution", "processing", "visualizing", "speaking", "warning", "error"],
    "searching": ["processing", "tool_execution", "visualizing", "speaking", "warning", "error"],
    "processing": ["visualizing", "tool_execution", "speaking", "warning", "error"],
    "tool_execution": ["processing", "visualizing", "speaking", "warning", "error"],
    "visualizing": ["speaking", "processing", "idle", "warning", "error"],
    "speaking": ["idle", "listening", "warning", "error"],
    "warning": ["idle", "speaking", "error"],
    "error": ["idle"],
}


def assert_walkable(events: list[tuple[str, dict]]) -> None:
    current = "idle"
    for name, payload in events:
        if name != "state":
            continue
        nxt = payload["state"]
        # A repeat of the current state is dropped by the guard too, but drops
        # nothing that matters — the UI is already there. Only a *move* the
        # table refuses is a real defect.
        if nxt == current:
            continue
        assert nxt in UI_TRANSITIONS[current], (
            f"{current} -> {nxt} is not a legal edge; the UI would drop it silently"
        )
        current = nxt


def test_every_emitted_state_sequence_is_legal_in_the_ui() -> None:
    """§18 previews must not emit an edge the frontend refuses.

    Caught live: a preview announced `visualizing`, and the next tool's
    `tool_execution` was then dropped, leaving the HUD stuck.
    """
    stub_planner()

    async def two_tool_agent(query, approve, result, history=(), memories=""):
        for viz_type, title in [("radial_gauge", "SYSTEM LOAD"), ("bar_3d", "TOP PROCESSES")]:
            yield agent.AgentEvent("state", {"state": "tool_execution"})
            yield agent.AgentEvent("tool", {"tool": "t", "risk": "low"})
            yield agent.AgentEvent("preview", {"type": viz_type, "title": title, "data": {}})
        yield agent.AgentEvent("state", {"state": "processing"})
        result.text = "done"

    original, agent.run = agent.run, two_tool_agent
    try:
        events = collect()
    finally:
        agent.run = original

    assert_walkable(events)
    assert len([1 for n, _ in events if n == "viz"]) == 3


# ---------- §11 permission gate ----------


def _run_with_decision(decision: bool | None) -> tuple[list[tuple[str, dict]], list[bool]]:
    """Drive a high-risk approval, answering it the way the UI would.

    `decision=None` answers nothing, exercising the timeout path.
    """
    stub_planner()
    verdicts: list[bool] = []

    async def gated_agent(query, approve, result, history=(), memories=""):
        verdicts.append(await approve("write_note", "high", {"name": "x", "body": "y"}))
        result.text = "done"
        yield agent.AgentEvent("state", {"state": "processing"})

    async def drive():
        events = []
        async for chunk in main.run_query("q"):
            name, payload = parse(chunk)
            events.append((name, payload))
            if name == "confirm" and decision is not None:
                # what POST /confirm does, without the HTTP hop
                await main.confirm_endpoint(main.Decision(id=payload["id"], approved=decision))
        return events

    original_agent, agent.run = agent.run, gated_agent
    original_timeout, main.CONFIRM_TIMEOUT_S = main.CONFIRM_TIMEOUT_S, 0.3
    try:
        return asyncio.run(drive()), verdicts
    finally:
        agent.run = original_agent
        main.CONFIRM_TIMEOUT_S = original_timeout


def test_high_risk_call_is_announced_before_it_runs() -> None:
    events, verdicts = _run_with_decision(True)
    confirm = next(p for n, p in events if n == "confirm")
    assert confirm["tool"] == "write_note"
    assert confirm["risk"] == "high"
    # the UI must be able to show what will actually run
    assert confirm["input"] == {"name": "x", "body": "y"}
    assert verdicts == [True]


def test_denial_is_reported_to_the_agent() -> None:
    _, verdicts = _run_with_decision(False)
    assert verdicts == [False]


def test_silence_is_not_consent() -> None:
    """An unanswered prompt must expire as a refusal, not an approval."""
    _, verdicts = _run_with_decision(None)
    assert verdicts == [False]
    assert not main.PENDING, "expired decisions must not leak"


def test_v2_denial_records_failed_step_in_registry() -> None:
    """P0.2 §2 — with V2 on, a denied high-risk tool leaves a failed tool step
    (error "denied by operator") mirrored into the registry run."""
    from friday.runs import REGISTRY

    stub_planner()
    decided_verdicts: list[bool] = []

    async def gated_agent(query, approve, result, history=(), memories="", emit_steps=False):
        yield agent.AgentEvent("step", {"step_id": "s1", "turn_id": "turn_1",
                                        "kind": "tool", "status": "running", "tool": "write_note"})
        yield agent.AgentEvent("step", {"step_id": "s1", "turn_id": "turn_1",
                                        "kind": "tool", "status": "waiting_approval", "tool": "write_note"})
        approved = await approve("write_note", "high", {"name": "x", "body": "y"})
        decided_verdicts.append(approved)
        if not approved:
            yield agent.AgentEvent("step", {"step_id": "s1", "turn_id": "turn_1", "kind": "tool",
                                            "status": "failed", "tool": "write_note",
                                            "error": "denied by operator"})
        result.text = "done"
        yield agent.AgentEvent("state", {"state": "processing"})

    async def drive():
        events = []
        async for chunk in main.run_query("deny me"):
            name, _body, payload = parse_enveloped(chunk)
            events.append((name, payload))
            if name == "confirm":
                # what POST /confirm does, without the HTTP hop
                await main.confirm_endpoint(main.Decision(id=payload["id"], approved=False))
        return events

    original_agent, agent.run = agent.run, gated_agent
    original_timeout, main.CONFIRM_TIMEOUT_S = main.CONFIRM_TIMEOUT_S, 0.3
    try:
        with events_v2(True):
            events = asyncio.run(drive())
    finally:
        agent.run = original_agent
        main.CONFIRM_TIMEOUT_S = original_timeout

    assert decided_verdicts == [False]
    names = [n for n, _ in events]
    assert "step" in names and names[-1] == "done"
    runs = [r for r in REGISTRY._runs.values() if r.goal == "deny me"]
    assert runs, "run registered"
    run = runs[-1]
    failed = [s for s in run.steps if s.kind == "tool" and s.status == "failed"]
    assert failed, [(s.kind, s.status) for s in run.steps]
    assert failed[-1].error == "denied by operator"
    assert run.status == "completed" and run.completed_at is not None


def test_only_high_risk_tools_are_gated() -> None:
    assert tools.REGISTRY["write_note"].needs_confirmation()
    assert not tools.REGISTRY["get_system_metrics"].needs_confirmation()
    # risk is server-side policy; the model never sees or sets it
    shape = tools.REGISTRY["write_note"].as_api_tool()
    assert "risk" not in json.dumps(shape), shape
    # and it is the OpenAI function-calling shape the gateway sends
    assert shape["type"] == "function"
    assert shape["function"]["name"] == "write_note"


# ---------- §22 tool sandboxing ----------


def test_note_name_cannot_escape_the_notes_directory() -> None:
    for hostile in ["../../../evil", "..\\..\\evil", "/etc/passwd", "a/b/c"]:
        written = asyncio.run(tools._write_note({"name": hostile, "body": "x"}))
        assert "written" in written, written
        landed = (tools.NOTES_DIR / written["written"]).resolve()
        assert landed.parent == tools.NOTES_DIR.resolve(), landed
        landed.unlink()


def test_empty_note_name_is_rejected() -> None:
    assert "error" in asyncio.run(tools._write_note({"name": "///", "body": "x"}))


# --- P0.2 v2 gating ---


@contextmanager
def events_v2(on: bool):
    old = core_config.settings.events_v2
    core_config.settings.events_v2 = on
    try:
        yield
    finally:
        core_config.settings.events_v2 = old


def parse_enveloped(chunk: str) -> tuple[str, dict, dict]:
    """Returns (frame_event, envelope, payload)."""
    assert chunk.endswith("\n\n")
    name, _, data = chunk.strip().partition("\n")
    body = json.loads(data.removeprefix("data: "))
    return name.removeprefix("event: "), body, body["payload"]


def test_v2_off_is_byte_identical() -> None:
    stub_planner()

    async def fake_agent(query, approve, result, history=(), memories=""):
        yield agent.AgentEvent("state", {"state": "tool_execution"})
        result.text = "ok"

    original = agent.run
    agent.run = fake_agent
    try:
        with events_v2(False):
            frames = collect()
    finally:
        agent.run = original
    names = [n for n, _ in frames]
    assert "step" not in names
    assert names[0] == "state" and names[-1] == "done"
    # flat shape: payload at top level, no envelope keys anywhere
    _, payload = frames[0]
    assert payload == {"state": "thinking"} and "version" not in payload


def test_v2_on_envelopes_everything_with_sequence() -> None:
    stub_planner()

    async def fake_agent(query, approve, result, history=(), memories="", emit_steps=False):
        yield agent.AgentEvent("state", {"state": "tool_execution"})
        if emit_steps:
            yield agent.AgentEvent("step", {"step_id": "s1", "turn_id": "turn_1", "kind": "reason", "status": "completed", "summary": "1 tool call(s)"})
        result.text = "ok"

    original = agent.run
    agent.run = fake_agent
    try:
        with events_v2(True):
            async def drain():
                return [parse_enveloped(c) async for c in main.run_query("q")]
            frames = asyncio.run(drain())
    finally:
        agent.run = original

    seqs = [body["sequence"] for _, body, _ in frames]
    assert seqs == list(range(1, len(frames) + 1)), seqs
    run_ids = {body["run_id"] for _, body, _ in frames}
    assert len(run_ids) == 1 and next(iter(run_ids)).startswith("run_")
    for name, body, payload in frames:
        assert body["version"] == 1 and body["event"] == name
        assert body["turn_id"].startswith("turn_")
        assert body["timestamp"].endswith("Z")
    assert frames[-1][0] == "done", "nothing published after done"
    step_payloads = [p for _, _, p in frames if p.get("step_id")]
    assert step_payloads and step_payloads[0]["summary"] == "1 tool call(s)"


def test_v2_on_records_steps_into_registry() -> None:
    from friday.runs import REGISTRY
    stub_planner()

    async def fake_agent(query, approve, result, history=(), memories="", emit_steps=False):
        yield agent.AgentEvent("step", {"step_id": "s1", "turn_id": "turn_1", "kind": "tool", "status": "running", "tool": "get_system_metrics"})
        yield agent.AgentEvent("step", {"step_id": "s1", "turn_id": "turn_1", "kind": "tool", "status": "completed", "summary": "CPU 73%"})
        result.text = "ok"

    original = agent.run
    agent.run = fake_agent
    try:
        with events_v2(True):
            async def drain():
                async for _ in main.run_query("q"):
                    pass
            asyncio.run(drain())
    finally:
        agent.run = original
    # one run was created and its step updated in place
    runs = [r for r in REGISTRY._runs.values() if r.goal == "q"]
    assert runs, "run registered"
    run = runs[-1]
    assert run.status == "completed" and run.completed_at is not None
    assert len(run.steps) == 1 and run.steps[0].status == "completed"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
