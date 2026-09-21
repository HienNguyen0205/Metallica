"""recall_block refreshes last_used_at on an executor thread and never awaits
the future, so an exception there used to vanish into asyncio's "exception
never retrieved". _touch must log it itself and never raise.

    PYTHONPATH=. python tests/unit/test_touch_logging.py
"""

import logging

from friday.api import routes
from friday.memory import store


class Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def test_touch_failure_is_logged_not_raised() -> None:
    def boom(ids):
        raise ValueError("bad id")

    original = store.touch
    store.touch = boom
    handler = Capture()
    logging.getLogger("friday").addHandler(handler)
    try:
        routes._touch([1])
    finally:
        store.touch = original
        logging.getLogger("friday").removeHandler(handler)
    assert any(r.levelno == logging.WARNING and r.exc_info for r in handler.records), handler.records


if __name__ == "__main__":
    test_touch_failure_is_logged_not_raised()
    print("ok")
