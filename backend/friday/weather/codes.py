"""WMO weather interpretation codes (Open-Meteo `weather_code`) → Vietnamese."""

from typing import Any

_TEXT = {
    0: "trời quang", 1: "ít mây", 2: "nhiều mây", 3: "u ám",
    45: "sương mù", 48: "sương mù",
    51: "mưa phùn", 53: "mưa phùn", 55: "mưa phùn", 56: "mưa phùn", 57: "mưa phùn",
    61: "mưa nhẹ", 63: "mưa vừa", 65: "mưa to", 66: "mưa lạnh", 67: "mưa lạnh",
    71: "tuyết", 73: "tuyết", 75: "tuyết", 77: "tuyết", 85: "tuyết", 86: "tuyết",
    80: "mưa rào nhẹ", 81: "mưa rào", 82: "mưa rào lớn",
    95: "dông", 96: "dông kèm mưa đá", 99: "dông kèm mưa đá",
}


def describe(code: Any) -> str:
    try:
        return _TEXT.get(int(code), "không rõ")
    except (TypeError, ValueError):
        return "không rõ"
