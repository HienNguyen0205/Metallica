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
    # Location has its own tool and capability (client.location).
    return {k: v for k, v in data.items() if k != "location"}


async def run_client_location(_: dict[str, Any]) -> dict[str, Any]:
    data = CLIENT.get() or {}
    loc = data.get("location")
    if not loc:
        return {"error": "the operator has not shared their location"}
    out: dict[str, Any] = {"lat": loc["lat"], "lon": loc["lon"]}
    if data.get("timezone"):
        out["timezone"] = data["timezone"]
    # Rounded to two decimals on arrival (schemas.ClientLocation).
    out["precision_km"] = 1
    return out


def preview_client_location(output: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "globe",
        "title": "YOUR LOCATION",
        "data": {"points": [{"id": "you", "label": "YOU", "lat": output["lat"], "lon": output["lon"]}]},
    }


def shared_coordinates() -> tuple[str, str] | None:
    """This turn's shared coordinates as the strings a fact would quote."""
    loc = (CLIENT.get() or {}).get("location")
    return (str(loc["lat"]), str(loc["lon"])) if loc else None


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
