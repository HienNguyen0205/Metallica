"""P0.2 §4 — first-class Run/Step model. In-memory, single-process by design
(the §11 approval dict already pins this service to one worker)."""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

StepKind = Literal[
    "plan", "reason", "search", "tool", "memory_read",
    "memory_write", "visualization", "verification", "answer",
]
RunStatus = Literal[
    "queued", "planning", "waiting_approval", "running",
    "verifying", "completed", "failed", "cancelled", "expired",
]
StepStatus = RunStatus

MAX_RUNS = 200
_TERMINAL: set[str] = {"completed", "failed", "cancelled", "expired"}


@dataclass
class AgentStep:
    step_id: str
    run_id: str
    turn_id: str
    kind: StepKind
    status: StepStatus
    tool_name: str | None = None
    input: dict[str, Any] | None = None
    output_summary: str | None = None
    evidence_ids: list[str] = field(default_factory=list)
    retry_count: int = 0
    started_at: float | None = None
    completed_at: float | None = None
    error: str | None = None

    def payload(self) -> dict[str, Any]:
        """Wire form — operational metadata only (§4.3)."""
        p: dict[str, Any] = {"step_id": self.step_id, "kind": self.kind, "status": self.status}
        if self.tool_name:
            p["tool"] = self.tool_name
        if self.output_summary:
            p["summary"] = self.output_summary
        if self.retry_count:
            p["retry_count"] = self.retry_count
        return p


@dataclass
class AgentRun:
    run_id: str
    session_id: str | None
    goal: str
    status: RunStatus = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    completed_at: float | None = None
    deadline: float | None = None    # P0.6
    budget: dict[str, Any] | None = None  # P0.7
    current_step_id: str | None = None
    steps: list[AgentStep] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class RunRegistry:
    """LRU-bounded run store. Sync methods on one asyncio loop — never blocks."""

    def __init__(self, cap: int = MAX_RUNS) -> None:
        self._cap = cap
        self._runs: dict[str, AgentRun] = {}

    def create(self, session_id: str | None, goal: str) -> AgentRun:
        run = AgentRun(run_id=f"run_{uuid.uuid4().hex[:12]}", session_id=session_id, goal=goal)
        self._runs[run.run_id] = run
        while len(self._runs) > self._cap:
            self._runs.pop(next(iter(self._runs)))
        return run

    def get(self, run_id: str) -> AgentRun | None:
        return self._runs.get(run_id)

    def begin(self, run_id: str) -> None:
        run = self._runs.get(run_id)
        if run and run.status == "queued":
            run.status = "running"
            run.started_at = time.time()

    def finish(self, run_id: str, status: RunStatus) -> None:
        run = self._runs.get(run_id)
        if run and run.status not in _TERMINAL:
            run.status = status
            run.completed_at = time.time()

    def record_step(self, run_id: str, payload: dict[str, Any]) -> None:
        """Update-or-create mirror of a wire step event."""
        run = self._runs.get(run_id)
        if not run:
            return
        sid = payload.get("step_id")
        step = next((s for s in run.steps if s.step_id == sid), None)
        if step is None:
            step = AgentStep(
                step_id=sid, run_id=run_id, turn_id=payload.get("turn_id", ""),
                kind=payload["kind"], status=payload["status"],
                tool_name=payload.get("tool"), output_summary=payload.get("summary"),
                retry_count=payload.get("retry_count", 0), started_at=time.time(),
            )
            run.steps.append(step)
            run.current_step_id = sid
            return
        step.status = payload["status"]
        if payload.get("summary"):
            step.output_summary = payload["summary"]
        if payload.get("error"):
            step.error = payload["error"]
        if step.status in _TERMINAL:
            step.completed_at = time.time()


REGISTRY = RunRegistry()
