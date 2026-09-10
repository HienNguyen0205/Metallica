"""Ghi/nạp ký ức, provenance theo turn, và mọi đường hỏng.

    PYTHONPATH=. python tests/unit/test_long_term_io.py
"""

import asyncio
import contextvars
import threading

from friday.memory import embed as embed_mod
from friday.memory import long_term as lt
from friday.memory import store


def fake_embed(vectors):
    async def _embed(texts):
        return [vectors[i % len(vectors)] for i in range(len(texts))]

    return _embed


#: Id mà store thật sự được bảo xoá. `forget` là toàn bộ nửa "xoá được" của
#: biện pháp bảo vệ, nên phải kiểm được nó có chạm tới kho bền hay không.
DELETED: list[int] = []

#: Thread mà mỗi lời gọi store thật sự chạy trên.
THREADS: list[str] = []

ROW = {
    "id": 3, "fact": "f", "provenance": "user", "embedding": [1.0, 0.0],
    "created_at": "2026-01-01T00:00:00Z", "last_used_at": "2026-01-02T00:00:00Z",
}


def stub(*, rows=None, insert_row=None, fail=None):
    lt.clear()
    DELETED.clear()
    THREADS.clear()
    embed_mod_embed = fake_embed([[1.0, 0.0]])
    lt.embed = embed_mod_embed

    def _select_all():
        THREADS.append(threading.current_thread().name)
        if fail == "select":
            raise store.StoreError("down")
        return rows or []

    def _insert(fact, provenance, embedding):
        THREADS.append(threading.current_thread().name)
        if fail == "insert":
            raise store.StoreError("down")
        return insert_row or {"id": 1, "fact": fact, "provenance": provenance, "created_at": "2026-01-01", "last_used_at": "2026-01-01"}

    def _delete(memory_id):
        THREADS.append(threading.current_thread().name)
        if fail == "delete":
            raise store.StoreError("down")
        DELETED.append(memory_id)

    lt.store_select_all = _select_all
    lt.store_insert = _insert
    lt.store_delete = _delete
    lt.store_configured = lambda: True


def test_load_fills_the_cache():
    stub(rows=[ROW])
    assert asyncio.run(lt.load()) == 1
    assert lt.CACHE[0].id == 3
    # created_at đi cùng: trên màn hình xem lại, "trang web kia ghi cái này lúc
    # nào" là cột hữu ích nhất, và _row_to_memory từng vứt nó đi.
    assert lt.CACHE[0].created_at == "2026-01-01T00:00:00Z", lt.CACHE[0]


def test_a_dead_store_at_startup_is_a_warning_not_a_crash():
    stub(fail="select")
    assert asyncio.run(lt.load()) == 0, "khởi động phải sống sót qua Supabase chết"
    assert lt.CACHE == []


def test_remember_writes_and_lands_in_the_cache():
    stub()
    out = asyncio.run(lt.run_remember({"fact": "thích đơn vị mét"}))
    assert out["remembered"] == "thích đơn vị mét", out
    assert len(lt.CACHE) == 1


def test_an_empty_fact_is_refused_before_any_call_goes_out():
    stub()
    assert "error" in asyncio.run(lt.run_remember({"fact": "   "}))
    assert lt.CACHE == []


def test_a_long_fact_is_trimmed():
    stub()
    asyncio.run(lt.run_remember({"fact": "x" * (lt.MAX_FACT_CHARS + 100)}))
    assert len(lt.CACHE[0].fact) == lt.MAX_FACT_CHARS


def test_a_failed_write_tells_the_model_instead_of_killing_the_turn():
    stub(fail="insert")
    out = asyncio.run(lt.run_remember({"fact": "gì đó"}))
    assert "error" in out, out
    assert lt.CACHE == [], "ghi hỏng mà cache vẫn nhận là cache nói dối"


def test_provenance_follows_what_ran_this_turn():
    stub()
    lt.TURN_TOOLS.set(set())
    assert lt.current_provenance() == "user"
    lt.mark_tool_used("get_system_metrics")
    assert lt.current_provenance() == "user", "chỉ search_web mới đưa chữ người lạ vào"
    lt.mark_tool_used("search_web")
    assert lt.current_provenance() == "tool"


def test_remember_tags_provenance_from_the_turn():
    stub()
    lt.TURN_TOOLS.set({"search_web"})
    asyncio.run(lt.run_remember({"fact": "đọc trên mạng"}))
    assert lt.CACHE[0].provenance == "tool"


def test_forget_removes_it_from_both_places():
    stub(rows=[ROW])
    asyncio.run(lt.load())
    assert asyncio.run(lt.forget(3)) is True
    assert lt.CACHE == []
    assert DELETED == [3], DELETED


def test_forget_reaches_the_store_even_when_the_cache_never_saw_it():
    """Cache không phải danh sách những gì xoá được.

    `enforce_cap` loại bớt, và một `load()` hỏng thì chẳng kéo về gì cả - cả
    hai để lại id vẫn nằm trong store và vẫn hiện ra ở `GET /memory`. Gác lời
    gọi store sau một phép kiểm tra thành viên trong cache làm đúng những id
    đó không xoá được qua API, tức là thủng đúng biện pháp bảo vệ bắt buộc.
    """
    stub()
    assert asyncio.run(lt.forget(999)) is True
    assert DELETED == [999], "id ngoài cache vẫn phải tới được store"


def test_a_store_that_refuses_the_delete_is_not_reported_as_a_success():
    """Nuốt lỗi rồi trả True nghĩa là operator đọc {"ok": true} trong khi dòng
    đó vẫn còn nguyên và quay lại ở lần khởi động kế tiếp."""
    stub(rows=[ROW], fail="delete")
    asyncio.run(lt.load())
    assert asyncio.run(lt.forget(3)) is False
    assert [m.id for m in lt.CACHE] == [3], "store từ chối mà cache vẫn bỏ là cache nói dối"


def test_no_store_call_runs_on_the_event_loop():
    """`store._request` chặn tới 10 giây và service cố tình chỉ có một process.

    Gọi thẳng trong một hàm async là một Supabase chậm treo *mọi* SSE stream
    đang mở và mọi /confirm đang chờ, cùng lúc, tới mười giây. Ba đường ghi/đọc
    đều phải rời event loop.
    """
    stub(rows=[ROW])
    asyncio.run(lt.load())
    asyncio.run(lt.run_remember({"fact": "gì đó"}))
    asyncio.run(lt.forget(1))

    main_thread = threading.main_thread().name
    assert len(THREADS) == 3, THREADS
    assert all(name != main_thread for name in THREADS), THREADS


def test_a_mark_in_one_context_does_not_leak_into_a_sibling_context():
    """mark_tool_used must never write through to the ContextVar's shared default.

    An earlier version of this test only proved current_provenance() could
    survive an explicit TURN_TOOLS.set(None) override in the SAME context —
    that passed even against a mark_tool_used that still mutated one shared
    object, because the override simply hid the read. The real leak only
    shows up across two independent contexts, neither of which ever calls
    .set() itself: if they are sharing one mutable default, a mark made
    inside one is visible from the other.
    """
    stub()
    ctx_a = contextvars.copy_context()
    ctx_a.run(lt.mark_tool_used, "search_web")  # marked inside A, no .set() by A

    ctx_b = contextvars.copy_context()  # a sibling snapshot, not A itself
    assert ctx_b.run(lt.current_provenance) == "user", "mark leaked into a sibling context"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all long-term IO tests passed")
