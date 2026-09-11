"""Verification and bounded re-planning (P2).

After the agent produces a final answer, verify_answer() runs deterministic
structural checks over the text and the collected evidence — no model call,
no cost, no latency. Semantic judgments (conflicting observations, stale
data, unsupported-but-plausible claims) need a model-graded verifier, which
is a later phase; v1 catches what structure alone can prove:

- empty_answer: the model stopped without answering.
- failed_support: every collected evidence failed (confidence 0).

Both are retryable: the loop gets the hint appended as a user message and one
bounded replan (MAX_REPLANS), on top of the turn loop's own MAX_TURNS ceiling.
Anything else passes; an exhausted budget leaves the answer standing
unverified rather than looping forever.
"""

from dataclasses import dataclass, field
from typing import Any

#: Verification-driven replans per run. 1 keeps plan->verify->replan->verify
#: from becoming an infinite loop; the turn loop bounds total work anyway.
MAX_REPLANS = 1


@dataclass
class Verdict:
    ok: bool
    issues: list[str] = field(default_factory=list)
    hint: str = ""
    retryable: bool = True


def verify_answer(text: str, evidences: list[Any]) -> Verdict:
    """Structural verdict on a final answer. Evidences are Evidence objects
    (confidence read off them); only .confidence is touched."""
    if not (text or "").strip():
        return Verdict(
            ok=False,
            issues=["empty_answer"],
            hint="produce a final answer instead of stopping silently",
            retryable=True,
        )
    if evidences and all((e.confidence or 0) <= 0 for e in evidences):
        return Verdict(
            ok=False,
            issues=["failed_support"],
            hint="every tool result failed — retry the tools or report the failure plainly",
            retryable=True,
        )
    return Verdict(ok=True)
