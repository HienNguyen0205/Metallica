"""Process list tool — top processes by memory share."""

from typing import Any

import psutil


async def run_process_list(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        limit = max(1, min(10, int(payload.get("limit", 5))))
    except (TypeError, ValueError):
        limit = 5

    seen: list[tuple[str, float]] = []
    for proc in psutil.process_iter(["name", "memory_percent"]):
        try:
            info = proc.info
            if info["name"] and info["memory_percent"]:
                seen.append((info["name"], round(info["memory_percent"], 2)))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    seen.sort(key=lambda row: row[1], reverse=True)
    top = seen[:limit]
    return {"ranked_by": "memory_percent", "processes": [{"name": n, "percent": v} for n, v in top]}


def preview_processes(output: dict[str, Any]) -> dict[str, Any]:
    rows = output.get("processes", [])
    return {
        "type": "bar_3d",
        "title": "TOP PROCESSES",
        "data": {"series": [{"label": "MEM", "points": [row["percent"] for row in rows]}]},
    }
