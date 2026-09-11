"""Backend test runner — one command for the whole Python suite.

Run from the repo root:  python backend/runtests.py [filter ...]
Optional filters are substrings matched against test filenames, e.g.
  python backend/runtests.py test_contracts   # contract tests only
  python backend/runtests.py unit             # tests/unit only

Each test file runs in its own process with PYTHONPATH=backend, mirroring
.github/workflows/ci.yml and backend/README.md (no pytest dependency).
"""

import os
import subprocess
import sys

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
TEST_DIRS = ("tests/unit", "tests/integration")


def discover(filters: list[str]) -> list[str]:
    found: list[str] = []
    for sub in TEST_DIRS:
        d = os.path.join(BACKEND_DIR, sub)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not (name.startswith("test_") and name.endswith(".py")):
                continue
            rel = os.path.join(sub, name)
            if filters and not any(f in rel.replace(os.sep, "/") for f in filters):
                continue
            found.append(os.path.join(BACKEND_DIR, rel))
    return found


def main(argv: list[str]) -> int:
    files = discover(argv[1:])
    if not files:
        print(f"runtests: no tests match {argv[1:]!r}")
        return 2
    env = dict(os.environ)
    env["PYTHONPATH"] = BACKEND_DIR + os.pathsep + env.get("PYTHONPATH", "")
    failed: list[str] = []
    for path in files:
        rel = os.path.relpath(path, BACKEND_DIR)
        proc = subprocess.run(
            [sys.executable, path], cwd=BACKEND_DIR, env=env,
            capture_output=True, text=True,
        )
        if proc.returncode == 0:
            print(f"  ok  {rel}")
        else:
            failed.append(rel)
            print(f"FAIL  {rel} (exit {proc.returncode})")
            out = (proc.stdout + proc.stderr).strip().splitlines()
            for line in out[-15:]:
                print(f"        {line}")
    print(f"runtests: {len(files) - len(failed)}/{len(files)} files passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
