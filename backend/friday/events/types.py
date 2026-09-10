"""Centralised SSE event type constants."""

from typing import Final, Literal

EventKind = Literal["state", "tool", "confirm", "denied", "preview", "viz", "answer", "done", "error"]

STATE: Final = "state"
TOOL: Final = "tool"
CONFIRM: Final = "confirm"
DENIED: Final = "denied"
PREVIEW: Final = "preview"
VIZ: Final = "viz"
ANSWER: Final = "answer"
DONE: Final = "done"
ERROR: Final = "error"

ALL_EVENTS: Final = {STATE, TOOL, CONFIRM, DENIED, PREVIEW, VIZ, ANSWER, DONE, ERROR}
