"""§11 — FRIDAY_CONFIRM_TIMEOUT_S sets how long an approval may wait.

.env.example and config.py both offer it, but the wait was a hard-coded
120s and the variable did nothing.

    PYTHONPATH=. python tests/unit/test_confirm_timeout_env.py
"""

import os

os.environ["FRIDAY_CONFIRM_TIMEOUT_S"] = "7.5"

from friday.api import dependencies as deps


def test_env_sets_the_approval_timeout() -> None:
    assert deps.CONFIRM_TIMEOUT_S == 7.5, deps.CONFIRM_TIMEOUT_S


if __name__ == "__main__":
    test_env_sets_the_approval_timeout()
    print("ok")
