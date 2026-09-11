"""Docs RAG — answer from our own writing, not the model's prior (P4).

Corpus is the repo docs (FRIDAY_DOCS_ROOT, default docs/): chunked by ##
section, embedded once, cached on disk with mtime + model guards, queried by
cosine. Index builds lazily on first use — never at boot — and the tool
reports unconfigured instead of failing when no embedding key exists.

Checklist: explicit schema (registry), docs.read capability, low risk, 60s
timeout (embedding calls are slow) plus the run wall-time, top-3 × 600-char
output cap, audit via tool.executed, allow policy, eval cases on a fixture
corpus (no network), error-dict failures. Corpus text is ours (provenance
system); relevance floor keeps unrelated sections out of the prompt.
"""

import json
import os
import re
from pathlib import Path
from typing import Any

from friday.memory import embed as embed_mod

#: One extract per hit: context budget, same reasoning as search trimming.
MAX_RESULTS = 3
MAX_CHARS = 600

#: Section text ceiling; longer sections split on paragraph boundaries.
MAX_CHUNK_CHARS = 2000

#: Below this cosine the section is unrelated, not just weakly related.
SIMILARITY_FLOOR = 0.5

_HEADER = re.compile(r"^(#{1,3})\s+(.*)$")


def docs_root() -> Path:
    configured = os.getenv("FRIDAY_DOCS_ROOT")
    if configured:
        return Path(configured).resolve()
    return Path(__file__).resolve().parent.parent.parent.parent / "docs"


def cache_path() -> Path:
    configured = os.getenv("FRIDAY_RAG_CACHE")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parent.parent.parent / ".rag_index.json"


def chunk_markdown(rel: str, text: str) -> list[dict[str, str]]:
    """Split a document by ## headers, prefixed with the section trail so
    each chunk stays intelligible out of order."""
    chunks: list[dict[str, str]] = []
    trail: list[str] = []
    body: list[str] = []

    def flush() -> None:
        content = "\n".join(body).strip()
        if not content:
            return
        section = " / ".join(trail) if trail else rel
        paragraphs = [p for p in re.split(r"\n\s*\n", content) if p.strip()]
        current = ""
        for paragraph in paragraphs:
            if len(current) + len(paragraph) + 2 > MAX_CHUNK_CHARS and current:
                chunks.append({"path": rel, "section": section, "text": current.strip()})
                current = ""
            current += paragraph + "\n\n"
        if current.strip():
            chunks.append({"path": rel, "section": section, "text": current.strip()})

    for line in text.splitlines():
        match = _HEADER.match(line)
        if match:
            flush()
            level, title = len(match.group(1)), match.group(2).strip()
            trail = trail[: level - 1] + [title]
            body = []
        else:
            body.append(line)
    flush()
    return chunks


def _corpus_files(root: Path) -> dict[str, float]:
    return {str(p.relative_to(root)): p.stat().st_mtime
            for p in sorted(root.rglob("*.md")) if p.is_file()}


def _load_cache(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


async def build_index() -> dict[str, Any]:
    """Load the disk cache when fresh, else (re)embed changed files. Returns
    {"chunks": [...], "model": ...} or {"error": ...} — never raises."""
    from friday import llm as llm_mod

    if not llm_mod.configured():
        return {"error": "docs search needs an embedding key"}
    root = docs_root()
    if not root.is_dir():
        return {"error": f"docs root not found: {root}"}
    cache_file = cache_path()
    files = _corpus_files(root)
    cached = _load_cache(cache_file)
    if (cached and cached.get("model") == embed_mod.model()
            and cached.get("files") == files and isinstance(cached.get("chunks"), list)):
        return {"chunks": cached["chunks"], "model": cached["model"]}

    old_chunks = {c["text"]: c for c in (cached or {}).get("chunks", []) if "embedding" in c}
    chunks: list[dict[str, Any]] = []
    for rel in sorted(files):
        try:
            text = (root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError as err:
            return {"error": f"cannot read {rel}: {type(err).__name__}"}
        for chunk in chunk_markdown(rel, text):
            chunks.append(chunk)
    fresh: list[dict[str, Any]] = []
    for chunk in chunks:
        old = old_chunks.get(chunk["text"])
        if old is not None:
            # Identical text keeps its old embedding: an edited file does
            # not re-bill the whole corpus.
            chunk["embedding"] = old["embedding"]
        else:
            fresh.append(chunk)
    if fresh:
        try:
            # Embed section trail + body: titles carry the topic ("Approval
            # flow"), and a chunk retrieved without them often misses it.
            vectors = await embed_mod.embed(
                [f"{c['section']}\n{c['text']}" for c in fresh])
        except embed_mod.EmbedError as err:
            return {"error": f"embedding failed: {err}"}
        for chunk, vector in zip(fresh, vectors):
            chunk["embedding"] = vector
    try:
        cache_file.write_text(json.dumps({
            "model": embed_mod.model(), "files": files, "chunks": chunks,
        }), encoding="utf-8")
    except OSError:
        pass  # a missing cache only costs a rebuild next time
    return {"chunks": chunks, "model": embed_mod.model()}


def query_index(chunks: list[dict], query_vector: list[float],
                top_k: int = MAX_RESULTS) -> list[dict]:
    """Cosine rank over chunk embeddings, floor-filtered."""
    import math

    scored = []
    for chunk in chunks:
        emb = chunk.get("embedding") or []
        if len(emb) != len(query_vector) or not emb:
            continue
        denom = math.sqrt(sum(x * x for x in emb)) * math.sqrt(sum(y * y for y in query_vector))
        score = sum(x * y for x, y in zip(emb, query_vector)) / denom if denom else 0.0
        if score >= SIMILARITY_FLOOR:
            scored.append((score, chunk))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [{"path": c["path"], "section": c["section"],
             "extract": c["text"][:MAX_CHARS], "score": round(s, 3)}
            for s, c in scored[:top_k]]


async def run_search_docs(payload: dict[str, Any]) -> dict[str, Any]:
    """Search the repo docs for the query. Read-only over the corpus."""
    query = str(payload.get("query", "")).strip()
    if not query:
        return {"error": "empty query"}
    index = await build_index()
    if "error" in index:
        return index
    try:
        vectors = await embed_mod.embed([query])
    except embed_mod.EmbedError as err:
        return {"error": f"embedding failed: {err}"}
    results = query_index(index["chunks"], vectors[0])
    if not results:
        return {"error": "no matching docs"}
    return {"results": results}
