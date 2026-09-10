"""Đường xem lại và xoá. Trong thiết kế này nó là lớp bảo vệ duy nhất.

    PYTHONPATH=. python tests/integration/test_memory_api.py
"""

import os

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"

from fastapi.testclient import TestClient

from friday.main import app
from friday.memory import long_term as lt
from friday.memory import store

client = TestClient(app)

ROWS = [
    {"id": 1, "fact": "thích đơn vị mét", "provenance": "user",
     "created_at": "2026-01-01T00:00:00Z", "last_used_at": "2026-01-03T00:00:00Z",
     "embedding": [1.0]},
    {"id": 2, "fact": "đọc trên mạng", "provenance": "tool",
     "created_at": "2026-01-02T00:00:00Z", "last_used_at": "2026-01-02T00:00:00Z",
     "embedding": [1.0]},
]


def seed_cache(*rows):
    lt.clear()
    for row in rows:
        lt.CACHE.append(
            lt.Memory(
                id=row["id"], fact=row["fact"], provenance=row["provenance"],
                embedding=[1.0], created_at=row["created_at"], last_used_at=row["last_used_at"],
            )
        )


def store_returns(rows):
    store.select_all = lambda: [dict(r) for r in rows]


def store_is_down():
    def boom():
        raise store.StoreError("no route to host")

    store.select_all = boom


def test_listing_shows_provenance_so_web_sourced_facts_are_visible():
    seed_cache(*ROWS)
    store_returns(ROWS)
    body = client.get("/memory").json()
    kinds = {m["id"]: m["provenance"] for m in body["memories"]}
    assert kinds == {1: "user", 2: "tool"}, body
    # Vector không bao giờ ra ngoài: 768 số float không giúp ai đọc, chỉ làm
    # response phình lên.
    assert "embedding" not in body["memories"][0]


def test_the_listing_carries_created_at():
    """Trên màn hình mà việc của nó là "trang web kia đã ghi cái gì", thời điểm
    một sự thật xuất hiện là cột hữu ích nhất - và `_row_to_memory` từng vứt nó
    đi dù `store.COLUMNS` vẫn select về."""
    seed_cache(*ROWS)
    store_returns(ROWS)
    body = client.get("/memory").json()
    assert body["memories"][0]["created_at"] == "2026-01-01T00:00:00Z", body


def test_the_listing_shows_the_store_not_the_cache():
    """Sau một lần khởi động hỏng, cache rỗng còn store thì đầy.

    Đọc từ cache khi đó trả về một danh sách trống - câu trả lời sai nhất có
    thể cho "ký ức nào vừa bị một trang web lạ ghi vào", vì nó trông y hệt
    "không có gì cả". Đây là màn hình xem lại, không phải đường nóng.
    """
    lt.clear()
    store_returns(ROWS)
    body = client.get("/memory").json()
    assert [m["id"] for m in body["memories"]] == [1, 2], body
    assert body["from_cache"] is False, body


def test_a_dead_store_falls_back_to_the_cache_and_says_so():
    """Lùi về cache thì được, im lặng đưa một bản sao ra như sự thật thì không."""
    seed_cache(ROWS[0])
    store_is_down()
    body = client.get("/memory").json()
    assert [m["id"] for m in body["memories"]] == [1], body
    assert body["from_cache"] is True, body


def test_deleting_removes_it():
    seed_cache(*ROWS)
    store_returns(ROWS)
    deleted = []
    lt.store_delete = deleted.append
    assert client.delete("/memory/1").json()["ok"] is True
    assert [m.id for m in lt.CACHE] == [2]
    assert deleted == [1], deleted


def test_deleting_something_the_cache_never_had_still_reaches_the_store():
    """enforce_cap loại bớt và một load() hỏng chẳng kéo về gì - cả hai để lại
    id operator vẫn thấy trong `GET /memory`. Chúng phải xoá được."""
    lt.clear()
    store_returns(ROWS)
    deleted = []
    lt.store_delete = deleted.append
    assert client.delete("/memory/2").json()["ok"] is True
    assert deleted == [2], deleted


def test_a_delete_the_store_refuses_is_not_reported_as_a_success():
    """{"ok": true} trong khi dòng đó vẫn nằm trong Supabase là lời nói dối tệ
    nhất API này có thể nói: operator tưởng đã xoá một sự thật bị tiêm vào, rồi
    gặp lại nó sau lần khởi động kế tiếp."""
    seed_cache(*ROWS)
    store_returns(ROWS)

    def boom(memory_id):
        raise store.StoreError("no route to host")

    lt.store_delete = boom
    assert client.delete("/memory/1").json()["ok"] is False
    assert [m.id for m in lt.CACHE] == [1, 2], "store từ chối mà cache vẫn bỏ là cache nói dối"


def test_a_foreign_origin_cannot_read_or_erase_what_friday_knows():
    seed_cache(*ROWS)
    store_returns(ROWS)
    headers = {"origin": "https://evil.example"}
    assert client.get("/memory", headers=headers).status_code == 403
    assert client.delete("/memory/1", headers=headers).status_code == 403


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all memory API tests passed")
