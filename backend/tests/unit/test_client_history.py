"""The last ~10 minutes of the operator's device, as a series.

A snapshot answers "how is my network"; only a history answers "how has it
been". The browser keeps a ring buffer (one sample per 10 s while visible,
60 kept) and sends it with the question; get_client_history turns one
metric of it into a line_3d.

    PYTHONPATH=. python tests/unit/test_client_history.py
"""

import asyncio

from pydantic import ValidationError

from friday.api.schemas import ClientContext
from friday.tools import registry
from friday.tools.client import metrics as cm

T0 = 1_790_000_000
HISTORY = {
    "interval_s": 10,
    "samples": [
        {"t": T0, "rtt_ms": 150, "battery_pct": 97, "pressure": 0},
        {"t": T0 + 10, "rtt_ms": 300, "battery_pct": 96},
        {"t": T0 + 20, "rtt_ms": 90, "battery_pct": 96, "pressure": 2},
    ],
}


def run(ctx: dict, fn, *args):
    async def go():
        cm.CLIENT.set(ClientContext(**ctx).model_dump(exclude_none=True))
        return await fn(*args)

    return asyncio.run(go())


def test_history_is_bounded() -> None:
    too_many = {"interval_s": 10, "samples": [{"t": T0 + i} for i in range(61)]}
    for bad in (too_many, {"interval_s": 0, "samples": []}, {"interval_s": 10, "samples": [{"t": T0, "fps": -1}]}):
        try:
            ClientContext(history=bad)
        except ValidationError:
            continue
        raise AssertionError(f"accepted {bad}")


def test_one_metric_becomes_a_series_skipping_gaps() -> None:
    out = run({"history": HISTORY}, cm.run_client_history, {"metric": "rtt_ms"})
    assert out["points"] == [150, 300, 90], out
    assert (out["min"], out["max"], out["latest"], out["span_s"]) == (90, 300, 90, 20), out
    # pressure is missing in the middle sample: skipped, never drawn as 0
    out = run({"history": HISTORY}, cm.run_client_history, {"metric": "pressure"})
    assert out["points"] == [0, 2], out


def test_too_little_history_or_a_bad_metric_is_said_plainly() -> None:
    one = {"interval_s": 10, "samples": [{"t": T0, "rtt_ms": 1}]}
    assert "error" in run({"history": one}, cm.run_client_history, {"metric": "rtt_ms"})
    assert "error" in run({}, cm.run_client_history, {"metric": "rtt_ms"})
    assert "error" in run({"history": HISTORY}, cm.run_client_history, {"metric": "password"})


def test_preview_is_a_line_chart_of_that_metric() -> None:
    out = run({"history": HISTORY}, cm.run_client_history, {"metric": "battery_pct"})
    spec = cm.preview_client_history(out)
    assert spec["type"] == "line_3d"
    assert spec["data"]["series"] == [{"label": "BATTERY %", "points": [97, 96, 96]}], spec


def test_metrics_tool_does_not_dump_the_history() -> None:
    out = run({"cpu_cores": 4, "history": HISTORY}, cm.run_client_metrics, {})
    assert "history" not in out


def test_registered_as_a_low_risk_read() -> None:
    tool = registry.get("get_client_history")
    assert tool is not None and tool.risk == "low"
    assert tool.capabilities == ("client.read",)
    assert tool.input_schema["required"] == ["metric"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
