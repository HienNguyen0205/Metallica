"""Filesystem note tools — confined to notes/. Writing is high-risk, reading is not."""

import re
from pathlib import Path
from typing import Any

NOTES_DIR = Path(__file__).resolve().parent.parent.parent.parent / "notes"
_SAFE_NAME = re.compile(r"[^A-Za-z0-9_-]")

#: A note is replayed into the model's context whole. Cut it at a budget rather
#: than letting one long file crowd out the conversation it was read for.
MAX_NOTE_CHARS = 4000

#: Write path bound: read truncates, but an unbounded write fills disk and
#: poisons future context replays. Reject before touching the filesystem.
MAX_WRITE_BYTES = 20_000


def _stem(raw: Any) -> str:
    """A bare filename stem, rebuilt from scratch rather than trusted.

    Nothing the model sends is ever used as a path component verbatim — every
    separator, dot and drive letter is replaced before this is joined to
    NOTES_DIR, so `../../etc/passwd` becomes `------etc-passwd` and stays
    inside the directory.
    """
    return _SAFE_NAME.sub("-", str(raw).strip())[:64].strip("-")


async def run_write_note(payload: dict[str, Any]) -> dict[str, Any]:
    body = str(payload.get("body", ""))
    if len(body.encode("utf-8")) > MAX_WRITE_BYTES:
        return {"error": f"note body exceeds {MAX_WRITE_BYTES} bytes"}

    stem = _stem(payload.get("name", ""))
    if not stem:
        return {"error": "invalid note name"}

    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    target = NOTES_DIR / f"{stem}.md"
    target.write_text(body, encoding="utf-8")
    return {"written": target.name, "bytes": len(body.encode("utf-8"))}


async def run_read_note(payload: dict[str, Any]) -> dict[str, Any]:
    """Read one note, or list them when no name is given.

    This exists because without it the model answered "what did you just
    write?" by reaching for `write_note` — the only notes-shaped tool it had.
    That put a high-risk write approval in front of an operator who had asked
    to read, and the answer ended up being about the refusal rather than about
    the note. A read tool is the fix; making it `low` is the point of it.
    """
    if not NOTES_DIR.is_dir():
        return {"notes": []}

    names = sorted(p.stem for p in NOTES_DIR.glob("*.md"))

    stem = _stem(payload.get("name", ""))
    if not stem:
        return {"notes": names}

    target = NOTES_DIR / f"{stem}.md"
    if not target.is_file():
        return {"error": f"no note named '{stem}'", "notes": names}

    text = target.read_text(encoding="utf-8", errors="replace")
    return {
        "name": target.stem,
        "content": text[:MAX_NOTE_CHARS],
        "truncated": len(text) > MAX_NOTE_CHARS,
    }
