"""SSE / agent event schemas."""

from typing import Any, Literal

from pydantic import BaseModel, Field

SSEEventKind = Literal["state", "tool", "confirm", "denied", "memory", "preview", "viz", "answer", "done", "error", "step"]


class StateEvent(BaseModel):
    state: str


class ToolEvent(BaseModel):
    tool: str
    risk: str


class ConfirmEvent(BaseModel):
    id: str
    tool: str
    risk: str
    input: dict[str, Any]


class AnswerEvent(BaseModel):
    text: str


class ErrorEvent(BaseModel):
    message: str


class DoneEvent(BaseModel):
    pass


class DeniedEvent(BaseModel):
    tool: str


class MemoryEvent(BaseModel):
    id: int
    fact: str
    provenance: str = "user"


class StepEvent(BaseModel):
    step_id: str
    turn_id: str
    kind: str
    status: str
    tool: str | None = None
    summary: str | None = None
    retry_count: int = 0
    error: str | None = None
