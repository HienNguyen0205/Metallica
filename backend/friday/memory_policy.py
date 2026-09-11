"""Memory policy and layers (P2).

Layers: working (short-term session history, memory/short_term.py), episodic
(past interactions — the default for legacy rows), semantic (durable facts),
preference (operator tastes), evidence (source-backed observations).

The LLM only *proposes* memory (a fact string via the remember tool).
propose() validates, deduplicates, contradiction-checks and types it before
anything persists:

- validate: non-empty, length-capped (done by the caller), plus injection
  screening for tool-provenance proposals — hostile pages reach the model
  through search_web, and without this gate one hostile line becomes a
  permanent prompt resident. The operator's own words are trusted, matching
  the recall fence philosophy.
- deduplicate: cosine against existing embeddings; near-identical facts reuse
  the row instead of forking it.
- contradiction: same normalized claim with flipped negation supersedes the
  old row (preferences change; "I like X" then "I don't like X" replaces).
- classify: deterministic preference-vs-semantic heuristic; episodic is the
  legacy default, evidence is reserved for sourced observations.

Every item carries the plan's full field set: memory_id/type/content/source/
provenance/confidence/created_at/updated_at/last_used_at/ttl. TTL is stored,
not yet enforced.
"""

import math
import re
from dataclasses import dataclass, field
from typing import Any, Literal

MemoryType = Literal["working", "episodic", "semantic", "preference", "evidence"]

#: Cosine at or above this means "same fact, don't fork a row". Far above the
#: 0.58 recall floor on purpose: recall wants related, dedup wants identical.
DEDUP_SIMILARITY = 0.95

#: Tokens whose presence flips a claim's polarity for contradiction checks.
_NEGATIONS = frozenset({
    "not", "no", "never", "n't", "dont", "don't", "doesnt", "doesn't",
    "isnt", "isn't", "cant", "can't", "wont", "won't", "against", "stop",
})

#: Heuristic preference signals for classification.
_PREFERENCE_RE = re.compile(
    r"\b(prefer|prefers|preferred|like|likes|love|loves|hate|hates|always|never"
    r"|favorite|favourite|my default)\b",
    re.IGNORECASE,
)

#: Prompt-injection shapes rejected on tool-provenance proposals only. Small
#: and explicit rather than clever: a blocklist that stays readable beats a
#: classifier nobody can audit, and the recall fence stays the second layer.
_INJECTION_RES = [
    re.compile(r"ignore\s+(all\s+|the\s+|your\s+)?(previous|prior|above)\s+instructions?", re.I),
    re.compile(r"disregard\s+.*instructions?", re.I),
    re.compile(r"\byou\s+are\s+now\b", re.I),
    re.compile(r"(new\s+)?system\s+prompt", re.I),
    re.compile(r"reveal\s+(your\s+|the\s+)?(system\s+prompt|instructions|prompt)", re.I),
    re.compile(r"\bjailbreak\b", re.I),
    re.compile(r"\bbypass\s+(the\s+)?(safety|filter|policy|approval)", re.I),
]

ProposalAction = Literal["accept", "duplicate", "supersede", "reject"]


@dataclass(frozen=True)
class Proposal:
    action: ProposalAction
    memory_type: MemoryType = "semantic"
    confidence: float = 1.0
    reason: str = ""
    duplicate_of: int | None = None
    replaces: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s']", "", text.lower())).strip()


def negation_signature(text: str) -> tuple[str, bool]:
    """(claim key, negated). 'I don't like X' and 'I like X' share a key with
    opposite polarity — that is a contradiction, not a duplicate."""
    tokens = _normalize(text).split()
    negated = any(t in _NEGATIONS or t.endswith("n't") for t in tokens)
    key = " ".join(t for t in tokens if t not in _NEGATIONS and not t.endswith("n't"))
    return key, negated


def classify(fact: str) -> MemoryType:
    """Deterministic preference-vs-semantic split for new proposals."""
    return "preference" if _PREFERENCE_RE.search(fact) else "semantic"


def confidence_for(provenance: str) -> float:
    """Suspect sources count less. model_inferred is never authoritative."""
    return {"user": 1.0, "system": 1.0, "tool": 0.7,
            "external_source": 0.7, "model_inferred": 0.5}.get(provenance, 0.7)


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    denom = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return sum(x * y for x, y in zip(a, b)) / denom if denom else 0.0


def propose(
    fact: str,
    provenance: str,
    embedding: list[float],
    existing: list[Any],
) -> Proposal:
    """Gate a memory write. `existing` are Memory-likes with .id/.fact/.embedding."""
    text = (fact or "").strip()
    if not text:
        return Proposal("reject", reason="empty fact")

    if provenance in ("tool", "external_source"):
        for pattern in _INJECTION_RES:
            if pattern.search(text):
                return Proposal("reject", reason="prompt-injection pattern")

    key, negated = negation_signature(text)
    for memory in existing:
        other_key, other_negated = negation_signature(memory.fact or "")
        if key and key == other_key and negated != other_negated:
            return Proposal(
                "supersede",
                memory_type=classify(text),
                confidence=confidence_for(provenance),
                reason="contradicts earlier memory",
                replaces=memory.id,
            )

    for memory in existing:
        try:
            score = cosine(embedding, memory.embedding or [])
        except (TypeError, ValueError):
            continue
        if score >= DEDUP_SIMILARITY:
            return Proposal(
                "duplicate",
                reason="near-identical memory already stored",
                duplicate_of=memory.id,
            )

    return Proposal(
        "accept",
        memory_type=classify(text),
        confidence=confidence_for(provenance),
        reason="validated proposal",
    )
