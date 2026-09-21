"""The operator's own device, as their browser reports it.

get_system_metrics reads the orchestrator's host (psutil on the server), so
"how is my machine doing" used to answer with the server's numbers. The
browser sends what it can measure with no permission prompt; this tool hands
it to the model only when the model asks.

    PYTHONPATH=. python tests/unit/test_client_metrics.py
"""

import asyncio

from pydantic import ValidationError

from friday.api.schemas import ClientContext, Query
from friday.tools import registry
from friday.tools.client import metrics as cm


FULL = {
    "cpu_cores": 8,
    "device_memory_gb": 16,
    "cpu_pressure": "fair",
    "battery": {"level_pct": 97, "charging": True},
    "storage": {"usage_mb": 120.5, "quota_mb": 4800},
    "network": {"effective_type": "4g", "downlink_mbps": 0.25, "rtt_ms": 150},
    "js_heap_mb": 42.1,
    "gpu": {"vendor": "intel", "architecture": "gen-9"},
    "platform": "Windows",
    "timezone": "Asia/Saigon",
    "languages": ["en-US", "vi"],
    "screen": {"width": 1536, "height": 864, "dpr": 1.25},
}


def test_query_accepts_a_bounded_client_context() -> None:
    q = Query(query="hi", client=FULL)
    assert q.client is not None and q.client.cpu_cores == 8
    assert Query(query="hi").client is None
    # Unknown keys are dropped, never trusted or stored.
    assert "fingerprint" not in ClientContext(fingerprint="x").model_dump()


def test_a_bad_client_context_never_fails_the_question() -> None:
    # A browser quirk (a NaN, a new enum value) must cost the device readings,
    # not a 422 on the whole query.
    q = Query(query="hi", client={"cpu_cores": -3, "battery": "full"})
    assert q.query == "hi" and q.client is None


def test_client_context_rejects_out_of_range_readings() -> None:
    for bad in (
        {"cpu_cores": 0},
        {"cpu_cores": 100000},
        {"battery": {"level_pct": 140}},
        {"cpu_pressure": "melting"},
        {"platform": "x" * 200},
        {"languages": ["en"] * 20},
    ):
        try:
            ClientContext(**bad)
        except ValidationError:
            continue
        raise AssertionError(f"accepted {bad}")


def test_tool_returns_this_turns_client_data_only() -> None:
    async def with_client():
        cm.CLIENT.set(ClientContext(**FULL).model_dump(exclude_none=True))
        return await cm.run_client_metrics({})

    out = asyncio.run(with_client())
    assert out["cpu_cores"] == 8 and out["battery"]["level_pct"] == 97

    out = asyncio.run(cm.run_client_metrics({}))
    assert "error" in out, "no data must be said plainly, never invented"


def test_preview_gauges_only_real_percentages() -> None:
    spec = cm.preview_client_metrics(ClientContext(**FULL).model_dump(exclude_none=True))
    assert spec["type"] == "radial_gauge"
    labels = {m["label"]: m["value"] for m in spec["data"]["metrics"]}
    assert labels["BATTERY"] == 97
    assert round(labels["STORAGE"], 1) == 2.5  # 120.5 / 4800
    assert labels["CPU FAIR"] == 50
    # Missing readings are left out, not drawn as zero.
    sparse = cm.preview_client_metrics({"cpu_cores": 4})
    assert sparse["data"]["metrics"] == []


def test_registered_as_a_low_risk_read() -> None:
    tool = registry.get("get_client_metrics")
    assert tool is not None and tool.risk == "low"
    assert tool.capabilities == ("client.read",)
    assert "browser" in tool.description


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
