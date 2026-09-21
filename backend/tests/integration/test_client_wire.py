"""/query's `client` field reaches get_client_metrics for that turn only.

    PYTHONPATH=. python tests/integration/test_client_wire.py
"""

import asyncio
import os

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"

from fastapi.testclient import TestClient

from friday import agent
from friday.api import routes
from friday.main import app
from friday.schema import VisualizationPlan, VizData
from friday.tools.client import metrics as cm

client = TestClient(app)


def test_query_client_field_is_what_the_tool_sees() -> None:
    seen = []

    async def fake_agent(query, approve, result, history=(), memories="", **_):
        seen.append(await cm.run_client_metrics({}))
        result.text = "ok"
        yield agent.AgentEvent("state", {"state": "processing"})

    async def fake_plan(query, answer, evidence, pinned_type=None):
        return VisualizationPlan(type="radial_gauge", title="t", data=VizData(metrics=[]), answer="a")

    orig = (agent.run, routes.plan)
    agent.run, routes.plan = fake_agent, fake_plan
    try:
        res = client.post("/query", json={"query": "my battery?", "client": {"cpu_cores": 8, "battery": {"level_pct": 40}}})
        assert res.status_code == 200
        res.read()
        res = client.post("/query", json={"query": "again"})
        res.read()
    finally:
        agent.run, routes.plan = orig
    assert seen[0] == {"cpu_cores": 8, "battery": {"level_pct": 40.0}}, seen
    assert "error" in seen[1], "a turn without client data must not inherit the last one's"


if __name__ == "__main__":
    test_query_client_field_is_what_the_tool_sees()
    print("ok")
