"""STEP 1 (P0.1) — canonical contract parity: shared schemas <-> BE producer.

    Run from backend/:  PYTHONPATH=. python tests/unit/test_contracts.py
    Stdlib only by policy (no jsonschema dep): assertions mirror the JSON
    schemas field by field; any schema change must update them (and vice versa).
"""

import asyncio
import json
import os
from typing import get_args

from friday.events.emitter import EventEmitter
from friday.events.serializer import sse_envelope
from friday.events.types import ALL_EVENTS, EventKind
from friday.runs import RunStatus
from friday.schemas.events import ErrorEvent, StepEvent
from friday.schemas.tools import RiskLevel
from friday.schemas.visualization import VisualizationType

CONTRACTS = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "contracts")
)


def load(*parts: str) -> dict:
    with open(os.path.join(CONTRACTS, *parts), encoding="utf-8") as fh:
        return json.load(fh)


def test_events_envelope_covers_every_be_event_kind() -> None:
    schema = load("events.v1.json")
    assert set(["version", "event", "payload"]) <= set(schema["required"])
    assert schema["properties"]["version"]["const"] == 1
    for kind in set(get_args(EventKind)) | set(ALL_EVENTS):
        assert kind in schema["properties"]["event"]["enum"], kind


def test_envelope_emitter_validates_against_schema() -> None:
    schema = load("events.v1.json")
    frame = sse_envelope("run_1", "sess_1", "turn_1", 3, "state", {"state": "thinking"})
    header, data = frame.split("\n")[:2]
    assert header == "event: state"
    body = json.loads(data.removeprefix("data: "))
    assert body["version"] == schema["properties"]["version"]["const"] == 1
    assert body["event"] in schema["properties"]["event"]["enum"]
    assert isinstance(body["payload"], dict) and body["sequence"] >= 1


def test_emitter_frames_are_wellformed_sse() -> None:
    em = EventEmitter()
    frames = asyncio.run(_emit_all(em))
    assert len(frames) == 5
    seen = {}
    for frame in frames:
        header, data = frame.split("\n")[:2]
        kind = header.removeprefix("event: ")
        seen[kind] = json.loads(data.removeprefix("data: "))
    assert set(seen) == {"state", "tool", "answer", "done", "error"}
    assert seen["tool"] == {"tool": "get_system_metrics", "risk": "low"}


async def _emit_all(em: EventEmitter) -> list:
    return [
        await em.state("thinking"),
        await em.tool("get_system_metrics", "low"),
        await em.answer("hi"),
        await em.done(),
        await em.error("boom"),
    ]


def test_visualization_types_match_canonical_schema() -> None:
    schema = load("visualization", "visualization.v1.json")
    assert schema["required"] == ["type"]
    be_types = set(get_args(VisualizationType))
    assert be_types <= set(schema["properties"]["type"]["enum"]), be_types
    # FE/BE drift fix: the funnel/sankey renderers exist in the FE registry,
    # so the canonical schema and BE model must both cover them.
    assert {"funnel_3d", "sankey_flow"} <= be_types
    assert {"funnel_3d", "sankey_flow"} <= set(schema["properties"]["type"]["enum"])


def test_run_status_matches_canonical_schema() -> None:
    schema = load("run", "run.v1.json")
    assert set(["run_id", "status"]) <= set(schema["required"])
    assert set(get_args(RunStatus)) == set(schema["definitions"]["RunStatus"]["enum"])


def test_tool_risk_and_policy_match_canonical_schema() -> None:
    schema = load("tool", "tool.v1.json")
    assert set(["tool", "risk"]) <= set(schema["required"])
    assert set(get_args(RiskLevel)) == set(schema["properties"]["risk"]["enum"])
    decision = schema["definitions"]["PolicyDecision"]
    assert set(["tool", "decision"]) <= set(decision["required"])
    assert set(decision["properties"]["decision"]["enum"]) == {"allow", "deny", "ask_human", "step_up"}


def test_error_model_matches_canonical_schema() -> None:
    schema = load("error", "error.v1.json")
    assert schema["required"] == ["message"]
    assert set(ErrorEvent.model_fields) <= set(schema["properties"])
    # producer-negative: unknown event kinds and risks fail loudly, never silently
    assert "flying" not in ALL_EVENTS
    assert "critical" not in set(get_args(RiskLevel))
    StepEvent(step_id="s1", turn_id="turn_1", kind="tool", status="running")


def test_run_query_transcript_validates_against_contracts() -> None:
    """P0.2/P0.3 — every frame of a real v2 turn validates: envelope keys,
    contiguous sequences, single run identity, per-kind payload shapes, and a
    single terminal `done` with nothing after it."""
    from friday import agent, main
    from friday.core import config as core_config
    from friday.schema import VizData, VisualizationPlan

    events_schema = load("events.v1.json")
    viz_schema = load("visualization", "visualization.v1.json")
    tool_schema = load("tool", "tool.v1.json")
    event_enum = set(events_schema["properties"]["event"]["enum"])
    defs = events_schema["definitions"]

    async def fake_agent(query, approve, result, history=(), memories="", emit_steps=False):
        yield agent.AgentEvent("state", {"state": "tool_execution"})
        yield agent.AgentEvent("tool", {"tool": "get_system_metrics", "risk": "low"})
        if emit_steps:
            yield agent.AgentEvent("step", {"step_id": "s1", "turn_id": "turn_1",
                                            "kind": "tool", "status": "running",
                                            "tool": "get_system_metrics"})
            yield agent.AgentEvent("step", {"step_id": "s1", "turn_id": "turn_1",
                                            "kind": "tool", "status": "completed",
                                            "summary": "CPU 73%"})
        result.text = "CPU is at 73 percent."

    async def fake_plan(query, answer, evidence, pinned_type=None):
        return VisualizationPlan(
            type="radial_gauge", title="SYSTEM LOAD",
            data=VizData(metrics=[{"label": "CPU", "value": 73, "unit": "%"}]),
            answer="planner phrasing",
        )

    async def drain():
        return [c async for c in main.run_query("contract turn")]

    original_agent, agent.run = agent.run, fake_agent
    original_plan, main.plan = main.plan, fake_plan
    old_flag = core_config.settings.events_v2
    core_config.settings.events_v2 = True
    try:
        import asyncio

        frames = asyncio.run(drain())
    finally:
        agent.run = original_agent
        main.plan = original_plan
        core_config.settings.events_v2 = old_flag

    assert len(frames) >= 5, "a turn is state/tool/steps/viz/answer/done at minimum"
    bodies = []
    for chunk in frames:
        assert chunk.endswith("\n\n"), f"malformed SSE frame: {chunk!r}"
        name, _, data = chunk.strip().partition("\n")
        frame_event = name.removeprefix("event: ")
        body = json.loads(data.removeprefix("data: "))
        # envelope identity matches the frame header (FE rejects mismatches)
        assert body["event"] == frame_event, body
        bodies.append(body)

    seqs = [b["sequence"] for b in bodies]
    assert seqs == list(range(1, len(bodies) + 1)), f"sequences contiguous from 1: {seqs}"
    run_ids = {b["run_id"] for b in bodies}
    assert len(run_ids) == 1 and next(iter(run_ids)).startswith("run_")
    names = [b["event"] for b in bodies]
    assert names.count("done") == 1 and names[-1] == "done", names
    assert "error" not in names

    for body in bodies:
        assert body["version"] == 1
        assert body["event"] in event_enum
        assert isinstance(body["turn_id"], str) and body["turn_id"]
        assert isinstance(body["timestamp"], str) and body["timestamp"].endswith("Z")
        payload = body["payload"]
        assert isinstance(payload, dict)
        kind = body["event"]
        if kind == "state":
            assert payload["state"] in defs["statePayload"]["properties"]["state"]["enum"]
        elif kind == "tool":
            assert payload["tool"] and payload["risk"] in tool_schema["properties"]["risk"]["enum"]
        elif kind == "step":
            StepEvent(**payload)  # consumer-shaped: raises on contract drift
            assert payload["kind"] in defs["stepPayload"]["properties"]["kind"]["enum"]
            assert payload["status"] in defs["stepPayload"]["properties"]["status"]["enum"]
        elif kind == "viz":
            assert payload["type"] in viz_schema["properties"]["type"]["enum"]
        elif kind == "answer":
            assert isinstance(payload["text"], str) and payload["text"]

    from friday.runs import REGISTRY

    run = REGISTRY.get(bodies[0]["run_id"])
    assert run is not None and run.status == "completed" and run.completed_at is not None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
