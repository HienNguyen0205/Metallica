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


def test_update_status_guards_terminal_runs() -> None:
    r = RunRegistry()
    run = r.create(None, "q")
    assert r.update_status(run.run_id, "planning") is True
    assert r.update_status(run.run_id, "waiting_approval") is True
    assert r.update_status(run.run_id, "running") is True
    assert run.status == "running" and run.completed_at is None
    r.finish(run.run_id, "completed")
    assert r.update_status(run.run_id, "running") is False
    assert run.status == "completed", "terminal runs are never resurrected"


def test_first_class_run_fields_accumulate() -> None:
    r = RunRegistry()
    run = r.create("sess_1", "disk and cpu")
    assert run.turn_id is None and run.plan is None
    assert run.evidence == [] and run.final_answer is None and run.error is None
    r.begin(run.run_id)
    r.set_turn(run.run_id, "turn_1")
    r.set_plan(run.run_id, [{"id": "A", "goal": "collect metrics"}])
    r.record_evidence(run.run_id, {"evidence_id": "e1", "content": "CPU 73%"})
    r.set_final(run.run_id, answer="CPU 73 percent.")
    assert run.turn_id == "turn_1"
    assert run.plan == [{"id": "A", "goal": "collect metrics"}]
    assert run.evidence == [{"evidence_id": "e1", "content": "CPU 73%"}]
    assert run.final_answer == "CPU 73 percent." and run.error is None
    r.set_final(run.run_id, error="planner unavailable")
    assert run.error == "planner unavailable"
    # writes stop at the terminal edge
    r.finish(run.run_id, "completed")
    r.set_final(run.run_id, answer="too late")
    r.record_evidence(run.run_id, {"evidence_id": "e2"})
    assert run.final_answer == "CPU 73 percent." and len(run.evidence) == 1


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
