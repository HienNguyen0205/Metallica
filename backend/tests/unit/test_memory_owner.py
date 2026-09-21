"""P3 — long-term memory follows run ownership (identity.may_access).

Owner None is shared: every caller sees it, exactly as before identity
existed. An identified user's memories are theirs alone — never recalled into
another user's prompt, never superseded or consolidated away by another
user's facts. With trust headers off (default) everyone is anonymous and
nothing changes.

    PYTHONPATH=. python tests/unit/test_memory_owner.py
"""

import asyncio

from friday.memory import consolidate
from friday.memory import long_term as lt

V = [1.0, 0.0]


def mem(id_: int, fact: str, owner: str | None) -> lt.Memory:
    return lt.Memory(id=id_, fact=fact, provenance="user", embedding=V, owner_user_id=owner)


def seed() -> None:
    lt.clear()
    lt.CACHE.extend([mem(1, "shared fact", None), mem(2, "alice fact", "alice"), mem(3, "bob fact", "bob")])


def ids(memories) -> set[int]:
    return {m.id for m in memories}


def test_visibility_mirrors_run_ownership() -> None:
    seed()
    assert ids(lt.visible(None)) == {1}, "anonymous sees shared only"
    assert ids(lt.visible("alice")) == {1, 2}
    assert ids(lt.top_k(V, 5, owner="bob")) == {1, 3}, "recall must never surface another user's fact"


def test_writes_carry_the_turn_owner_and_only_see_visible_memories() -> None:
    seed()
    inserted: list[tuple] = []

    def fake_insert(fact, prov, emb, owner=None):
        inserted.append((fact, owner))
        return {"id": 9, "fact": fact, "provenance": prov}

    deleted: list[int] = []

    def fake_delete(memory_id, **_):
        deleted.append(memory_id)

    orig = (lt.store_insert, lt.store_delete)
    lt.store_insert, lt.store_delete = fake_insert, fake_delete
    try:
        async def as_bob():
            lt.OWNER.set("bob")
            # Contradicts alice's "alice fact" by negation signature only if it
            # were visible — it must not supersede (delete) her memory.
            return await lt.add("not alice fact", "user", embedding=[0.0, 1.0])

        memory = asyncio.run(as_bob())
        assert memory is not None and memory.owner_user_id == "bob"
        assert inserted == [("not alice fact", "bob")]
        assert 2 not in deleted, "another user's memory must never be superseded"
    finally:
        lt.store_insert, lt.store_delete = orig


def test_consolidation_prunes_only_the_turn_owners_memories() -> None:
    seed()
    seen: list[set[int]] = []

    async def fake_choose(memories):
        seen.append(ids(memories))
        return []

    orig = consolidate.choose_drops
    consolidate.choose_drops = fake_choose
    try:
        async def as_alice():
            lt.OWNER.set("alice")
            await consolidate.run()

        asyncio.run(as_alice())
        # The shared pool still prunes on identified turns (it would otherwise
        # grow without bound once any identified traffic exists), but in its
        # own pass: judged beside alice's facts, one of hers could "contradict"
        # a shared fact and delete it for everyone. Bob's rows never appear.
        assert seen == [{2}, {1}], seen

        seen.clear()

        async def anonymous():
            lt.OWNER.set(None)
            await consolidate.run()

        asyncio.run(anonymous())
        assert seen == [{1}], seen
    finally:
        consolidate.choose_drops = orig


def test_a_drop_is_honoured_only_inside_its_own_pass() -> None:
    seed()
    forgotten: list[int] = []

    async def drop_everything(memories):
        return [1, 2, 3]  # the model names ids outside the group it was shown

    async def fake_forget(memory_id, **_):
        forgotten.append(memory_id)
        return True

    orig = (consolidate.choose_drops, lt.forget)
    consolidate.choose_drops, lt.forget = drop_everything, fake_forget
    try:
        async def as_alice():
            lt.OWNER.set("alice")
            return await consolidate.run()

        assert asyncio.run(as_alice()) == 2
        assert sorted(forgotten) == [1, 2], "bob's row (3) must never be dropped"
    finally:
        consolidate.choose_drops, lt.forget = orig


if __name__ == "__main__":
    test_visibility_mirrors_run_ownership()
    test_writes_carry_the_turn_owner_and_only_see_visible_memories()
    test_consolidation_prunes_only_the_turn_owners_memories()
    test_a_drop_is_honoured_only_inside_its_own_pass()
    print("ok")
