"""P1.9 — StateStore: both backends honor the same contract, the factory
picks by env, and the registry persists every mutation write-through.

    PYTHONPATH=. python tests/unit/test_store.py
"""

import json
import os

from friday.runs import AgentRun, AgentStep, RunRegistry
from friday.store import (
    InMemoryStateStore,
    RedisStateStore,
    from_run_dict,
    get_store,
    to_run_dict,
)


class FakeSyncRedis:
    """redis.Redis-compatible surface (decode_responses=True): get/set/delete/keys."""

    def __init__(self) -> None:
        self._d: dict[str, str] = {}

    def get(self, key):
        return self._d.get(key)

    def set(self, key, value):
        self._d[key] = value
        return True

    def delete(self, *keys):
        n = 0
        for key in keys:
            if self._d.pop(key, None) is not None:
                n += 1
        return n

    def keys(self, pattern="*"):
        import fnmatch

        return [k for k in self._d if fnmatch.fnmatch(k, pattern)]


def exercise_crud(make_store) -> None:
    store = make_store()
    assert store.get_run("run_nope") is None
    assert store.update_run("run_nope", {"status": "failed"}) is False
    assert store.delete_run("run_nope") is False

    store.save_run({"run_id": "run_b", "status": "queued", "created_at": 2.0})
    store.save_run({"run_id": "run_a", "status": "running", "created_at": 1.0})
    assert store.get_run("run_a")["status"] == "running"
    assert store.update_run("run_a", {"status": "completed"}) is True
    assert store.get_run("run_a")["status"] == "completed"
    assert [r["run_id"] for r in store.list_runs()] == ["run_a", "run_b"]
    assert store.delete_run("run_a") is True
    assert store.get_run("run_a") is None
    assert [r["run_id"] for r in store.list_runs()] == ["run_b"]


def exercise_approvals(make_store) -> None:
    store = make_store()
    assert store.get_approval("req_1") is None
    assert store.resolve_approval("req_1") is None
    store.save_approval("req_1", {"tool": "write_note", "risk": "high"})
    assert store.get_approval("req_1")["tool"] == "write_note"
    first = store.resolve_approval("req_1")
    assert first == {"tool": "write_note", "risk": "high"}
    # exactly-once: the second resolution finds nothing
    assert store.resolve_approval("req_1") is None
    assert store.get_approval("req_1") is None


def test_memory_store_honors_contract() -> None:
    exercise_crud(InMemoryStateStore)
    exercise_approvals(InMemoryStateStore)


def test_redis_store_honors_contract() -> None:
    exercise_crud(lambda: RedisStateStore(FakeSyncRedis()))
    exercise_approvals(lambda: RedisStateStore(FakeSyncRedis()))


def test_redis_roundtrip_is_json_clean() -> None:
    fake = FakeSyncRedis()
    store = RedisStateStore(fake)
    run = AgentRun(run_id="run_1", session_id="s", goal="q", status="running",
                   turn_id="turn_1", plan=[{"id": "A"}],
                   steps=[AgentStep(step_id="s1", run_id="run_1", turn_id="turn_1",
                                    kind="tool", status="completed", tool_name="t")])
    run.evidence.append({"evidence_id": "e1"})
    store.save_run(to_run_dict(run))
    raw = fake.get("friday:run:run_1")
    json.loads(raw)  # must be plain JSON, not pickle
    back = from_run_dict(store.get_run("run_1"))
    assert back.run_id == "run_1" and back.status == "running"
    assert back.turn_id == "turn_1" and back.plan == [{"id": "A"}]
    assert len(back.steps) == 1 and back.steps[0].tool_name == "t"
    assert back.evidence == [{"evidence_id": "e1"}]


def test_from_run_dict_drops_unknown_keys() -> None:
    back = from_run_dict({"run_id": "r", "session_id": None, "goal": "g",
                          "future_field": 1, "steps": [{"step_id": "s", "run_id": "r",
                                                        "turn_id": "t", "kind": "tool",
                                                        "status": "running", "nope": 2}]})
    assert back.run_id == "r" and not hasattr(back, "future_field")
    assert not hasattr(back.steps[0], "nope")


def test_factory_defaults_to_memory() -> None:
    old = os.environ.pop("FRIDAY_STATE_BACKEND", None)
    try:
        assert isinstance(get_store(), InMemoryStateStore)
        assert isinstance(get_store("memory"), InMemoryStateStore)
    finally:
        if old is not None:
            os.environ["FRIDAY_STATE_BACKEND"] = old


def test_factory_rejects_unknown_backend() -> None:
    try:
        get_store("postgres")
    except ValueError as err:
        assert "memory|redis" in str(err)
    else:
        raise AssertionError("unknown backend must fail loudly")


def test_factory_redis_without_package_fails_loudly() -> None:
    try:
        import redis  # noqa: F401
    except ImportError:
        try:
            get_store("redis")
        except RuntimeError as err:
            assert "pip install redis" in str(err)
        else:
            raise AssertionError("missing redis package must fail loudly")
    else:
        print("  skip redis-missing test (redis is installed)")


def test_registry_persists_write_through() -> None:
    store = InMemoryStateStore()
    r = RunRegistry(cap=2, store=store)
    run = r.create("sess_1", "q")
    assert store.get_run(run.run_id)["status"] == "queued"
    r.begin(run.run_id)
    assert store.get_run(run.run_id)["status"] == "running"
    r.set_turn(run.run_id, "turn_1")
    r.record_step(run.run_id, {"step_id": "s1", "turn_id": "turn_1",
                               "kind": "tool", "status": "completed"})
    r.set_final(run.run_id, answer="done")
    snap = store.get_run(run.run_id)
    assert snap["turn_id"] == "turn_1" and snap["final_answer"] == "done"
    assert len(snap["steps"]) == 1 and snap["steps"][0]["status"] == "completed"
    stored = r.get_stored(run.run_id)
    assert stored is not None and stored.run_id == run.run_id
    assert stored.steps[0].tool_name is None or isinstance(stored.steps[0].tool_name, str)
    assert r.get_stored("run_nope") is None
    # eviction removes the durable copy too
    first = run.run_id
    r.create(None, "b")
    r.create(None, "c")
    assert store.get_run(first) is None, "evicted runs leave no snapshot behind"
    assert len(store.list_runs()) == 2


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
