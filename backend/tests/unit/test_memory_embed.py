"""embed.py: chuẩn hoá đúng, batch một call, hỏng thì ra EmbedError.

    PYTHONPATH=. python tests/unit/test_memory_embed.py
"""

import asyncio
import math

from friday.memory import embed as embed_mod


class FakeEmbeddings:
    def __init__(self, vectors, sink):
        self.vectors = vectors
        self.sink = sink

    async def create(self, **kwargs):
        self.sink.append(kwargs)

        class Item:
            def __init__(self, v):
                self.embedding = v

        class Result:
            pass

        result = Result()
        result.data = [Item(v) for v in self.vectors]
        return result


class FakeClient:
    def __init__(self, vectors, sink):
        self.embeddings = FakeEmbeddings(vectors, sink)


def test_normalize_makes_a_unit_vector():
    out = embed_mod.normalize([3.0, 4.0])
    assert math.isclose(out[0], 0.6) and math.isclose(out[1], 0.8), out
    assert math.isclose(sum(x * x for x in out), 1.0)


def test_a_zero_vector_does_not_divide_by_zero():
    assert embed_mod.normalize([0.0, 0.0]) == [0.0, 0.0]


def test_every_returned_vector_is_normalized():
    sink = []
    embed_mod.client = lambda: FakeClient([[3.0, 4.0], [0.0, 5.0]], sink)
    out = asyncio.run(embed_mod.embed(["a", "b"]))
    for vector in out:
        assert math.isclose(sum(x * x for x in vector), 1.0), vector


def test_the_truncation_and_the_model_are_actually_requested():
    sink = []
    embed_mod.client = lambda: FakeClient([[1.0, 0.0]], sink)
    asyncio.run(embed_mod.embed(["a"]))
    # 768 chiều là thứ giữ mỗi ký ức ở 3KB thay vì 12KB. Quên tham số này thì
    # không có gì hỏng, chỉ tốn gấp bốn - đúng loại lỗi không ai phát hiện.
    assert sink[0]["dimensions"] == embed_mod.EMBED_DIM, sink[0]
    assert sink[0]["model"]


def test_a_batch_goes_out_as_one_request():
    sink = []
    embed_mod.client = lambda: FakeClient([[1.0, 0.0]] * 3, sink)
    asyncio.run(embed_mod.embed(["a", "b", "c"]))
    assert len(sink) == 1, f"{len(sink)} requests for one batch"
    assert sink[0]["input"] == ["a", "b", "c"]


def test_a_provider_failure_becomes_embederror():
    class Boom:
        embeddings = None

        def __getattr__(self, name):
            raise RuntimeError("provider down")

    embed_mod.client = lambda: Boom()
    try:
        asyncio.run(embed_mod.embed(["a"]))
    except embed_mod.EmbedError:
        return
    raise AssertionError("a dead provider must not escape as a bare RuntimeError")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all embed tests passed")
