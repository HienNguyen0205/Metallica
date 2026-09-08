"""API request/response schemas."""

from pydantic import BaseModel, Field


class Query(BaseModel):
    #: Bounded before any model call: an unbounded public string burns
    #: tokens/embeddings/memory per request (DoS on the provider bill).
    query: str = Field(min_length=1, max_length=4000)
    #: §15 — opaque, client-generated, and used only as a dict key. Bounded
    #: because it arrives from a public endpoint and an unbounded string would
    #: be stored verbatim.
    session_id: str | None = Field(default=None, max_length=64)


class Decision(BaseModel):
    #: uuid4.hex from the confirm event — pattern + length bound so /confirm
    #: cannot be used to probe arbitrary keys.
    id: str = Field(max_length=64, pattern="^[A-Za-z0-9_-]+$")
    approved: bool
