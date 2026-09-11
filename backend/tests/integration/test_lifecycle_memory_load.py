"""Cache ký ức dài hạn phải được nạp khi service khởi động.

Nếu lời gọi `long_term.load()` biến mất khỏi `lifespan`, không có test nào
khác đỏ — mọi thứ còn lại vẫn chạy đúng, cache chỉ mãi mãi trống, và triệu
chứng giống hệt "chưa có ký ức nào liên quan". Test này tồn tại để bắt đúng
lỗi đó.

    PYTHONPATH=. python tests/integration/test_lifecycle_memory_load.py
"""

import asyncio
import os

os.environ["FRIDAY_ALLOWED_ORIGINS"] = "http://localhost:3000"

from friday.core.lifecycle import lifespan
from friday.main import app
from friday.memory import long_term as lt


def stub():
    lt.clear()
    lt.store_configured = lambda: True
    lt.store_select_all = lambda: [
        {"id": 1, "fact": "thích đơn vị mét", "provenance": "user", "embedding": [1.0, 0.0], "created_at": "2026-01-01", "last_used_at": "2026-01-01"},
        {"id": 2, "fact": "đọc trên mạng", "provenance": "tool", "embedding": [0.0, 1.0], "created_at": "2026-01-01", "last_used_at": "2026-01-01"},
    ]


def test_startup_loads_the_cache_from_the_store():
    stub()

    async def run():
        async with lifespan(app):
            pass

    asyncio.run(run())
    assert len(lt.CACHE) == 2, "lifespan phải gọi long_term.load() trước yield"
    assert {m.id for m in lt.CACHE} == {1, 2}


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all lifecycle memory load tests passed")
