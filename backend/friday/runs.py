"""P0.2 §4 — first-class Run/Step model. In-memory, single-process by design
(the §11 approval dict already pins this service to one worker).

P1.9 — every mutation is persisted through a StateStore (friday/store.py):
live objects stay the operational truth, snapshots go durable. Swap the store
for RedisStateStore and other workers can read runs; nothing here imports
redis.
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from friday.store import InMemoryStateStore, StateStore, from_run_dict, to_run_dict

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

#: Cap on the per-run replay log (P1.10). Runs emit ~15 frames; 500 is
#: headroom, not a target — the log is truncated oldest-first past it.
MAX_STORED_EVENTS = 500


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
    turn_id: str | None = None
    plan: list[dict[str, Any]] | None = None
    evidence: list[dict[str, Any]] = field(default_factory=list)
    claims: list[dict[str, Any]] = field(default_factory=list)
    final_answer: str | None = None
    error: str | None = None
    events: list[dict[str, Any]] = field(default_factory=list)
    current_step_id: str | None = None
    steps: list[AgentStep] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class RunRegistry:
    """LRU-bounded run store. Sync methods on one asyncio loop — never blocks.

    Live AgentRun objects are the operational truth; each mutation also writes
    a snapshot to the StateStore, which is the durable cross-worker read path.
    """

    def __init__(self, cap: int = MAX_RUNS, store: StateStore | None = None) -> None:
        self._cap = cap
        self._runs: dict[str, AgentRun] = {}
        self._store: StateStore = store if store is not None else InMemoryStateStore()

    def _persist(self, run: AgentRun) -> None:
        self._store.save_run(to_run_dict(run))

    def get_stored(self, run_id: str) -> AgentRun | None:
        """Durable read (other workers, reconnect). None when never persisted."""
        data = self._store.get_run(run_id)
        return from_run_dict(data) if data is not None else None

    def create(self, session_id: str | None, goal: str) -> AgentRun:
        run = AgentRun(run_id=f"run_{uuid.uuid4().hex[:12]}", session_id=session_id, goal=goal)
        self._runs[run.run_id] = run
        while len(self._runs) > self._cap:
            evicted = next(iter(self._runs))
            self._runs.pop(evicted)
            self._store.delete_run(evicted)
        self._persist(run)
        return run

    def get(self, run_id: str) -> AgentRun | None:
        return self._runs.get(run_id)

    def begin(self, run_id: str) -> None:
        run = self._runs.get(run_id)
        if run and run.status == "queued":
            run.status = "running"
            run.started_at = time.time()
            self._persist(run)

    def update_status(self, run_id: str, status: RunStatus) -> bool:
        """Guarded non-terminal move. Terminal runs are never resurrected —
        use this instead of poking run.status directly (approval flow)."""
        run = self._runs.get(run_id)
        if run is None or run.status in _TERMINAL:
            return False
        run.status = status
        if status in _TERMINAL:
            run.completed_at = time.time()
        self._persist(run)
        return True

    def finish(self, run_id: str, status: RunStatus) -> None:
        self.update_status(run_id, status)

    def set_turn(self, run_id: str, turn_id: str) -> None:
        run = self._runs.get(run_id)
        if run and run.status not in _TERMINAL:
            run.turn_id = turn_id
            self._persist(run)

    def set_plan(self, run_id: str, plan: list[dict[str, Any]]) -> None:
        run = self._runs.get(run_id)
        if run and run.status not in _TERMINAL:
            run.plan = plan
            self._persist(run)

    def record_evidence(self, run_id: str, item: dict[str, Any]) -> None:
        run = self._runs.get(run_id)
        if run and run.status not in _TERMINAL:
            run.evidence.append(item)
            self._persist(run)

    def record_claim(self, run_id: str, claim: dict[str, Any]) -> None:
        run = self._runs.get(run_id)
        if run and run.status not in _TERMINAL:
            run.claims.append(claim)
            self._persist(run)

    def set_final(self, run_id: str, answer: str | None = None, error: str | None = None) -> None:
        run = self._runs.get(run_id)
        if run and run.status not in _TERMINAL:
            if answer is not None:
                run.final_answer = answer
            if error is not None:
                run.error = error
            self._persist(run)

    def set_metadata(self, run_id: str, mapping: dict[str, Any]) -> None:
        """Merge operational tags (request/trace ids). Never content."""
        run = self._runs.get(run_id)
        if run:
            run.metadata.update(mapping)
            self._persist(run)

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
            self._persist(run)
            return
        step.status = payload["status"]
        if payload.get("summary"):
            step.output_summary = payload["summary"]
        if payload.get("error"):
            step.error = payload["error"]
        if step.status in _TERMINAL:
            step.completed_at = time.time()
        self._persist(run)

    def record_event(self, run_id: str, sequence: int, event: str, payload: dict[str, Any]) -> None:
        """Append one enveloped frame to the replay log (P1.10). Read-only
        for everyone except the streaming worker; replay never re-executes."""
        run = self._runs.get(run_id)
        if run is None or run.status in _TERMINAL:
            return
        run.events.append({"sequence": sequence, "event": event, "payload": payload})
        del run.events[: max(0, len(run.events) - MAX_STORED_EVENTS)]
        self._persist(run)


REGISTRY = RunRegistry()
