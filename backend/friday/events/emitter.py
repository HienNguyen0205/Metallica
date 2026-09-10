"""Event emitter — thin wrapper around the SSE queue."""

from typing import Any

from .serializer import sse


class EventEmitter:
    """Collects SSE frames; can be swapped for WebSocket later."""

    def __init__(self) -> None:
        self._frames: list[str] = []

    async def state(self, state: str) -> str:
        frame = sse("state", {"state": state})
        self._frames.append(frame)
        return frame

    async def tool(self, tool: str, risk: str) -> str:
        frame = sse("tool", {"tool": tool, "risk": risk})
        self._frames.append(frame)
        return frame

    async def visualization(self, spec: dict[str, Any]) -> str:
        frame = sse("viz", spec)
        self._frames.append(frame)
        return frame

    async def answer(self, text: str) -> str:
        frame = sse("answer", {"text": text})
        self._frames.append(frame)
        return frame

    async def done(self) -> str:
        frame = sse("done", {})
        self._frames.append(frame)
        return frame

    async def error(self, message: str) -> str:
        frame = sse("error", {"message": message})
        self._frames.append(frame)
        return frame
