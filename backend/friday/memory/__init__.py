"""§15 memory. Ngắn hạn là hội thoại nguyên văn gần đây; dài hạn là sự thật đã
chưng cất, bền qua restart.

`history` / `remember` / `clear` giữ nguyên chữ ký từ thời module này còn là một
file, nên `from friday import memory` ở routes.py và test không phải đổi gì.
"""

from . import long_term
from .short_term import MAX_SESSIONS, MAX_TURNS, _sessions, clear, history, remember

__all__ = ["MAX_SESSIONS", "MAX_TURNS", "_sessions", "clear", "history", "long_term", "remember"]
