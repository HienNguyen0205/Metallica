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


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all clock tests passed")
