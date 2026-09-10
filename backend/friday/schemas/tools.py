"""Tool call/result schemas."""

from typing import Any, Literal

from pydantic import BaseModel

RiskLevel = Literal["low", "medium", "high"]


class ToolCall(BaseModel):
    tool: str
    input: dict[str, Any]


class ToolResult(BaseModel):
    tool: str
    output: dict[str, Any]


class ToolEvidence(BaseModel):
    tool: str
    output: dict[str, Any]
