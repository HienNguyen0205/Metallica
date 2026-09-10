"""SSE / agent event schemas."""

from typing import Any, Literal

from pydantic import BaseModel, Field

SSEEventKind = Literal["state", "tool", "confirm", "denied", "memory", "preview", "viz", "answer", "done", "error"]


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
