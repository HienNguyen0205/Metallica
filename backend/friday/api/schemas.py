"""API request/response schemas."""

from typing import Literal

import logging

from pydantic import BaseModel, Field, ValidationError, field_validator


class RunBudget(BaseModel):
    """Per-run ceilings (P1.6). Wall-time and tool calls are enforced;
    token/search/context/cost keys are accepted for later metering phases."""

    max_wall_time_ms: int | None = Field(default=None, gt=0)
    max_tool_calls: int | None = Field(default=None, gt=0)
    max_tokens: int | None = Field(default=None, gt=0)
    max_search_calls: int | None = Field(default=None, gt=0)
    max_context_bytes: int | None = Field(default=None, gt=0)
    max_estimated_cost_usd: float | None = Field(default=None, gt=0)


class ClientBattery(BaseModel):
    level_pct: float = Field(ge=0, le=100)
    charging: bool | None = None


class ClientStorage(BaseModel):
    usage_mb: float = Field(ge=0, le=1e9)
    quota_mb: float = Field(gt=0, le=1e9)


class ClientNetwork(BaseModel):
    effective_type: Literal["slow-2g", "2g", "3g", "4g"] | None = None
    downlink_mbps: float | None = Field(default=None, ge=0, le=100_000)
    rtt_ms: float | None = Field(default=None, ge=0, le=600_000)


class ClientGpu(BaseModel):
    vendor: str | None = Field(default=None, max_length=40)
    architecture: str | None = Field(default=None, max_length=40)


class ClientScreen(BaseModel):
    width: int = Field(gt=0, le=20_000)
    height: int = Field(gt=0, le=20_000)
    dpr: float = Field(gt=0, le=10)


class ClientContext(BaseModel):
    """What the operator's browser measured about its own device — no
    permission prompt behind any of it. Every field optional and bounded:
    it arrives from a public endpoint. Unknown keys are ignored (pydantic's
    default), so a client cannot smuggle extra data into a tool output.

    Held for the turn only (friday.tools.client.metrics.CLIENT); the model
    sees it solely by calling get_client_metrics."""

    cpu_cores: int | None = Field(default=None, ge=1, le=1024)
    device_memory_gb: float | None = Field(default=None, gt=0, le=4096)
    #: Compute Pressure API state — an ordinal, not a percentage.
    cpu_pressure: Literal["nominal", "fair", "serious", "critical"] | None = None
    battery: ClientBattery | None = None
    storage: ClientStorage | None = None
    network: ClientNetwork | None = None
    js_heap_mb: float | None = Field(default=None, ge=0, le=1e6)
    gpu: ClientGpu | None = None
    platform: str | None = Field(default=None, max_length=40)
    timezone: str | None = Field(default=None, max_length=64)
    languages: list[str] | None = Field(default=None, max_length=5)
    screen: ClientScreen | None = None


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
    #: The browser's own device readings, for get_client_metrics.
    client: ClientContext | None = None

    @field_validator("client", mode="before")
    @classmethod
    def _drop_bad_client(cls, value: object) -> ClientContext | None:
        # A browser quirk must cost the readings, not 422 the whole question.
        if value is None:
            return None
        try:
            return ClientContext.model_validate(value)
        except ValidationError:
            logging.getLogger("friday").info("dropped an invalid client context")
            return None


class Decision(BaseModel):
    #: uuid4.hex from the confirm event — pattern + length bound so /confirm
    #: cannot be used to probe arbitrary keys.
    id: str = Field(max_length=64, pattern="^[A-Za-z0-9_-]+$")
    approved: bool
