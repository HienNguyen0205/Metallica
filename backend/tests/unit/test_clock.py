"""The clock tool.

    PYTHONPATH=. python tests/unit/test_clock.py
"""

import asyncio
from datetime import datetime

from friday.tools.registry import REGISTRY


def test_it_is_reachable_and_needs_no_confirmation():
    tool = REGISTRY["get_current_time"]
    assert tool.risk == "low"
    assert tool.needs_confirmation() is False, "asking the time must not stop on a human"


def test_the_time_it_reports_carries_an_offset():
    """Naive local time is the failure this tool exists to prevent.

    Drop the .astimezone() and `iso` still looks fine while `utc_offset` goes
    empty - the model then gets a wall-clock reading it cannot place, which is
    barely better than the date it used to invent.
    """
    output = asyncio.run(REGISTRY["get_current_time"].run({}))
    parsed = datetime.fromisoformat(output["iso"])
    assert parsed.tzinfo is not None, output
    assert output["utc_offset"], output
    # Catches a wrong strftime code: %a, %w and %d all render without error.
    assert output["weekday"] == parsed.strftime("%A"), output


def test_the_operators_clock_wins_when_their_browser_sent_it():
    """The HUD shows the operator's time; the tool must agree with it, not
    with a server that may sit in another timezone."""
    from friday.api.schemas import ClientContext
    from friday.tools.client.metrics import CLIENT

    async def as_operator():
        CLIENT.set(ClientContext(timezone="Asia/Saigon", utc_offset_min=420).model_dump(exclude_none=True))
        return await REGISTRY["get_current_time"].run({})

    output = asyncio.run(as_operator())
    assert output["utc_offset"] == "+0700", output
    assert output["timezone"] == "Asia/Saigon", output
    assert output["source"] == "operator", output
    assert datetime.fromisoformat(output["iso"]).utcoffset().total_seconds() == 7 * 3600


def test_without_client_data_it_reads_the_host_and_says_so():
    output = asyncio.run(REGISTRY["get_current_time"].run({}))
    assert output["source"] == "host", output


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all clock tests passed")
