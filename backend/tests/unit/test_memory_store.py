"""store.py: dựng request PostgREST đúng, và hỏng thì hỏng ra StoreError.

    PYTHONPATH=. python tests/unit/test_memory_store.py
"""

import json
import os
import urllib.error

os.environ["SUPABASE_URL"] = "https://proj.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "service-key-123"

from friday.memory import store


class FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def capture(payload, sink):
    def fake_urlopen(req, timeout=None):
        sink.append(req)
        return FakeResponse(payload)

    return fake_urlopen


def test_credentials_ride_on_every_request():
    sink = []
    store.urlopen = capture([], sink)
    store.select_all()
    req = sink[0]
    assert req.headers["Apikey"] == "service-key-123"
    assert req.headers["Authorization"] == "Bearer service-key-123"


def test_select_asks_for_every_column_the_cache_needs():
    sink = []
    store.urlopen = capture([], sink)
    store.select_all()
    url = sink[0].full_url
    for column in ("id", "fact", "provenance", "embedding", "created_at", "last_used_at"):
        assert column in url, f"{column} missing from {url}"


def test_select_is_ordered_and_capped():
    """Không có order+limit, một bảng lớn hơn cache trả về tập Postgres tuỳ chọn.

    Hệ quả không phải là chậm mà là bất định: mục bị enforce_cap loại sống lại
    ở lần khởi động sau và đẩy mục khác ra thay, nên tập ký ức xáo lại sau mỗi
    deploy. Khẳng định cả hai vế, vì chỉ `limit` mà không `order` vẫn tuỳ tiện.
    """
    sink = []
    store.urlopen = capture([], sink)
    store.select_all()
    url = sink[0].full_url
    assert "order=last_used_at.desc" in url, url
    assert f"limit={store.MAX_ROWS}" in url, url


def test_the_row_cap_matches_the_cache_cap():
    from friday.memory import long_term

    # Kéo về nhiều hơn sức chứa của cache chỉ để vứt đi là băng thông thừa;
    # kéo về ít hơn là quên ký ức mà cache vẫn còn chỗ giữ.
    assert store.MAX_ROWS == long_term.MAX_MEMORIES


def test_insert_sends_the_vector_as_a_postgrest_literal():
    sink = []
    store.urlopen = capture([{"id": 7}], sink)
    row = store.insert("con thích đơn vị mét", "user", [0.5, 0.5])
    body = json.loads(sink[0].data.decode())
    # pgvector nhận chuỗi "[a,b]", không phải mảng JSON — gửi mảy thì Postgres
    # từ chối với một lỗi kiểu khó lần.
    assert body["embedding"] == "[0.5,0.5]", body["embedding"]
    assert row["id"] == 7
    # Dòng của server, nguyên vẹn: người gọi duy nhất (long_term.add) tự ghi đè
    # embedding ngay sau đó, nên nhét nó vào đây chỉ là công vô ích.
    assert "embedding" not in row, row


def test_delete_filters_by_id_not_by_everything():
    sink = []
    store.urlopen = capture([], sink)
    store.delete(7)
    assert "id=eq.7" in sink[0].full_url, sink[0].full_url
    assert sink[0].get_method() == "DELETE"


def test_a_dead_supabase_raises_storeerror_not_urlerror():
    def boom(req, timeout=None):
        raise urllib.error.URLError("no route to host")

    store.urlopen = boom
    for call in (store.select_all, lambda: store.insert("x", "user", [1.0]), lambda: store.delete(1)):
        try:
            call()
        except store.StoreError:
            pass
        else:
            raise AssertionError(f"{call} swallowed a dead backend")


def test_unconfigured_is_not_an_error_it_is_a_mode():
    saved = os.environ.pop("SUPABASE_URL")
    try:
        assert store.configured() is False
    finally:
        os.environ["SUPABASE_URL"] = saved
    assert store.configured() is True


def test_select_all_parses_vector_from_postgrest_string_format():
    """PostgREST returns pgvector as string "[a,b,c]" not as JSON array."""
    sink = []
    payload = [
        {"id": 1, "fact": "test", "provenance": "user", "embedding": "[0.1,0.2,0.3]", "created_at": "2026-01-01", "last_used_at": "2026-01-01"},
        {"id": 2, "fact": "test2", "provenance": "user", "embedding": "[0.5,0.6]", "created_at": "2026-01-01", "last_used_at": "2026-01-01"},
    ]
    store.urlopen = capture(payload, sink)
    rows = store.select_all()
    assert rows[0]["embedding"] == [0.1, 0.2, 0.3], f"got {rows[0]['embedding']}"
    assert rows[1]["embedding"] == [0.5, 0.6], f"got {rows[1]['embedding']}"


def test_select_all_parses_empty_vector_string():
    """Empty vector string "[]" should parse to empty list."""
    sink = []
    payload = [
        {"id": 1, "fact": "test", "provenance": "user", "embedding": "[]", "created_at": "2026-01-01", "last_used_at": "2026-01-01"},
    ]
    store.urlopen = capture(payload, sink)
    rows = store.select_all()
    assert rows[0]["embedding"] == [], f"got {rows[0]['embedding']}"


def test_touch_patches_last_used_at_on_exactly_those_ids():
    """Giá trị phải là "now", không phải "now()".

    `now()` là một lời gọi hàm, không phải timestamptz literal: Postgres từ
    chối nó bằng 400, `_request` gói thành StoreError, `touch` nuốt và log —
    nên `last_used_at` không bao giờ nhích, và production log một warning sau
    *mỗi* lần recall. Không có gì test thân hàm này trước đây.
    """
    sink = []
    store.urlopen = capture([], sink)
    store.touch([4, 5])
    req = sink[0]
    assert req.get_method() == "PATCH", req.get_method()
    assert "id=in.(4,5)" in req.full_url, req.full_url
    assert json.loads(req.data.decode()) == {"last_used_at": "now"}, req.data


def test_touch_does_not_raise_when_backend_dead():
    """touch() swallows StoreError and logs instead."""
    def boom(req, timeout=None):
        raise urllib.error.URLError("no route to host")

    store.urlopen = boom
    store.touch([1, 2, 3])  # Should not raise


def test_touch_empty_list_makes_no_request():
    """touch() with empty id list should return early without making a request."""
    sink = []
    store.urlopen = capture([], sink)
    store.touch([])
    assert len(sink) == 0, f"expected no requests, got {len(sink)}"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all store tests passed")
