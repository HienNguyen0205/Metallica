"""Renderer contract — mirrored from src/lib/store.ts."""

from typing import Literal

from pydantic import BaseModel, Field

VisualizationType = Literal[
    "radial_gauge",
    "health_core",
    "radar",
    "waveform",
    "network",
    "line_3d",
    "bar_3d",
    "particle_flow",
    "globe",
    "timeline",
    "heatmap_3d",
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
