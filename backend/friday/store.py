"""P1.9 — durable run/approval storage behind a StateStore abstraction.

Agent code talks to RunRegistry (runs.py), which persists every mutation
through a StateStore. The default is in-memory; point FRIDAY_STATE_BACKEND at
redis and the same call sites become durable and readable from any worker —
without the agent code importing redis anywhere.

Single-writer note: two workers mutating one run last-write-wins. Runs are
owned by the worker streaming them; other workers only *read* (reconnect and
cancel lookups — P1.10). Cross-worker approval waits are still PENDING futures
(STEP 8); the approval *records* here let any worker see what is pending.

The interface is deliberately synchronous: registry call sites are sync, and a
local Redis round trip is sub-millisecond. No redis package is required unless
the redis backend is selected — the import happens inside the factory with a
clear error otherwise.
"""

import dataclasses
import fnmatch
import json
import os
from abc import ABC, abstractmethod
from typing import Any

RUN_PREFIX = "friday:run:"
APPROVAL_PREFIX = "friday:approval:"


class StateStore(ABC):
    """Durable snapshots of runs plus approval request records."""

    @abstractmethod
    def save_run(self, run: dict[str, Any]) -> None:
        """Upsert a run snapshot (must contain run_id)."""

    @abstractmethod
    def get_run(self, run_id: str) -> dict[str, Any] | None:
        ...

    @abstractmethod
    def update_run(self, run_id: str, fields: dict[str, Any]) -> bool:
        """Patch a stored run; False when missing."""

    @abstractmethod
    def delete_run(self, run_id: str) -> bool:
        ...

    @abstractmethod
    def list_runs(self) -> list[dict[str, Any]]:
        """All snapshots, oldest first by created_at."""

    @abstractmethod
    def save_approval(self, request_id: str, record: dict[str, Any]) -> None:
        ...

    @abstractmethod
    def get_approval(self, request_id: str) -> dict[str, Any] | None:
        ...

    @abstractmethod
    def resolve_approval(self, request_id: str) -> dict[str, Any] | None:
        """Atomic pop: returns the record once, None when already resolved."""


class InMemoryStateStore(StateStore):
    """Local tests and single-process deploys. No serialization involved."""

    def __init__(self) -> None:
        self._runs: dict[str, dict[str, Any]] = {}
        self._approvals: dict[str, dict[str, Any]] = {}

    def save_run(self, run: dict[str, Any]) -> None:
        self._runs[run["run_id"]] = dict(run)

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        found = self._runs.get(run_id)
        return dict(found) if found is not None else None

    def update_run(self, run_id: str, fields: dict[str, Any]) -> bool:
        if run_id not in self._runs:
            return False
        self._runs[run_id].update(fields)
        return True

    def delete_run(self, run_id: str) -> bool:
        return self._runs.pop(run_id, None) is not None

    def list_runs(self) -> list[dict[str, Any]]:
        return [dict(r) for r in sorted(self._runs.values(), key=lambda r: r.get("created_at") or 0)]

    def save_approval(self, request_id: str, record: dict[str, Any]) -> None:
        self._approvals[request_id] = dict(record)

    def get_approval(self, request_id: str) -> dict[str, Any] | None:
        found = self._approvals.get(request_id)
        return dict(found) if found is not None else None

    def resolve_approval(self, request_id: str) -> dict[str, Any] | None:
        found = self._approvals.pop(request_id, None)
        return dict(found) if found is not None else None


class RedisStateStore(StateStore):
    """Shared storage. `client` is any sync object with get/set/delete/keys
    like redis.Redis (decode_responses=True). Pass a fake in tests."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def _run_key(self, run_id: str) -> str:
        return f"{RUN_PREFIX}{run_id}"

    def _approval_key(self, request_id: str) -> str:
        return f"{APPROVAL_PREFIX}{request_id}"

    def save_run(self, run: dict[str, Any]) -> None:
        self._client.set(self._run_key(run["run_id"]), json.dumps(run))

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        raw = self._client.get(self._run_key(run_id))
        return json.loads(raw) if raw is not None else None

    def update_run(self, run_id: str, fields: dict[str, Any]) -> bool:
        current = self.get_run(run_id)
        if current is None:
            return False
        current.update(fields)
        self.save_run(current)
        return True

    def delete_run(self, run_id: str) -> bool:
        return bool(self._client.delete(self._run_key(run_id)))

    def list_runs(self) -> list[dict[str, Any]]:
        runs = []
        for key in self._client.keys(f"{RUN_PREFIX}*"):
            raw = self._client.get(key)
            if raw is not None:
                runs.append(json.loads(raw))
        return sorted(runs, key=lambda r: r.get("created_at") or 0)

    def save_approval(self, request_id: str, record: dict[str, Any]) -> None:
        self._client.set(self._approval_key(request_id), json.dumps(record))

    def get_approval(self, request_id: str) -> dict[str, Any] | None:
        raw = self._client.get(self._approval_key(request_id))
        return json.loads(raw) if raw is not None else None

    def resolve_approval(self, request_id: str) -> dict[str, Any] | None:
        # get+delete is two round trips; single-process callers hold no lock
        # and multi-worker resolution races resolve to exactly one winner only
        # with Lua — acceptable until STEP 8 puts waits on this store.
        record = self.get_approval(request_id)
        if record is None:
            return None
        self._client.delete(self._approval_key(request_id))
        return record


def match_keys(keys: list[str], pattern: str) -> list[str]:
    """Test helper mirroring glob-style KEYS for fake clients."""
    return [k for k in keys if fnmatch.fnmatch(k, pattern)]


def to_run_dict(run: Any) -> dict[str, Any]:
    """AgentRun dataclass -> JSON-safe snapshot (nested steps included)."""
    return dataclasses.asdict(run)


def from_run_dict(data: dict[str, Any]) -> Any:
    """Snapshot -> AgentRun. Unknown keys are dropped (forward compatible)."""
    from friday.runs import AgentRun, AgentStep

    step_fields = {f.name for f in dataclasses.fields(AgentStep)}
    run_fields = {f.name for f in dataclasses.fields(AgentRun)}
    steps = [
        AgentStep(**{k: v for k, v in s.items() if k in step_fields})
        for s in data.get("steps") or []
    ]
    clean = {k: v for k, v in data.items() if k in run_fields and k != "steps"}
    return AgentRun(steps=steps, **clean)


def get_store(backend: str | None = None, redis_url: str | None = None) -> StateStore:
    """Factory. memory (default) needs nothing; redis needs the redis package
    and a reachable server — both reported loudly, never silently ignored."""
    backend = backend or os.getenv("FRIDAY_STATE_BACKEND", "memory")
    if backend == "memory":
        return InMemoryStateStore()
    if backend == "redis":
        try:
            import redis
        except ImportError:
            raise RuntimeError(
                "FRIDAY_STATE_BACKEND=redis needs the redis package: "
                "pip install redis (and a server at FRIDAY_REDIS_URL)"
            )
        url = redis_url or os.getenv("FRIDAY_REDIS_URL", "redis://localhost:6379/0")
        return RedisStateStore(redis.Redis.from_url(url, decode_responses=True))
    raise ValueError(f"unknown state backend {backend!r} (want memory|redis)")
