"""A map preview is the final visualization — the planner never re-plans it.

    PYTHONPATH=. python tests/integration/test_map_preview_pin.py
"""

import asyncio
import json

from friday import agent, main
from friday.api import routes

PREVIEW = {
    "type": "map",
    "title": "CHỈ ĐƯỜNG",
    "data": {"map": {"route": {"profile": "motor_scooter", "waypoints": [
        {"lat": 21.0288, "lon": 105.8525, "label": "Hồ Gươm"},
        {"lat": 21.0368, "lon": 105.8346, "label": "Lăng Bác"},
    ]}}},
}


def test_map_preview_skips_the_planner() -> None:
    async def fake_agent(query, approve, result, history=(), memories="", emit_steps=False):
        yield agent.AgentEvent("tool", {"tool": "get_directions", "risk": "low"})
        yield agent.AgentEvent("preview", PREVIEW)
        result.text = "Khoảng 2,4 km, chừng 9 phút đi xe máy."

    async def planner_must_not_run(*_args, **_kwargs):
        raise AssertionError("the planner re-planned a map preview")

    async def drain():
        return [c async for c in main.run_query("chỉ đường tới lăng bác")]

    original_agent, agent.run = agent.run, fake_agent
    original_plan, routes.plan = routes.plan, planner_must_not_run
    try:
        chunks = asyncio.run(drain())
    finally:
        agent.run, routes.plan = original_agent, original_plan

    text = "".join(c if isinstance(c, str) else c.decode() for c in chunks)
    bodies = [json.loads(line[len("data: "):]) for block in text.split("\n\n")
              if "event: viz" in block for line in block.splitlines() if line.startswith("data: ")]
    # V2 envelopes the payload; the flat transport carries it at top level.
    vizzes = [b.get("payload", b) for b in bodies]
    assert len(vizzes) == 2, vizzes  # the preview, then the same map as the final spec
    final = vizzes[-1]
    assert final["type"] == "map" and final["interaction"] == "drill_down"
    assert final["data"] == PREVIEW["data"]
    assert "2,4 km" in text


if __name__ == "__main__":
    test_map_preview_skips_the_planner()
    print("  ok  test_map_preview_skips_the_planner\nall checks passed")
