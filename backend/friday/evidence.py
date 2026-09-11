"""P2 — evidence and claims. Tool results become source-backed Evidence
(provenance + confidence travel with the data); the final answer becomes a
Claim citing the evidence it rests on. Verification (replan step) flips claim
status later — collection here stays unverified by default.

No citations are injected into prompts: purely local measurements need no
footnotes, and the planner already receives the raw evidence verbatim.
"""

import time
from dataclasses import asdict, dataclass, field, fields
from typing import Any

#: source_type -> (provenance, confidence). Third-party text is suspect by
#: construction; direct measurements and the operator's own words are not.
_SOURCE_PROFILE: dict[str, tuple[str, float]] = {
    "search_web": ("external_source", 0.7),
    "remember": ("user", 1.0),
    "read_note": ("user", 1.0),
}
_DEFAULT_PROFILE: tuple[str, float] = ("system", 1.0)


@dataclass
class Evidence:
    evidence_id: str
    source_type: str  # tool | memory | model
    source_id: str  # tool name, memory id, model name
    content: dict[str, Any]
    retrieved_at: float = field(default_factory=time.time)
    confidence: float = 1.0
    provenance: str = "system"  # user | tool | system | model_inferred | external_source

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Evidence":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class Claim:
    claim_id: str
    statement: str
    evidence_ids: list[str] = field(default_factory=list)
    confidence: float = 1.0
    status: str = "unverified"  # unverified | supported | contradicted

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Claim":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})


def collect_tool_evidence(tool_name: str, output: dict[str, Any], seq: int) -> Evidence:
    """One tool result -> one Evidence. Failed outputs ({"error": ...}) are
    recorded too at confidence 0 — a failure is still a sourced observation."""
    provenance, confidence = _SOURCE_PROFILE.get(tool_name, _DEFAULT_PROFILE)
    if isinstance(output, dict) and "error" in output:
        confidence = 0.0
    return Evidence(
        evidence_id=f"e{seq}",
        source_type="tool",
        source_id=tool_name,
        content=output if isinstance(output, dict) else {"value": output},
        confidence=confidence,
        provenance=provenance,
    )


def build_answer_claim(answer: str, evidences: list[Evidence]) -> Claim:
    """The turn's final answer as one claim citing everything collected.
    Confidence is the weakest link; verification upgrades the status later."""
    ids = [e.evidence_id for e in evidences]
    confidence = min([e.confidence for e in evidences], default=1.0)
    return Claim(
        claim_id="c1",
        statement=answer[:500],
        evidence_ids=ids,
        confidence=confidence,
        status="unverified",
    )
