"""Eval gate: every decision-quality case must pass. The runner prints the
per-case breakdown; this file turns it into a CI verdict.

    PYTHONPATH=. python tests/integration/test_evals.py
"""

from evals.runner import run_all


def test_all_eval_cases_pass() -> None:
    summary = run_all()["summary"]
    assert summary["failed"] == 0, f"{summary['failed']} eval cases failing (see above)"
    assert summary["total"] >= 10, f"eval suite shrank to {summary['total']} cases"


if __name__ == "__main__":
    test_all_eval_cases_pass()
    print("all eval checks passed")
