"""Recall chèn vào prompt, event memory ra tới stream, và cả hai đường hỏng.

    PYTHONPATH=. python tests/integration/test_recall_stream.py
"""

import asyncio
import json

from friday import agent, main
from friday.api import routes
from friday.memory import embed as embed_mod
from friday.memory import long_term as lt
from friday.schema import VisualizationPlan, VizData

PLAN = VisualizationPlan(
    type="radial_gauge", title="X", data=VizData(metrics=[]), answer="a",
)


def parse(chunk):
    name, _, data = chunk.strip().partition("\n")
    return name.removeprefix("event: "), json.loads(data.removeprefix("data: "))


def collect(query="q"):
    async def drain():
        return [parse(c) async for c in main.run_query(query)]

    return asyncio.run(drain())


def stub_planner():
    async def fake_plan(q, a, evidence, pinned_type=None):
        return PLAN

    main.plan = fake_plan


def test_a_relevant_memory_reaches_the_system_prompt():
    lt.clear()
    lt.CACHE.append(lt.Memory(id=1, fact="thích đơn vị mét", provenance="user", embedding=[1.0, 0.0]))

    async def fake_embed(texts):
        return [[1.0, 0.0] for _ in texts]

    embed_mod.embed = fake_embed
    block = asyncio.run(main.recall_block("đo bằng gì"))
    assert "thích đơn vị mét" in block
    assert "<remembered_facts>" in block


def test_a_dead_embedder_skips_recall_without_failing_the_turn():
    lt.clear()
    lt.CACHE.append(lt.Memory(id=1, fact="f", provenance="user", embedding=[1.0, 0.0]))

    async def boom(texts):
        raise embed_mod.EmbedError("provider down")

    embed_mod.embed = boom
    assert asyncio.run(main.recall_block("q")) == "", "recall hỏng không được kéo turn theo"


def test_the_memory_event_reaches_the_stream():
    stub_planner()

    async def fake_agent(query, approve, result, history=(), memories=""):
        yield agent.AgentEvent("memory", {"id": 1, "fact": "đã học", "provenance": "user"})
        result.text = "xong"

    original, agent.run = agent.run, fake_agent
    try:
        events = collect()
    finally:
        agent.run = original

    names = [n for n, _ in events]
    assert "memory" in names, names
    payload = next(p for n, p in events if n == "memory")
    assert payload["fact"] == "đã học" and payload["provenance"] == "user"


def test_recall_reaches_agent_run_as_the_memories_argument():
    """Chứng minh khối recall thực sự bay tới agent.run, không chỉ tồn tại lẻ loi.

    Xoá tham số `memories` khỏi lời gọi agent.run trong pump() (hoặc bỏ nó khỏi
    system prompt trong agent.py) và mọi test khác vẫn xanh — FRIDAY âm thầm
    không bao giờ nhớ gì, trông y hệt "không có ký ức liên quan". Test này bắt
    đúng chỗ hở đó bằng cách bắt lấy đối số `memories` mà agent.run nhận được.
    """
    stub_planner()
    lt.clear()
    lt.CACHE.append(lt.Memory(id=1, fact="thích đơn vị mét", provenance="user", embedding=[1.0, 0.0]))

    async def fake_embed(texts):
        return [[1.0, 0.0] for _ in texts]

    embed_mod.embed = fake_embed

    captured = {}

    async def capturing_agent(query, approve, result, history=(), memories=""):
        captured["memories"] = memories
        result.text = "ok"
        return
        yield  # pragma: no cover - makes this an async generator

    original, agent.run = agent.run, capturing_agent
    try:
        collect("đo bằng gì")
    finally:
        agent.run = original

    assert "thích đơn vị mét" in captured.get("memories", ""), captured


def test_a_recall_explosion_still_closes_the_stream():
    """`state: thinking` đã bay đi trước khi recall chạy.

    Nên nếu recall ném ra ngoài try của run_query, stream kết thúc không
    `error`, không `done`, và HUD kẹt ở THINKING mãi mãi - đúng cái hỏng mà
    test_agent_failure_still_closes_the_stream tồn tại để chặn, chỉ khác chỗ
    xảy ra. Recall phải nằm *trong* try.
    """
    stub_planner()

    async def boom(query):
        raise RuntimeError("recall exploded")

    original, routes.recall_block = routes.recall_block, boom
    try:
        events = collect()
    finally:
        routes.recall_block = original

    names = [n for n, _ in events]
    assert "error" in names, names
    assert names[-1] == "done", names


def test_recall_survives_a_failure_that_is_not_an_embedding_error():
    """"Memory là phần thêm, không bao giờ là điều kiện" phải đúng theo cấu
    trúc, không phải vì hôm nay mọi callee tình cờ chỉ ném EmbedError.

    Ở đây embedder trả về vector lệch chiều, nên `similarity` ném ValueError từ
    trong `top_k` - một đường mà một `except EmbedError` hẹp sẽ để lọt thẳng
    lên run_query.
    """
    lt.clear()
    lt.CACHE.append(lt.Memory(id=1, fact="f", provenance="user", embedding=[1.0, 0.0]))

    async def wrong_width(texts):
        return [[1.0, 0.0, 0.0] for _ in texts]

    embed_mod.embed = wrong_width
    assert asyncio.run(main.recall_block("q")) == "", "recall hỏng không được kéo turn theo"


def test_memory_is_in_the_declared_event_contract():
    with open("contracts/events.json", encoding="utf-8") as fh:
        contract = json.load(fh)
    # Frontend đọc file này để biết event nào tồn tại. Thêm event mà quên
    # contract là cách để hai bên lệch nhau trong im lặng.
    assert "memory" in contract["events"], contract["events"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all recall stream tests passed")
