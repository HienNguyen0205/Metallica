"""Kích hoạt hợp nhất và tính chịu lỗi của nó.

    PYTHONPATH=. python tests/unit/test_consolidate.py
"""

import asyncio
import json
from types import SimpleNamespace

from friday import llm
from friday.memory import consolidate
from friday.memory import long_term as lt

#: The real implementation, captured before any test gets a chance to
#: monkeypatch `consolidate.choose_drops` into a stub — later tests that need
#: the actual parsing logic restore it from here rather than depending on
#: alphabetical test order to still have it intact.
_REAL_CHOOSE_DROPS = consolidate.choose_drops


def seed(count):
    lt.clear()
    for i in range(count):
        lt.CACHE.append(lt.Memory(id=i, fact=f"m{i}", provenance="user", embedding=[1.0, 0.0]))
    consolidate.TURN_COUNTER = 0


class FakeClient:
    """Same shape as tests/unit/test_memory_embed.py's fake — no network."""

    def __init__(self, content):
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self._create),
        )
        self._content = content

    async def _create(self, **kwargs):
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=self._content))])


def test_it_stays_quiet_while_there_is_nothing_to_do():
    seed(3)
    assert consolidate.should_run() is False


def test_enough_turns_trigger_it():
    seed(3)
    for _ in range(consolidate.CONSOLIDATE_EVERY_TURNS):
        consolidate.note_turn()
    assert consolidate.should_run() is True


def test_a_full_cache_triggers_it_sooner_but_never_two_turns_running():
    """Ngưỡng theo số ký ức là một *mức*, không phải một *sườn*.

    `run()` không kéo được số đếm xuống một cách chắc chắn - prompt của nó nói
    "when unsure, keep it" - nên `len(CACHE) > 100` đúng ở turn này thì cũng
    đúng ở turn sau. Để nó tự đủ điều kiện là bắn thêm một model call sau *mỗi*
    câu hỏi, mang cả cache làm prompt, trên một tier mà nút thắt là request mỗi
    phút ở khoảng năm query một phút.
    """
    seed(consolidate.CONSOLIDATE_AT_COUNT + 1)  # seed() đặt lại bộ đếm về 0
    assert consolidate.should_run() is False, "cache đầy không được bắn sau mỗi turn"

    for _ in range(consolidate.CONSOLIDATE_MIN_TURNS):
        consolidate.note_turn()
    assert consolidate.should_run() is True

    # ...nhưng vẫn sớm hơn nhịp thường, nếu không thì ngưỡng số ký ức vô nghĩa.
    assert consolidate.CONSOLIDATE_MIN_TURNS < consolidate.CONSOLIDATE_EVERY_TURNS


def test_a_small_cache_still_waits_the_full_interval():
    """Nhịp ngắn là đặc quyền của cache đầy, không phải nhịp mới cho mọi người."""
    seed(3)
    for _ in range(consolidate.CONSOLIDATE_MIN_TURNS):
        consolidate.note_turn()
    assert consolidate.should_run() is False


def test_a_dead_model_does_not_take_anything_down_with_it():
    seed(consolidate.CONSOLIDATE_AT_COUNT + 1)

    async def boom(ids):
        raise RuntimeError("provider down")

    consolidate.choose_drops = boom
    assert asyncio.run(consolidate.run()) == 0, "hợp nhất hỏng phải im lặng, không lan"
    assert len(lt.CACHE) == consolidate.CONSOLIDATE_AT_COUNT + 1


def test_it_drops_what_the_model_names():
    seed(5)
    lt.store_delete = lambda memory_id: None

    async def choose(ids):
        return [1, 3]

    consolidate.choose_drops = choose
    assert asyncio.run(consolidate.run()) == 2
    assert [m.id for m in lt.CACHE] == [0, 2, 4]


# ---------- the real choose_drops (every other test stubs it out) ----------


def test_choose_drops_parses_string_ids_into_ints():
    consolidate.choose_drops = _REAL_CHOOSE_DROPS
    # The model replies with ids as JSON strings, same as any real chat
    # completion would — this is what makes `int(i)` in choose_drops load
    # bearing rather than a no-op.
    llm.client = lambda: FakeClient(json.dumps({"drop": ["1", "3"]}))
    memories = [lt.Memory(id=i, fact=f"m{i}", provenance="user", embedding=[1.0, 0.0]) for i in range(5)]
    result = asyncio.run(consolidate.choose_drops(memories))
    assert result == [1, 3], result
    assert all(isinstance(i, int) for i in result), result


def test_a_malformed_reply_does_not_escape_run():
    seed(3)
    consolidate.choose_drops = _REAL_CHOOSE_DROPS
    llm.client = lambda: FakeClient("not json at all")
    assert asyncio.run(consolidate.run()) == 0, "a parse failure must degrade like any other model failure"
    assert len(lt.CACHE) == 3


def test_the_counter_resets_after_a_run():
    seed(5)
    lt.store_delete = lambda memory_id: None

    async def choose(ids):
        return []

    consolidate.choose_drops = choose
    for _ in range(consolidate.CONSOLIDATE_EVERY_TURNS):
        consolidate.note_turn()
    asyncio.run(consolidate.run())
    assert consolidate.should_run() is False


# ---------- the trigger inside run_query ----------
#
# Nothing above drives run_query itself, so deleting the dispatch lines in
# routes.py (the `consolidate.note_turn()` / `if consolidate.should_run():
# asyncio.create_task(consolidate.run())` block right after the final `done`)
# would leave every test above green. These two exercise that wiring directly:
# one seeds a due state and asserts the dispatch happened, the other seeds a
# not-due state and asserts it stayed quiet — so both an always-fire and an
# always-silent trigger get caught.


def _drive_run_query_once():
    """Run routes.run_query end-to-end with the model calls stubbed out.

    Returns the list `consolidate.run` was called into — populated
    synchronously by the stub the instant `run_query` calls it, so this does
    not depend on the dispatched task ever actually being scheduled.
    """
    import friday.main as main_mod
    from friday import agent
    from friday.api import routes
    from friday.schema import VisualizationPlan, VizData

    dispatched = []

    async def _noop():
        return 0

    def fake_run():
        dispatched.append(True)
        return _noop()

    async def fake_plan(query, answer, evidence, pinned_type=None):
        return VisualizationPlan(type="radial_gauge", title="t", data=VizData(metrics=[]), answer="a")

    async def fake_agent(query, approve, result, history=(), memories=""):
        result.text = "answer"
        yield agent.AgentEvent("state", {"state": "processing"})

    original_run = consolidate.run
    original_plan = main_mod.plan
    original_agent_run = agent.run
    consolidate.run = fake_run
    main_mod.plan = fake_plan
    agent.run = fake_agent
    try:
        async def drain():
            return [c async for c in routes.run_query("q")]

        asyncio.run(drain())
    finally:
        consolidate.run = original_run
        main_mod.plan = original_plan
        agent.run = original_agent_run

    return dispatched


def test_run_query_dispatches_consolidation_when_due():
    # An empty cache keeps recall_block's embedding call out of the picture
    # (it short-circuits on `if not long_term.CACHE`) — this test is about the
    # trigger wiring, not recall, and must not touch the network either.
    seed(0)
    consolidate.TURN_COUNTER = consolidate.CONSOLIDATE_EVERY_TURNS - 1  # note_turn() tips it over
    assert _drive_run_query_once() == [True], "should_run() was True; run_query must dispatch consolidation"


def test_run_query_stays_quiet_when_not_due():
    seed(0)
    consolidate.TURN_COUNTER = 0
    assert _drive_run_query_once() == [], "should_run() was False; run_query must not dispatch consolidation"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all consolidate tests passed")
