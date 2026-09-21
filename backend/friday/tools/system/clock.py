"""Host clock.

Measured before this existed: asked the time, the model either searched the
public web and got it wrong by a day, or invented one outright ("07:11 March
30, 2025"). See docs/AGENTIC_MEMORY_RESULTS.md. SYSTEM already forbids both in
plain words and the model did it anyway — it had no way to know. This is the
way to know.

`weekday` is spelled out because the operator's own deploy window is stated as
a weekday, and asking a model to derive one from a date is a coin flip.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

from friday.tools.client.metrics import CLIENT


async def run_current_time(_: dict[str, Any]) -> dict[str, Any]:
    # The HUD clock shows the operator's time, so this must too: the host is
    # a server that can sit in any timezone. Offset, not a tz name, so no tz
    # database is needed (Windows has none without the tzdata package).
    client = CLIENT.get() or {}
    offset = client.get("utc_offset_min")
    if offset is not None:
        now = datetime.now(timezone(timedelta(minutes=offset)))
        name, source = client.get("timezone") or now.strftime("UTC%z"), "operator"
    else:
        now = datetime.now().astimezone()
        name, source = now.tzname(), "host"
    return {
        "iso": now.isoformat(timespec="seconds"),
        "weekday": now.strftime("%A"),
        "timezone": name,
        "utc_offset": now.strftime("%z"),
        "source": source,
    }
