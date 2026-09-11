"""API request/response schemas."""

from pydantic import BaseModel, Field


class RunBudget(BaseModel):
    """Per-run ceilings (P1.6). Wall-time and tool calls are enforced;
    token/search/context/cost keys are accepted for later metering phases."""

    max_wall_time_ms: int | None = Field(default=None, gt=0)
    max_tool_calls: int | None = Field(default=None, gt=0)
    max_tokens: int | None = Field(default=None, gt=0)
    max_search_calls: int | None = Field(default=None, gt=0)
    max_context_bytes: int | None = Field(default=None, gt=0)
    max_estimated_cost_usd: float | None = Field(default=None, gt=0)


class Query(BaseModel):
    #: Bounded before any model call: an unbounded public string burns
    #: tokens/embeddings/memory per request (DoS on the provider bill).
    query: str = Field(min_length=1, max_length=4000)
    #: §15 — opaque, client-generated, and used only as a dict key. Bounded
    #: because it arrives from a public endpoint and an unbounded string would
    #: be stored verbatim.
    session_id: str | None = Field(default=None, max_length=64)
    #: Optional per-run ceilings; absent means unbounded (MAX_TURNS still caps
    #: the loop). Unknown keys are ignored by RunBudget, never trusted.
    budget: RunBudget | None = None


class Decision(BaseModel):
    #: uuid4.hex from the confirm event — pattern + length bound so /confirm
    #: cannot be used to probe arbitrary keys.
    id: str = Field(max_length=64, pattern="^[A-Za-z0-9_-]+$")
    approved: bool
