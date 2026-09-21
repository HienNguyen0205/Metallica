"""The operator's own device, as their browser reports it.

get_system_metrics reads the host this orchestrator runs on; that is the
server, not the person asking. The browser measures its own device without a
permission prompt (cores, memory class, Compute Pressure, battery, storage,
network) and sends it with each /query. It lives in CLIENT for that turn only
and reaches the model solely through this tool.
"""

from contextvars import ContextVar
from typing import Any

#: This turn's ClientContext as a dict, set by run_query. Tasks the turn
#: spawns copy it; nothing persists it.
CLIENT: ContextVar[dict[str, Any] | None] = ContextVar("client_context", default=None)

#: Compute Pressure is ordinal. Drawn on the gauge as quarter steps, with the
#: state named in the label so nobody reads it as a measured percentage.
_PRESSURE_PCT = {"nominal": 25, "fair": 50, "serious": 75, "critical": 100}


async def run_client_metrics(_: dict[str, Any]) -> dict[str, Any]:
    data = CLIENT.get()
    if not data:
        return {"error": "the browser sent no device readings for this turn"}
    # Location has its own tool and capability (client.location); history
    # has its own tool (get_client_history) and would swamp the context.
    return {k: v for k, v in data.items() if k not in ("location", "history")}


#: metric -> (series label, unit). The only keys get_client_history reads.
HISTORY_METRICS: dict[str, tuple[str, str]] = {
    "rtt_ms": ("LATENCY MS", "ms"),
    "downlink_mbps": ("DOWNLINK MBPS", "Mb/s"),
    "battery_pct": ("BATTERY %", "%"),
    "pressure": ("CPU PRESSURE 0-3", "level (0 nominal, 1 fair, 2 serious, 3 critical)"),
    "heap_mb": ("JS HEAP MB", "MB"),
    "fps": ("FRAME RATE", "fps"),
}


async def run_client_history(payload: dict[str, Any]) -> dict[str, Any]:
    metric = payload.get("metric")
    if metric not in HISTORY_METRICS:
        return {"error": f"unknown metric; choose one of {', '.join(HISTORY_METRICS)}"}
    history = (CLIENT.get() or {}).get("history") or {}
    # Samples missing this reading are skipped, never drawn as zero.
    samples = [s for s in history.get("samples", []) if s.get(metric) is not None]
    if len(samples) < 2:
        return {"error": "not enough history yet: the browser samples every few seconds while the tab is open"}
    points = [s[metric] for s in samples]
    return {
        "metric": metric,
        "unit": HISTORY_METRICS[metric][1],
        "interval_s": history.get("interval_s"),
        "span_s": samples[-1]["t"] - samples[0]["t"],
        "points": points,
        "min": min(points),
        "max": max(points),
        "latest": points[-1],
    }


def preview_client_history(output: dict[str, Any]) -> dict[str, Any]:
    label = HISTORY_METRICS[output["metric"]][0]
    minutes = max(1, round(output.get("span_s", 0) / 60))
    return {
        "type": "line_3d",
        "title": f"YOUR DEVICE · LAST {minutes} MIN",
        "data": {"series": [{"label": label, "points": output["points"]}]},
    }


async def run_client_location(_: dict[str, Any]) -> dict[str, Any]:
    data = CLIENT.get() or {}
    loc = data.get("location")
    if not loc:
        return {"error": "the operator has not shared their location"}
    out: dict[str, Any] = {"lat": loc["lat"], "lon": loc["lon"]}
    if loc.get("accuracy_m") is not None:
        out["accuracy_m"] = loc["accuracy_m"]
    if data.get("timezone"):
        out["timezone"] = data["timezone"]
    return out


def preview_client_location(output: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "globe",
        "title": "YOUR LOCATION",
        "data": {"points": [{"id": "you", "label": "YOU", "lat": output["lat"], "lon": output["lon"]}]},
    }


def shared_coordinates() -> set[str]:
    """This turn's shared coordinates as every string a fact might quote:
    the full fix and its 2-5 decimal roundings ("10.78" is still home)."""
    loc = (CLIENT.get() or {}).get("location")
    if not loc:
        return set()
    out: set[str] = set()
    for v in (loc["lat"], loc["lon"]):
        for d in range(2, 7):
            s = f"{round(v, d):.{d}f}".rstrip("0")
            # 10.0012 -> "10.00" -> "10.": a bare "10" is not a coordinate, and
            # matching it would refuse every fact that mentions ten.
            if not s.endswith("."):
                out.add(s)
    return out


def preview_client_metrics(output: dict[str, Any]) -> dict[str, Any]:
    """Gauges for the readings that really are 0-100; the rest stay in the
    answer. Missing readings are omitted, never drawn as zero."""
    metrics: list[dict[str, Any]] = []
    pressure = output.get("cpu_pressure")
    if pressure in _PRESSURE_PCT:
        metrics.append({"label": f"CPU {pressure.upper()}", "value": _PRESSURE_PCT[pressure], "unit": "%"})
    battery = output.get("battery") or {}
    if "level_pct" in battery:
        metrics.append({"label": "BATTERY", "value": battery["level_pct"], "unit": "%"})
    storage = output.get("storage") or {}
    if storage.get("quota_mb"):
        metrics.append({
            "label": "STORAGE",
            "value": round(100 * storage.get("usage_mb", 0) / storage["quota_mb"], 1),
            "unit": "%",
        })
    return {"type": "radial_gauge", "title": "YOUR DEVICE", "data": {"metrics": metrics}}
