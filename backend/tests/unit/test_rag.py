"""Docs RAG: chunking, disk-cached index, ranked retrieval, tool wiring.

Fixture corpus + stubbed embeddings — no key, no network.

    PYTHONPATH=. python tests/unit/test_rag.py
"""

import asyncio
import json
import os
import tempfile

from friday import rag
from friday.memory import embed as embed_mod
from friday.rag import chunk_markdown, query_index


def make_corpus():
    tmp = tempfile.TemporaryDirectory()
    with open(os.path.join(tmp.name, "a.md"), "w", encoding="utf-8") as fh:
        fh.write("# Title\n\nIntro.\n\n## Approval flow\n\nConfirm releases tools.\n")
    with open(os.path.join(tmp.name, "b.md"), "w", encoding="utf-8") as fh:
        fh.write("## Caching\n\nRedis holds snapshots.\n")
    return tmp


def use_corpus(tmp, cache=True):
    old = {k: os.environ.get(k) for k in ("FRIDAY_DOCS_ROOT", "FRIDAY_RAG_CACHE", "GEMINI_API_KEY", "FRIDAY_LLM_API_KEY")}
    os.environ["FRIDAY_DOCS_ROOT"] = tmp.name
    os.environ["FRIDAY_RAG_CACHE"] = os.path.join(tmp.name, "index.json")
    os.environ.pop("GEMINI_API_KEY", None)
    os.environ.pop("FRIDAY_LLM_API_KEY", None)
    # configured() needs a key for the negative path only; positive tests
    # below stub llm first, so keep env keyless here and set it per-test.
    return old


def restore_env(old):
    for key, value in old.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def stub_llm_configured(yes: bool):
    from friday import llm as llm_mod

    original = llm_mod.configured
    llm_mod.configured = lambda: yes
    return original


def stub_embed():
    """Deterministic vectors: approval-flavored text -> [1, 0], else [0, 1]."""
    calls = {"n": 0}
    original = embed_mod.embed

    async def fake(texts):
        calls["n"] += 1
        return [[1.0, 0.0] if "pproval" in t else [0.0, 1.0] for t in texts]

    embed_mod.embed = fake
    return original, calls


def test_chunk_split_and_trail() -> None:
    chunks = chunk_markdown("a.md", "# T\n\nIntro.\n\n## Deep\n\nBody here.\n")
    sections = [c["section"] for c in chunks]
    assert sections[0] == "T", sections
    assert any(s == "T / Deep" for s in sections), sections
    assert all(c["path"] == "a.md" for c in chunks)


def test_long_sections_split() -> None:
    body = "\n\n".join(f"paragraph {i} " + "x" * 100 for i in range(40))
    chunks = chunk_markdown("a.md", f"## Big\n\n{body}\n")
    assert len(chunks) > 1
    assert all(len(c["text"]) <= rag.MAX_CHUNK_CHARS + 200 for c in chunks)


def test_build_caches_and_rebuilds_selectively() -> None:
    tmp = make_corpus()
    old_env = use_corpus(tmp)
    orig_llm = stub_llm_configured(True)
    orig_embed, calls = stub_embed()
    try:
        first = asyncio.run(rag.build_index())
        assert "error" not in first, first
        assert calls["n"] == 1, "one batched embed call"
        second = asyncio.run(rag.build_index())
        assert calls["n"] == 1, "fresh cache means no re-embed"
        assert [c["text"] for c in second["chunks"]] == [c["text"] for c in first["chunks"]]
        with open(os.path.join(tmp.name, "c.md"), "w", encoding="utf-8") as fh:
            fh.write("## Approval notes\n\nMore approval text.\n")
        third = asyncio.run(rag.build_index())
        assert calls["n"] == 2, "only the new file re-bills"
        assert len(third["chunks"]) > len(first["chunks"])
    finally:
        embed_mod.embed = orig_embed
        from friday import llm as llm_mod
        llm_mod.configured = orig_llm
        restore_env(old_env)
        tmp.cleanup()


def test_query_ranks_and_floors() -> None:
    chunks = [
        {"path": "a", "section": "s", "text": "t1", "embedding": [1.0, 0.0]},
        {"path": "b", "section": "s", "text": "t2", "embedding": [0.0, 1.0]},
        {"path": "c", "section": "s", "text": "t3", "embedding": [0.7, 0.7]},
    ]
    hits = query_index(chunks, [1.0, 0.0])
    assert [h["path"] for h in hits] == ["a", "c"], hits
    assert hits[0]["score"] == 1.0
    assert query_index(chunks, [0.0, 0.0]) == [], "zero vector matches nothing"


def test_search_docs_needs_key_and_query() -> None:
    tmp = make_corpus()
    old_env = use_corpus(tmp)
    try:
        assert "error" in asyncio.run(rag.run_search_docs({}))
        assert "key" in asyncio.run(rag.run_search_docs({"query": "x"}))["error"]
    finally:
        restore_env(old_env)
        tmp.cleanup()


def test_search_docs_end_to_end_on_fixture() -> None:
    tmp = make_corpus()
    old_env = use_corpus(tmp)
    orig_llm = stub_llm_configured(True)
    orig_embed, _ = stub_embed()
    old_key = os.environ.get("FRIDAY_LLM_API_KEY")
    os.environ["FRIDAY_LLM_API_KEY"] = "test-key"
    try:
        out = asyncio.run(rag.run_search_docs({"query": "how does approval work"}))
        assert "results" in out, out
        assert out["results"][0]["path"] == "a.md"
        assert "Approval" in out["results"][0]["section"]
        assert len(out["results"]) <= rag.MAX_RESULTS
    finally:
        embed_mod.embed = orig_embed
        from friday import llm as llm_mod
        llm_mod.configured = orig_llm
        restore_env(old_env)
        if old_key is not None:
            os.environ["FRIDAY_LLM_API_KEY"] = old_key
        tmp.cleanup()


def test_missing_docs_root_is_an_error() -> None:
    old_env = use_corpus(tempfile.TemporaryDirectory())
    orig_llm = stub_llm_configured(True)
    old_key = os.environ.get("FRIDAY_LLM_API_KEY")
    os.environ["FRIDAY_LLM_API_KEY"] = "test-key"
    try:
        os.environ["FRIDAY_DOCS_ROOT"] = os.path.join("nonexistent-dir-xyz")
        out = asyncio.run(rag.run_search_docs({"query": "x"}))
        assert "error" in out and "not found" in out["error"], out
    finally:
        from friday import llm as llm_mod
        llm_mod.configured = orig_llm
        restore_env(old_env)
        if old_key is not None:
            os.environ["FRIDAY_LLM_API_KEY"] = old_key


def test_policy_declared_and_gated() -> None:
    from friday import policy
    from friday.policy import PolicyContext
    from friday.tools import registry as registry_mod

    tool = registry_mod.REGISTRY["search_docs"]
    assert tool.risk == "low" and tool.capabilities == ("docs.read",)
    assert tool.timeout_s == 60.0
    assert policy.evaluate(tool, "search_docs", {"query": "x"}, PolicyContext()).decision == "allow"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
