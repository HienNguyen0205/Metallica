"""Dọn ký ức — gộp trùng, bỏ mâu thuẫn, xoá cái không ai nhớ tới.

Chạy nền sau khi `done` đã gửi đi. Nó tốn một model call, và đặt nó trong đường
nóng nghĩa là mỗi câu hỏi thứ hai mươi chậm hơn hẳn mà không có lý do người dùng
nhìn thấy được.
"""

import json
import logging

from friday import llm
from friday.memory import long_term as lt

log = logging.getLogger("friday.memory")

CONSOLIDATE_AT_COUNT = 100
CONSOLIDATE_EVERY_TURNS = 20

#: Ngưỡng theo số ký ức là một mức, không phải một sườn: `run()` không kéo số
#: đếm xuống một cách chắc chắn ("when unsure, keep it"), nên `len(CACHE) > 100`
#: đúng ở mọi turn sau đó và sẽ bắn một model call sau *mỗi* câu hỏi — trên một
#: tier mà nút thắt là request/phút ở khoảng năm query một phút. Cho nó chạy
#: sớm hơn CONSOLIDATE_EVERY_TURNS, nhưng không bao giờ hai turn liền nhau.
CONSOLIDATE_MIN_TURNS = 5

#: Trong process và mất khi restart. Chấp nhận được: mất bộ đếm chỉ làm lượt dọn
#: tới muộn hơn, còn ngưỡng theo số ký ức thì không phụ thuộc nó.
TURN_COUNTER = 0

SYSTEM = """You are pruning an AI assistant's long-term memory.

You will get a numbered list of remembered facts. Reply with JSON only:
{"drop": [ids]}

Drop an id when the fact is a duplicate of another one in the list, is
contradicted by a later one, is a transient measurement rather than a durable
fact, or is too vague to ever be useful. Keep anything about the operator's
preferences, decisions or standing constraints. When unsure, keep it."""


def note_turn() -> None:
    global TURN_COUNTER
    TURN_COUNTER += 1


def should_run() -> bool:
    if TURN_COUNTER >= CONSOLIDATE_EVERY_TURNS:
        return True
    return len(lt.CACHE) > CONSOLIDATE_AT_COUNT and TURN_COUNTER >= CONSOLIDATE_MIN_TURNS


async def choose_drops(memories: list[lt.Memory]) -> list[int]:
    listing = "\n".join(f"{m.id}. ({m.provenance}) {m.fact}" for m in memories)
    response = await llm.client().chat.completions.create(
        model=llm.model(),
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": listing},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    parsed = json.loads(response.choices[0].message.content or "{}")
    return [int(i) for i in parsed.get("drop", [])]


async def run() -> int:
    """Trả số ký ức đã xoá. Không bao giờ ném."""
    global TURN_COUNTER
    TURN_COUNTER = 0

    if not lt.CACHE:
        return 0
    try:
        drops = await choose_drops(list(lt.CACHE))
    except Exception:
        log.warning("consolidation failed; memories left as they were", exc_info=True)
        return 0

    removed = sum([1 for memory_id in drops if await lt.forget(memory_id)])
    if removed:
        log.info("consolidation dropped %d memories", removed)
    return removed
