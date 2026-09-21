"""Renderer contract — mirrored from src/lib/visualization/types.ts.

Strictness note: VisualizationPlan (title + data + answer required) is
model-output validation, not wire validation. The canonical wire contract
(contracts/visualization/visualization.v1.json) requires only `type` — the
tolerant reader accepts minimal specs the planner would reject.
"""

from typing import Literal

from pydantic import BaseModel, Field

VisualizationType = Literal[
    "radial_gauge",
    "radar",
    "waveform",
    "network",
    "line_3d",
    "bar_3d",
    "globe",
    "timeline",
    "sankey_flow",
]


class MetricDatum(BaseModel):
    label: str
    value: float = Field(description="0-100; gauges read this as a percentage")
    unit: str | None = None


class SeriesDatum(BaseModel):
    label: str
    points: list[float]


class NodeDatum(BaseModel):
    id: str
    label: str | None = None


class GeoPoint(BaseModel):
    lat: float
    lon: float
    label: str | None = Field(default=None, description="short code, e.g. HAN")
    id: str | None = None
    value: float | None = None
    status: Literal["healthy", "warning", "critical", "offline"] | None = None
    color: str | None = None
    metadata: dict | None = None


class GlobeRoute(BaseModel):
    """Curved data connection between two globe markers; from/to reference
    points by id/label (string) or index (number)."""

    model_config = {"populate_by_name": True}

    id: str
    from_: str | int = Field(alias="from")
    to: str | int
    value: float | None = None
    latencyMs: float | None = None
    status: Literal["healthy", "warning", "critical"] | None = None


class TimelineEvent(BaseModel):
    label: str
    at: float = Field(description="position along the axis, 0.0 to 1.0")


class VizData(BaseModel):
    """Every field optional: each renderer reads only the ones it needs."""

    metrics: list[MetricDatum] | None = None
    series: list[SeriesDatum] | None = None
    nodes: list[NodeDatum] | None = None
    links: list[list[int]] | None = None
    points: list[GeoPoint] | None = None
    routes: list[GlobeRoute] | None = None
    events: list[TimelineEvent] | None = None
    rate: float | None = None


class VisualizationPlan(BaseModel):
    """What the model returns for one query."""

    type: VisualizationType
    title: str = Field(description="short all-caps heading, 2-4 words")
    animation: Literal["materialize", "pulse", "none"] = "materialize"
    interaction: Literal["none", "drill_down"] = "drill_down"
    data: VizData
    answer: str = Field(description="one or two spoken sentences, under 30 words")
