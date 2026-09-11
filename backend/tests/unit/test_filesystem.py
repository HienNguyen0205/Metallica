"""Filesystem sandbox: confinement, truncation, and the policy declarations.

    PYTHONPATH=. python tests/unit/test_filesystem.py
"""

import asyncio
import os
import tempfile

from friday import policy
from friday.policy import PolicyContext
from friday.tools.filesystem import sandbox
from friday.tools.filesystem.sandbox import (
    MAX_READ_CHARS,
    run_list_dir,
    run_read_file,
    sandbox_root,
)


def make_tree():
    tmp = tempfile.TemporaryDirectory()
    root = tmp.name
    with open(os.path.join(root, "a.md"), "w", encoding="utf-8") as fh:
        fh.write("hello")
    with open(os.path.join(root, ".env"), "w", encoding="utf-8") as fh:
        fh.write("SECRET=1")
    with open(os.path.join(root, "big.md"), "w", encoding="utf-8") as fh:
        fh.write("x" * (MAX_READ_CHARS + 100))
    with open(os.path.join(root, "blob.bin"), "wb") as fh:
        fh.write(b"\x00\x01binary")
    os.mkdir(os.path.join(root, "sub"))
    with open(os.path.join(root, "sub", "inner.md"), "w", encoding="utf-8") as fh:
        fh.write("in")
    return tmp


def with_root(tmp):
    old = os.environ.get("FRIDAY_SANDBOX_DIR")
    os.environ["FRIDAY_SANDBOX_DIR"] = tmp.name
    return old


def restore_root(old):
    if old is None:
        os.environ.pop("FRIDAY_SANDBOX_DIR", None)
    else:
        os.environ["FRIDAY_SANDBOX_DIR"] = old


def test_list_root_sorted_and_sensitive_filtered() -> None:
    tmp = make_tree()
    old = with_root(tmp)
    try:
        out = asyncio.run(run_list_dir({}))
    finally:
        restore_root(old)
        tmp.cleanup()
    names = [e["name"] for e in out["entries"]]
    assert names == sorted(names), names
    assert ".env" not in names, "sensitive basenames never list"
    kinds = {e["name"]: e["type"] for e in out["entries"]}
    assert kinds["sub"] == "dir" and kinds["a.md"] == "file"
    assert out["path"] == "."


def test_list_subdir_and_errors() -> None:
    tmp = make_tree()
    old = with_root(tmp)
    try:
        assert [e["name"] for e in asyncio.run(run_list_dir({"path": "sub"}))["entries"]] == ["inner.md"]
        assert "error" in asyncio.run(run_list_dir({"path": "nope"}))
        assert "error" in asyncio.run(run_list_dir({"path": "a.md"}))
    finally:
        restore_root(old)
        tmp.cleanup()


def test_traversal_and_absolute_paths_blocked() -> None:
    tmp = make_tree()
    old = with_root(tmp)
    try:
        for hostile in ["..", "../..", "/etc/passwd", "C:\\Windows",
                        "sub/../../..", ""]:
            if hostile == "":
                continue
            out = asyncio.run(run_list_dir({"path": hostile}))
            assert "error" in out, hostile
            out = asyncio.run(run_read_file({"path": hostile or "x"}))
            assert "error" in out, hostile
    finally:
        restore_root(old)
        tmp.cleanup()


def test_symlink_escape_blocked() -> None:
    tmp = make_tree()
    old = with_root(tmp)
    try:
        link = os.path.join(tmp.name, "escape")
        try:
            os.symlink(os.path.dirname(tmp.name), link)
        except OSError:
            print("  skip symlink test (no privilege)")
            return
        out = asyncio.run(run_read_file({"path": "escape"}))
        assert "error" in out, out
        listed = [e["name"] for e in asyncio.run(run_list_dir({}))["entries"]]
        assert "escape" in listed, "the link itself lists; its target stays out"
    finally:
        restore_root(old)
        tmp.cleanup()


def test_read_ok_truncation_and_refusals() -> None:
    tmp = make_tree()
    old = with_root(tmp)
    try:
        ok = asyncio.run(run_read_file({"path": "a.md"}))
        assert ok == {"path": "a.md", "content": "hello",
                      "truncated": False, "size_bytes": 5}, ok
        big = asyncio.run(run_read_file({"path": "big.md"}))
        assert big["truncated"] is True and len(big["content"]) == MAX_READ_CHARS
        assert big["size_bytes"] == MAX_READ_CHARS + 100
        assert "error" in asyncio.run(run_read_file({"path": ".env"}))
        assert "error" in asyncio.run(run_read_file({"path": "blob.bin"}))
        assert "error" in asyncio.run(run_read_file({"path": "missing.md"}))
        assert "error" in asyncio.run(run_read_file({}))
    finally:
        restore_root(old)
        tmp.cleanup()


def test_policy_declared_and_gated() -> None:
    from friday.tools import registry as registry_mod

    for name in ("list_dir", "read_file"):
        tool = registry_mod.REGISTRY[name]
        assert tool.risk == "low" and tool.capabilities == ("filesystem.read",)
        assert tool.timeout_s == 10.0
        ok = policy.evaluate(tool, name, {"path": "x"} if name == "read_file" else {},
                             PolicyContext())
        assert ok.decision == "allow", ok
        denied = policy.evaluate(tool, name, {"path": "x"} if name == "read_file" else {},
                                 PolicyContext(granted_capabilities=frozenset({"system.read"})))
        assert denied.decision == "deny" and "filesystem.read" in denied.reason


def test_default_root_is_notes() -> None:
    old = os.environ.pop("FRIDAY_SANDBOX_DIR", None)
    try:
        assert sandbox_root().name == "notes"
    finally:
        if old is not None:
            os.environ["FRIDAY_SANDBOX_DIR"] = old


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
