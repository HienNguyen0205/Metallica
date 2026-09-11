"""Filesystem sandbox — read-only listing and reading under one root (P4).

First P4 capability, deliberately boring: no new dependencies, no network,
fully deterministic under test. Every P4 checklist item per tool:

- explicit schema: input_schema on the declarations in registry.py
- capability requirements: filesystem.read (P1.8)
- risk classification: low (reads only; writes stay behind write_note/high)
- timeout: timeout_s = 10 (local IO; the run wall-time still applies)
- output limit: read truncates at MAX_READ_CHARS with a flag and byte size
- audit behavior: tool name + risk + argument names via tool.executed
- approval policy: low risk runs unprompted when filesystem.read is granted
- evaluation cases: evals/cases.py filesystem.* (fixture dirs, no network)
- failure semantics: {"error": ...} dicts like every other tool; failures
  record zero-confidence evidence, never exceptions

Confinement is defense in depth, three layers:

1. Resolved absolute paths must stay under the root (kills ../.., absolute
   paths and symlink escapes — symlinks are resolved before comparison).
2. Sensitive basenames (.env*, *.pem, *credential*, *secret*) are refused
   even inside the root, so widening FRIDAY_SANDBOX_DIR can never expose keys.
3. Binary content (NUL byte in the head) is refused rather than replayed
   into the model's context as mojibake.
"""

import fnmatch
import os
from pathlib import Path
from typing import Any

#: Read truncation: full bytes reported, content cut with a flag.
MAX_READ_CHARS = 8000

#: Refused anywhere under the root, matched against the basename.
DENIED_BASENAMES = (".env*", "*.pem", "*credential*", "*secret*")


def sandbox_root() -> Path:
    """Live env read per call, so tests and evals can repoint it."""
    configured = os.getenv("FRIDAY_SANDBOX_DIR")
    if configured:
        return Path(configured).resolve()
    return Path(__file__).resolve().parent.parent.parent.parent / "notes"


def _resolve(rel: Any) -> Path | None:
    """A user path confined to the root, or None with no exception."""
    root = sandbox_root()
    try:
        candidate = (root / str(rel or "")).resolve()
    except (OSError, ValueError):
        return None
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def _denied(name: str) -> bool:
    lowered = name.lower()
    return any(fnmatch.fnmatch(lowered, pattern) for pattern in DENIED_BASENAMES)


def _size(p: Path) -> int:
    try:
        return p.stat().st_size if p.is_file() else 0
    except OSError:
        return -1  # dangling symlink and friends: listed, unsized


async def run_list_dir(payload: dict[str, Any]) -> dict[str, Any]:
    """List one directory level under the root: names, kinds, sizes."""
    target = _resolve(payload.get("path", ""))
    if target is None:
        return {"error": "path escapes the sandbox"}
    if not target.exists():
        return {"error": f"no such path '{payload.get('path', '')}'"}
    if not target.is_dir():
        return {"error": f"not a directory: '{payload.get('path', '')}'"}
    try:
        entries = sorted(target.iterdir(), key=lambda p: p.name)
    except OSError as err:
        return {"error": f"cannot list directory: {type(err).__name__}"}
    return {
        "path": str(target.relative_to(sandbox_root())) or ".",
        "entries": [
            {"name": p.name,
             "type": "dir" if p.is_dir() else "file",
             "size_bytes": _size(p)}
            for p in entries
            if not _denied(p.name)
        ],
    }


async def run_read_file(payload: dict[str, Any]) -> dict[str, Any]:
    """Read one file under the root: content plus size and truncation flag."""
    rel = str(payload.get("path", ""))
    target = _resolve(rel)
    if target is None:
        return {"error": "path escapes the sandbox"}
    if _denied(target.name):
        return {"error": f"refusing sensitive file '{target.name}'"}
    if not target.is_file():
        return {"error": f"no such file '{rel}'"}
    try:
        raw = target.read_bytes()
    except OSError as err:
        return {"error": f"cannot read file: {type(err).__name__}"}
    if b"\x00" in raw[:8192]:
        return {"error": f"refusing binary file '{target.name}'"}
    text = raw.decode("utf-8", errors="replace")
    return {
        "path": rel,
        "content": text[:MAX_READ_CHARS],
        "truncated": len(text) > MAX_READ_CHARS,
        "size_bytes": len(raw),
    }
