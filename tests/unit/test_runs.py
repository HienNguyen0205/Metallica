"""P0.2 §4 — Run/Step model: registry cap, ids, transitions, retry mirror.

    PYTHONPATH=. python tests/unit/test_runs.py
"""

from friday.runs import REGISTRY, AgentStep, RunRegistry


def test_create_makes_unique_ids_and_defaults() -> None:
    r = RunRegistry()
    a = r.create("sess_1", "what is my disk")
    b = r.create("sess_1", "and cpu")
    assert a.run_id != b.run_id and a.run_id.startswith("run_")
    assert a.status == "queued" and a.goal == "what is my disk"
    assert a.steps == [] and a.budget is None and a.deadline is None
    assert a.started_at is None and a.completed_at is None


def test_registry_is_lru_capped_at_200() -> None:
    r = RunRegistry()
    first = r.create(None, "first").run_id
    for _ in range(205):
        r.create(None, "filler")
    assert r.get(first) is None, "oldest evicted past the cap"
    assert len(r._runs) == 200


def test_begin_only_from_queued_and_finish_is_terminal() -> None:
    r = RunRegistry()
    run = r.create(None, "q")
    r.begin(run.run_id)
    assert run.status == "running" and run.started_at is not None
    r.begin(run.run_id)  # second begin is a no-op
    assert run.status == "running"
    r.finish(run.run_id, "completed")
    assert run.completed_at is not None
    r.finish(run.run_id, "failed")  # terminal is never overwritten
    assert run.status == "completed"


def test_record_step_updates_in_place() -> None:
    r = RunRegistry()
    run = r.create(None, "q")
    r.record_step(run.run_id, {"step_id": "s1", "turn_id": "turn_1", "kind": "tool", "status": "running", "tool": "get_system_metrics"})
    r.record_step(run.run_id, {"step_id": "s1", "turn_id": "turn_1", "kind": "tool", "status": "completed", "summary": "CPU 73%"})
    assert len(run.steps) == 1, "transition updates, not appends"
    step = run.steps[0]
    assert step.status == "completed" and step.output_summary == "CPU 73%"
    assert step.completed_at is not None and run.current_step_id == "s1"


def test_record_step_ignores_unknown_run() -> None:
    RunRegistry().record_step("run_nope", {"step_id": "s1", "turn_id": "turn_1", "kind": "tool", "status": "running"})
    assert True  # must not raise


def test_step_payload_is_operational_metadata_only() -> None:
    s = AgentStep(step_id="s1", run_id="run_1", turn_id="turn_1", kind="tool", status="running", tool_name="search_web", retry_count=2)
    p = s.payload()
    assert p == {"step_id": "s1", "kind": "tool", "status": "running", "tool": "search_web", "retry_count": 2}
    s2 = AgentStep(step_id="s2", run_id="run_1", turn_id="turn_1", kind="answer", status="completed")
    assert s2.payload() == {"step_id": "s2", "kind": "answer", "status": "completed"}
    assert "input" not in s.payload() and "output_summary" not in s.payload()


def test_module_singleton_exists() -> None:
    assert isinstance(REGISTRY, RunRegistry)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
