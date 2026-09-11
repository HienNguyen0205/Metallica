"""read_note: lists, reads, refuses to leave notes/, and is not gated.

    PYTHONPATH=. python tests/unit/test_read_note.py
"""

import asyncio

from friday import tools
from friday.tools.filesystem.notes import MAX_NOTE_CHARS, NOTES_DIR, run_read_note, run_write_note


def call(payload):
    return asyncio.run(run_read_note(payload))


def setup():
    asyncio.run(run_write_note({"name": "alpha", "body": "first note"}))
    asyncio.run(run_write_note({"name": "beta", "body": "second note"}))


def test_reading_is_not_a_high_risk_action():
    tool = tools.get("read_note")
    assert tool is not None, "read_note must be registered or the model cannot reach it"
    assert not tool.needs_confirmation(), "a read must not put a write approval in front of anyone"
    assert tools.get("write_note").needs_confirmation(), "writing stays gated"


def test_no_name_lists_every_note():
    setup()
    result = call({})
    assert "alpha" in result["notes"] and "beta" in result["notes"], result
    assert "content" not in result, "a listing must not dump every note into the context"


def test_a_named_note_comes_back_whole():
    setup()
    assert call({"name": "alpha"})["content"] == "first note"


def test_a_missing_note_says_so_and_offers_what_exists():
    setup()
    result = call({"name": "nope"})
    assert "error" in result and "alpha" in result["notes"], result


def test_the_name_cannot_escape_the_notes_directory():
    setup()
    # Every separator is rewritten before the join, so traversal resolves to a
    # bare stem inside notes/ that simply does not exist.
    for attempt in ("../../../etc/passwd", "..\\..\\secrets", "/etc/hosts", "C:/Windows/win.ini"):
        result = call({"name": attempt})
        assert "content" not in result, f"{attempt} read something it should not have"
        assert "error" in result, attempt


def test_a_long_note_is_trimmed_not_replayed_whole():
    asyncio.run(run_write_note({"name": "long", "body": "x" * (MAX_NOTE_CHARS + 500)}))
    result = call({"name": "long"})
    assert len(result["content"]) == MAX_NOTE_CHARS
    assert result["truncated"] is True
    (NOTES_DIR / "long.md").unlink()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all read_note tests passed")
