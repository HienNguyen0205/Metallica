"""System metrics tool — host CPU/memory/disk."""

from pathlib import Path
from typing import Any

import psutil


async def run_system_metrics(_: dict[str, Any]) -> dict[str, Any]:
    psutil.cpu_percent(interval=None)
    disk = psutil.disk_usage(str(Path.home().anchor or "/"))
    return {
        "cpu_percent": round(psutil.cpu_percent(interval=0.15), 1),
        "memory_percent": round(psutil.virtual_memory().percent, 1),
        "disk_percent": round(disk.percent, 1),
        "cpu_count": psutil.cpu_count(logical=True),
    }


def preview_metrics(output: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "radial_gauge",
        "title": "SYSTEM LOAD",
        "data": {
            "metrics": [
                {"label": "CPU", "value": output.get("cpu_percent", 0), "unit": "%"},
                {"label": "RAM", "value": output.get("memory_percent", 0), "unit": "%"},
                {"label": "DISK", "value": output.get("disk_percent", 0), "unit": "%"},
            ]
        },
    }
