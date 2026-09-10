"""Host clock.

Measured before this existed: asked the time, the model either searched the
public web and got it wrong by a day, or invented one outright ("07:11 March
30, 2025"). See docs/AGENTIC_MEMORY_RESULTS.md. SYSTEM already forbids both in
plain words and the model did it anyway — it had no way to know. This is the
way to know.

`weekday` is spelled out because the operator's own deploy window is stated as
a weekday, and asking a model to derive one from a date is a coin flip.
"""

from datetime import datetime
from typing import Any


async def run_current_time(_: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now().astimezone()
    return {
        "iso": now.isoformat(timespec="seconds"),
        "weekday": now.strftime("%A"),
        "timezone": now.tzname(),
        "utc_offset": now.strftime("%z"),
    }
