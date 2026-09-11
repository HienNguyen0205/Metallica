"""Centralised SSE event type constants."""

from typing import Final, Literal

EventKind = Literal["state", "tool", "confirm", "denied", "memory", "preview", "viz", "answer", "done", "error", "step"]

STATE: Final = "state"
TOOL: Final = "tool"
CONFIRM: Final = "confirm"
DENIED: Final = "denied"
MEMORY: Final = "memory"
PREVIEW: Final = "preview"
VIZ: Final = "viz"
ANSWER: Final = "answer"
DONE: Final = "done"
ERROR: Final = "error"
STEP: Final = "step"

ALL_EVENTS: Final = {STATE, TOOL, CONFIRM, DENIED, MEMORY, PREVIEW, VIZ, ANSWER, DONE, ERROR, STEP}
