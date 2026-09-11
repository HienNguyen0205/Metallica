"""Identity and audit: anonymous by default, ownership enforced when
identified, every sensitive action recorded without secrets.

    PYTHONPATH=. python tests/unit/test_identity_audit.py
"""

import asyncio

from fastapi import HTTPException

from friday import audit, identity
from friday.audit import clear, recent, record, scrub
from friday.identity import UserIdentity, may_access, resolve_identity


def test_anonymous_by_default() -> None:
    ident = resolve_identity("sess_1", "mallory")
    assert ident == UserIdentity(user_id=None, session_id="sess_1", tenant_id=None)
    assert ident.actor == "sess_1"
    assert UserIdentity().actor == "anonymous"


def test_trusted_header_identifies() -> None:
    ident = resolve_identity("sess_1", "  alice  ", trust_headers=True)
    assert ident.user_id == "alice" and ident.actor == "alice"


def test_ownership_gate() -> None:
    alice = UserIdentity(user_id="alice", session_id="s")
    bob = UserIdentity(user_id="bob", session_id="s")
    anon = UserIdentity(session_id="s")
    assert may_access(None, anon) is True, "legacy anonymous runs unchanged"
    assert may_access(None, alice) is True
    assert may_access("alice", alice) is True
    assert may_access("alice", bob) is False
    assert may_access("alice", anon) is False


def test_scrub_redacts_and_trims() -> None:
    clean = scrub({"api_key": "sk-123", "tool": "x", "nested": {"token": "t"}})
    assert clean == {"api_key": "[redacted]", "tool": "x", "nested": {"token": "[redacted]"}}
    assert scrub("x" * 300).endswith("…")
    assert scrub(42) == 42 and scrub(None) is None


def test_audit_buffer_filters_and_orders() -> None:
    clear()
    record("run.created", actor="alice", run_id="run_1")
    record("tool.executed", actor="alice", run_id="run_1", target="t")
    record("run.created", actor="bob", run_id="run_2")
    all_events = recent()
    assert [e["seq"] for e in all_events] == [3, 2, 1], "newest first"
    assert [e["run_id"] for e in recent(run_id="run_1")] == ["run_1", "run_1"]
    assert recent(limit=1)[0]["seq"] == 3
    assert all("ts" in e and "action" in e for e in all_events)


def test_run_lifecycle_is_audited_with_owner() -> None:
    from friday import agent as agent_mod
    from friday import main
    from friday.schema import VizData, VisualizationPlan

    async def fake_plan(query, answer, evidence, pinned_type=None):
        return VisualizationPlan(type="radial_gauge", title="T",
                                 data=VizData(), answer="p")

    async def quick_agent(query, approve, result, history=(), memories="", emit_steps=False):
        result.text = "ok"
        yield agent_mod.AgentEvent("state", {"state": "processing"})

    async def scenario():
        from friday.core import config as core_config

        old_flag = core_config.settings.events_v2
        core_config.settings.events_v2 = True
        original_agent, agent_mod.run = agent_mod.run, quick_agent
        original_plan, main.plan = main.plan, fake_plan
        clear()
        try:
            frames = []
            async for chunk in main.run_query("audit me", session_id="s",
                                              owner_user_id="alice",
                                              actor="alice"):
                frames.append(chunk)
            return frames
        finally:
            agent_mod.run = original_agent
            main.plan = original_plan
            core_config.settings.events_v2 = old_flag

    frames = asyncio.run(scenario())
    assert frames, "turn must stream"

    from friday.runs import REGISTRY

    rid = None
    import json

    for chunk in frames:
        _, _, data = chunk.strip().partition("\n")
        rid = json.loads(data.removeprefix("data: "))["run_id"]
        break
    run = REGISTRY.get(rid)
    assert run.owner_user_id == "alice"
    actions = [(e["action"], e.get("decision")) for e in recent(run_id=rid)]
    assert ("run.created", None) in actions
    assert ("run.finished", "completed") in actions


def test_run_endpoints_enforce_ownership() -> None:
    from friday.api import routes

    async def scenario():
        from friday.core import config as core_config
        from friday.runs import REGISTRY

        old_trust = core_config.settings.trust_identity_headers
        core_config.settings.trust_identity_headers = True
        run = REGISTRY.create("s", "owned turn", owner_user_id="alice")
        REGISTRY.begin(run.run_id)
        try:
            # strangers and anonymous callers are refused on both paths —
            # an identified-owned run is visible only to its owner.
            for stranger in ("bob", None):
                for call in (routes.replay_run(run.run_id, 0, stranger),
                             routes.cancel_run(run.run_id, stranger)):
                    try:
                        await call
                    except HTTPException as err:
                        assert err.status_code == 403, err.status_code
                    else:
                        raise AssertionError("cross-user access must 403")
            # the owner goes through
            replay = await routes.replay_run(run.run_id, 0, "alice")
            assert replay["run_id"] == run.run_id
            cancelled = await routes.cancel_run(run.run_id, "alice")
            assert cancelled["cancelled"] is True
            # anonymous-owned runs keep the legacy open behavior
            legacy = REGISTRY.create("s", "legacy turn")
            REGISTRY.begin(legacy.run_id)
            assert (await routes.cancel_run(legacy.run_id, None))["cancelled"] is True
            actions = [e["action"] for e in recent(run_id=run.run_id)]
            assert "run.cancelled" in actions
        finally:
            from friday.core import config as core_config

            core_config.settings.trust_identity_headers = old_trust
            REGISTRY.finish(run.run_id, "cancelled")

    clear()
    asyncio.run(scenario())


def test_memory_writes_are_audited() -> None:
    from friday.memory import long_term as lt

    async def fake_embed(texts):
        return [[1.0, 0.0] for _ in texts]

    orig = (lt.embed, lt.store_configured, lt.store_insert, lt.store_delete)
    lt.embed = fake_embed
    lt.store_configured = lambda: True
    lt.store_insert = lambda fact, prov, emb: {"id": 9, "fact": fact, "provenance": prov}
    lt.store_delete = lambda mid: None
    lt.clear()
    clear()
    try:
        memory = asyncio.run(lt.add("operator prefers dark mode", "user"))
        assert memory is not None
        assert asyncio.run(lt.forget(9)) is True
    finally:
        lt.embed, lt.store_configured, lt.store_insert, lt.store_delete = orig
        lt.clear()
    actions = [(e["action"], e.get("target")) for e in recent()]
    assert ("memory.created", "9") in actions
    assert ("memory.deleted", "9") in actions


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
