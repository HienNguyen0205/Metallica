"""API request/response schemas."""

from typing import Literal

import logging

from pydantic import BaseModel, Field, ValidationError, field_validator

from friday.schemas.visualization import LatLon


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


class ClientLocation(BaseModel):
    """Shared only when the operator turns location on, at the precision the
    browser measured (high-accuracy fix). It lands in tool output and so in
    the run's persisted evidence — the operator's choice, made at the LOC
    button; `remember` still refuses to keep it (long_term.run_remember)."""

    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    #: The browser's 95% confidence radius for this fix, in metres.
    accuracy_m: float | None = Field(default=None, ge=0, le=1e7)

    @field_validator("lat", "lon")
    @classmethod
    def _trim(cls, value: float) -> float:
        # 6 decimals ≈ 11 cm: finer than any browser fix, so only noise goes.
        return round(value, 6)


class ClientSample(BaseModel):
    """One ring-buffer sample; any reading may be missing."""

    t: int = Field(ge=0, le=10**11)  # epoch seconds
    #: Compute Pressure as an ordinal: 0 nominal, 1 fair, 2 serious, 3 critical.
    pressure: int | None = Field(default=None, ge=0, le=3)
    battery_pct: float | None = Field(default=None, ge=0, le=100)
    rtt_ms: float | None = Field(default=None, ge=0, le=600_000)
    downlink_mbps: float | None = Field(default=None, ge=0, le=100_000)
    heap_mb: float | None = Field(default=None, ge=0, le=1e6)
    fps: float | None = Field(default=None, ge=0, le=1000)


class ClientHistory(BaseModel):
    """The browser's ring buffer: one sample per interval while visible."""

    interval_s: int = Field(ge=1, le=600)
    samples: list[ClientSample] = Field(max_length=60)


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
    #: Minutes east of UTC right now (-getTimezoneOffset()); lets the clock
    #: tool read the operator's time with the stdlib, no tz database needed.
    utc_offset_min: int | None = Field(default=None, ge=-840, le=840)
    languages: list[str] | None = Field(default=None, max_length=5)
    screen: ClientScreen | None = None
    location: ClientLocation | None = None
    history: ClientHistory | None = None


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


class RouteRequest(BaseModel):
    """POST /geo/route — validated here so GraphHopper only sees sane input
    (and no credit is spent on a request that could never succeed)."""

    waypoints: list[LatLon] = Field(min_length=2, max_length=5)
    #: None = the plan's default travel mode (see geo/graphhopper.py).
    profile: Literal["auto", "motor_scooter", "bicycle", "pedestrian"] | None = None
