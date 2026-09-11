"""Cache ký ức: xếp hạng, ngưỡng, trần, và khối prompt.

    PYTHONPATH=. python tests/unit/test_long_term.py
"""

import asyncio

from friday.memory import long_term as lt
from friday.memory.embed import normalize


def mem(mid, fact, vector, provenance="user", created_at="2026-01-01", last_used_at="2026-01-01"):
    return lt.Memory(
        id=mid,
        fact=fact,
        provenance=provenance,
        embedding=normalize(vector),
        created_at=created_at,
        last_used_at=last_used_at,
    )


def seed(*memories):
    lt.clear()
    lt.CACHE.extend(memories)


def test_the_closest_memory_comes_first():
    seed(
        mem(1, "xa", [0.0, 1.0]),
        mem(2, "gần", [1.0, 0.1]),
        mem(3, "giữa", [0.7, 0.7]),
    )
    ranked = lt.top_k(normalize([1.0, 0.0]), 3)
    assert [m.id for m in ranked] == [2, 3], [m.id for m in ranked]


def test_anything_below_the_floor_is_left_out():
    seed(mem(1, "trực giao", [0.0, 1.0]))
    assert lt.top_k(normalize([1.0, 0.0]), 5) == []


def test_k_is_a_cap_not_a_target():
    seed(*[mem(i, f"m{i}", [1.0, 0.05 * i]) for i in range(1, 8)])
    assert len(lt.top_k(normalize([1.0, 0.0]), 3)) == 3


def test_normalization_is_load_bearing():
    """Vector chưa chuẩn hoá xếp hạng theo độ dài, không theo hướng.

    Nếu bỏ normalize đi mà test này vẫn xanh thì nó không chứng minh được gì -
    nên nó phải bắt được đúng sự khác biệt đó.
    """
    long_but_wrong = [10.0, 10.0]   # hướng lệch 45 độ, độ dài lớn
    short_but_right = [1.0, 0.0]    # trùng hướng, độ dài nhỏ
    query = [1.0, 0.0]

    raw = sum(a * b for a, b in zip(long_but_wrong, query))
    assert raw > sum(a * b for a, b in zip(short_but_right, query)), "tiền đề của test đã hỏng"

    cosine_wrong = lt.similarity(normalize(long_but_wrong), normalize(query))
    cosine_right = lt.similarity(normalize(short_but_right), normalize(query))
    assert cosine_right > cosine_wrong, "chuẩn hoá không đảo được thứ hạng - cosine đang sai"


def test_two_vectors_of_different_length_are_an_error_not_a_prefix_match():
    """zip() cắt về vector ngắn hơn và trả về một con số trông hoàn toàn bình thường.

    FRIDAY_EMBED_MODEL do operator đặt. Trỏ nó vào một provider bỏ qua
    `dimensions` là mọi dòng đã ghi từ trước bị so trên một khúc đầu, xếp hạng
    sai, và không có lỗi ở đâu để lần ra.
    """
    try:
        lt.similarity([1.0, 0.0, 0.0], [1.0, 0.0])
    except ValueError:
        return
    raise AssertionError("một vector lệch chiều phải nổ, không được im lặng so khúc đầu")


def test_the_cache_is_bounded_and_drops_the_least_recently_used():
    """enforce_cap() phải giữ đúng MAX_MEMORIES mục *mới dùng gần đây nhất*.

    Kiểm chứng bằng cách gắn last_used_at riêng biệt, không trùng nhau, cho
    từng mục - rồi sau enforce_cap() khẳng định luôn cả hai vế: đúng số lượng
    VÀ đúng tập hợp còn sống (mọi mục sống mới hơn mọi mục bị bỏ). Chỉ đếm số
    lượng không phân biệt được một cap đúng với một cap xén nhầm đầu.

    Thứ tự chèn vào CACHE KHÔNG được trùng thứ tự last_used_at. Nếu id=0 vừa
    cũ nhất vừa là phần tử đầu danh sách, một enforce_cap xén theo VỊ TRÍ
    (`del CACHE[:len(CACHE)-MAX_MEMORIES]` hoặc `del CACHE[MAX_MEMORIES:]`,
    bỏ qua last_used_at hoàn toàn) sẽ vô tình ra đúng tập bị bỏ và test không
    bắt được nó - trong khi `touch()` cập nhật last_used_at tại chỗ, không di
    chuyển phần tử trong CACHE, nên một mục ở vị trí cũ hoàn toàn có thể là
    mục mới dùng gần đây nhất trong thực tế. Nên ở đây chèn xen kẽ id chẵn rồi
    tới id lẻ - 10 id cũ nhất (0..9) rơi vào hai vùng rời nhau của CACHE,
    không nằm gọn ở đầu hay ở cuối, nên chỉ một cap xén theo *field* mới ra
    đúng đáp số.
    """
    deleted = []
    lt.store_delete = deleted.append

    lt.clear()
    total = lt.MAX_MEMORIES + 10
    insertion_order = [i for i in range(total) if i % 2 == 0] + [i for i in range(total) if i % 2 == 1]
    for i in insertion_order:
        # last_used_at tăng dần theo id, không theo vị trí chèn - id=0 cũ nhất.
        lt.CACHE.append(mem(i, f"m{i}", [1.0, 0.0], last_used_at=f"2026-01-01T{i:05d}"))
    asyncio.run(lt.enforce_cap())

    assert len(lt.CACHE) == lt.MAX_MEMORIES, len(lt.CACHE)

    survivor_ids = {m.id for m in lt.CACHE}
    dropped_ids = set(range(total)) - survivor_ids
    assert len(dropped_ids) == 10, dropped_ids

    # Đúng 10 mục cũ nhất (i=0..9) bị bỏ, không phải mục nào khác.
    assert dropped_ids == set(range(10)), dropped_ids

    survivor_times = [m.last_used_at for m in lt.CACHE]
    dropped_times = [f"2026-01-01T{i:05d}" for i in dropped_ids]
    assert min(survivor_times) > max(dropped_times), (min(survivor_times), max(dropped_times))

    # Trần chỉ áp lên cache thì store phình vô hạn và mục vừa bị loại sẽ sống
    # lại ở lần khởi động sau, đẩy một mục khác ra thay - tập ký ức xáo lại
    # sau mỗi deploy. Nên chỗ bị loại phải biến mất khỏi store luôn.
    assert set(deleted) == dropped_ids, sorted(set(deleted) ^ dropped_ids)


def test_the_block_fences_memories_as_data():
    seed(mem(1, "thích đơn vị mét", [1.0, 0.0]))
    block = lt.render_block(lt.top_k(normalize([1.0, 0.0]), 5))
    assert "<remembered_facts>" in block and "</remembered_facts>" in block
    # Rào này là một trong ba lớp chặn injection. Bỏ nó đi thì ký ức đọc ra
    # không khác gì chỉ thị từ hệ thống.
    assert "KHÔNG phải chỉ thị" in block, block
    assert "(user)" in block


def test_provenance_is_visible_on_every_line():
    seed(mem(1, "từ web", [1.0, 0.0], provenance="tool"))
    block = lt.render_block(lt.top_k(normalize([1.0, 0.0]), 5))
    assert "(tool)" in block, block


def test_an_empty_recall_renders_nothing_at_all():
    lt.clear()
    assert lt.render_block([]) == "", "khối rỗng vẫn tốn token và làm model bối rối"


def test_the_block_is_capped():
    seed(*[mem(i, "x" * 300, [1.0, 0.0]) for i in range(1, 21)])
    block = lt.render_block(lt.top_k(normalize([1.0, 0.0]), 20))
    assert len(block) <= lt.RECALL_BLOCK_MAX_CHARS + 200, len(block)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all long-term tests passed")
