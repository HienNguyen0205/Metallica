"""Deterministic eval runner (P2). Drives agent.run against scripted model
turns with stubbed side effects — no key, no network, no cost — and scores
each case on routing, gates, memory, claims, and answer text.

Metrics recorded per case: latency_ms, tool calls, approvals, confirms.
Token/cost metering does not exist yet (model-routing phase); the summary
reserves the keys as null so dashboards built on this shape keep working.
"""

import asyncio
import dataclasses
import json
import os
import shutil
import sys
import tempfile
import time

# Direct-script support (python backend/evals/runner.py from the root):
# ensure backend/ is importable before anything else.
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from friday import agent
from friday import llm as llm_mod
from friday.agent.state import AgentResult
from friday.memory import embed as embed_mod
from friday.memory import long_term as lt
from friday.tools import registry as registry_mod
from friday.tools.base import Tool

try:
    from .cases import CASES
except ImportError:  # direct script execution: python backend/evals/runner.py
    import sys as _sys

    _sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from evals.cases import CASES
#: Temp tools some cases need (capability-denial probes). Never shipped.
TEMP_TOOLS = {
    "zz_vault": Tool(name="zz_vault", description="probe",
                     input_schema={}, risk="low", run=None,
                     capabilities=("vault.read.topsecret",)),
}


async def _ok_run(_input):
    return {"ok": True}


class _Call:
    def __init__(self, name, args):
        self.id = f"call_{name}"
        self.function = type("F", (), {"name": name,
                                       "arguments": json.dumps(args)})()

    def model_dump(self):
        return {"id": self.id,
                "function": {"name": self.function.name,
                             "arguments": self.function.arguments}}


class _Message:
    def __init__(self, calls=None, content=""):
        self.tool_calls = calls
        self.content = content


class _Choice:
    def __init__(self, message):
        self.message = message


class _Completion:
    def __init__(self, message):
        self.choices = [_Choice(message)]


def _substitute(value, base: str):
    """Replace the {BASE} placeholder with the fixture server URL, anywhere
    in the script structure."""
    if isinstance(value, str):
        return value.replace("{BASE}", base)
    if isinstance(value, list):
        return [_substitute(v, base) for v in value]
    if isinstance(value, tuple):
        return tuple(_substitute(v, base) for v in value)
    if isinstance(value, dict):
        return {k: _substitute(v, base) for k, v in value.items()}
    return value


def run_case(case: dict) -> dict:
    """Returns {"id", "area", "passed", "failures": [...], "metrics": {...}}."""
    failures: list[str] = []
    script = list(case["script"])
    approvals: list[str] = []
    inserted: list[dict] = []

    class FakeCompletions:
        async def create(self, **kwargs):
            kind = script.pop(0)
            if kind[0] == "tool":
                _, name, args = kind
                return _Completion(_Message(calls=[_Call(name, args)]))
            return _Completion(_Message(content=kind[1]))

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    async def fake_embed(texts):
        return [[1.0, 0.0] for _ in texts]

    def fake_insert(fact, prov, emb):
        row = {"id": len(inserted) + 1, "fact": fact, "provenance": prov,
               "created_at": "t", "last_used_at": "t"}
        inserted.append(row)
        return row

    async def fake_write_note(payload):
        return {"written": "eval.md"}

    async def fake_search_web(payload):
        return {"results": [{"title": "t", "url": "u", "extract": "the office closes at 9pm"}]}

    async def approve(tool, risk, payload):
        approvals.append(tool)
        if case["approve"] == "never":
            raise AssertionError(f"{tool} must never prompt the operator")
        return bool(case["approve"])

    # ---- patch surface (all restored in finally) ----
    original_client, original_model = llm_mod.client, llm_mod.model
    llm_mod.client = lambda: FakeClient()
    llm_mod.model = lambda: "eval-fake"
    orig_embed, orig_cfg, orig_ins, orig_del = (
        lt.embed, lt.store_configured, lt.store_insert, lt.store_delete)
    lt.embed = fake_embed
    lt.store_configured = lambda: True
    lt.store_insert = fake_insert
    lt.store_delete = lambda mid: None
    lt.clear()
    lt.TURN_TOOLS.set(set())
    orig_write = registry_mod.REGISTRY["write_note"]
    registry_mod.REGISTRY["write_note"] = dataclasses.replace(orig_write, run=fake_write_note)
    orig_search = registry_mod.REGISTRY["search_web"]
    registry_mod.REGISTRY["search_web"] = dataclasses.replace(orig_search, run=fake_search_web)
    temp_installed = []
    for name in case.get("tools", []):
        tool = TEMP_TOOLS[name]
        registry_mod.REGISTRY[name] = dataclasses.replace(
            tool, run=_ok_run, capabilities=tool.capabilities)
        temp_installed.append(name)
    old_grants = os.environ.get("FRIDAY_GRANTED_CAPABILITIES")
    if "grants" in case:
        os.environ["FRIDAY_GRANTED_CAPABILITIES"] = case["grants"]
    # P4 — case-scoped HTTP fixture: pages declared inline, served on
    # localhost with private fetch allowed for the case only. Real HTTP
    # stack, no external network.
    http_server = None
    old_private = os.environ.get("FRIDAY_ALLOW_PRIVATE_FETCH")
    if "http_pages" in case:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        pages = case["http_pages"]

        class _FixtureHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                body, ctype, code = pages.get(self.path, ("nope", "text/plain", 404))
                raw = body.encode()
                self.send_response(code)
                self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        http_server = ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
        threading.Thread(target=http_server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{http_server.server_address[1]}"
        os.environ["FRIDAY_ALLOW_PRIVATE_FETCH"] = "1"
        script = _substitute(script, base)
    # P4 — case-scoped sandbox fixture: files declared inline, root repointed,
    # everything removed afterwards. Real filesystem, no network.
    sandbox_tmp = None
    old_sandbox = os.environ.get("FRIDAY_SANDBOX_DIR")
    if "sandbox_files" in case:
        sandbox_tmp = tempfile.mkdtemp(prefix="eval-fs-")
        for rel, content in case["sandbox_files"].items():
            dest = os.path.join(sandbox_tmp, rel)
            parent = os.path.dirname(dest)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(content)
        os.environ["FRIDAY_SANDBOX_DIR"] = sandbox_tmp
    # P4 — case-scoped docs corpus: files declared inline, indexed with a
    # constant stub embedding (every chunk scores identically, so retrieval
    # order is deterministic file order; ranking quality belongs to the
    # provider, plumbing is what's under eval here).
    docs_tmp = None
    old_docs_root = os.environ.get("FRIDAY_DOCS_ROOT")
    old_rag_cache = os.environ.get("FRIDAY_RAG_CACHE")
    orig_rag_embed = None
    orig_configured = None
    if "docs_files" in case:
        docs_tmp = tempfile.mkdtemp(prefix="eval-docs-")
        for rel, content in case["docs_files"].items():
            dest = os.path.join(docs_tmp, rel)
            parent = os.path.dirname(dest)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(content)
        os.environ["FRIDAY_DOCS_ROOT"] = docs_tmp
        os.environ["FRIDAY_RAG_CACHE"] = os.path.join(docs_tmp, "index.json")

        async def _fake_rag_embed(texts):
            return [[1.0, 0.0] for _ in texts]

        orig_rag_embed = embed_mod.embed
        embed_mod.embed = _fake_rag_embed
        orig_configured = llm_mod.configured
        llm_mod.configured = lambda: True

    started = time.perf_counter()
    try:
        async def scenario():
            result = AgentResult(text="")
            events = []
            async for ev in agent.run(case["input"], approve, result, emit_steps=True):
                events.append(ev)
            return result, events

        result, events = asyncio.run(scenario())
    finally:
        llm_mod.client, llm_mod.model = original_client, original_model
        lt.embed, lt.store_configured, lt.store_insert, lt.store_delete = (
            orig_embed, orig_cfg, orig_ins, orig_del)
        lt.clear()
        registry_mod.REGISTRY["write_note"] = orig_write
        registry_mod.REGISTRY["search_web"] = orig_search
        for name in temp_installed:
            registry_mod.REGISTRY.pop(name, None)
        if old_grants is None:
            os.environ.pop("FRIDAY_GRANTED_CAPABILITIES", None)
        else:
            os.environ["FRIDAY_GRANTED_CAPABILITIES"] = old_grants
        if old_sandbox is None:
            os.environ.pop("FRIDAY_SANDBOX_DIR", None)
        else:
            os.environ["FRIDAY_SANDBOX_DIR"] = old_sandbox
        if sandbox_tmp is not None:
            shutil.rmtree(sandbox_tmp, ignore_errors=True)
        if old_private is None:
            os.environ.pop("FRIDAY_ALLOW_PRIVATE_FETCH", None)
        else:
            os.environ["FRIDAY_ALLOW_PRIVATE_FETCH"] = old_private
        if http_server is not None:
            http_server.shutdown()
            http_server.server_close()
        if docs_tmp is not None:
            embed_mod.embed = orig_rag_embed
            llm_mod.configured = orig_configured
            if old_docs_root is None:
                os.environ.pop("FRIDAY_DOCS_ROOT", None)
            else:
                os.environ["FRIDAY_DOCS_ROOT"] = old_docs_root
            if old_rag_cache is None:
                os.environ.pop("FRIDAY_RAG_CACHE", None)
            else:
                os.environ["FRIDAY_RAG_CACHE"] = old_rag_cache
            shutil.rmtree(docs_tmp, ignore_errors=True)
    latency_ms = (time.perf_counter() - started) * 1000

    executed = [e.payload["tool"] for e in events if e.kind == "tool"]
    confirms = [e for e in events if e.kind == "confirm"]

    def check(cond: bool, message: str) -> None:
        if not cond:
            failures.append(message)

    for name in case.get("must_call", []):
        check(name in executed, f"must_call {name}: executed={executed}")
    for name in case.get("must_not_call", []):
        check(name not in executed, f"must_not_call {name}: executed={executed}")
    if case["approve"] == "never":
        check(confirms == [] and approvals == [],
              f"no human prompt expected: confirms={len(confirms)} approvals={approvals}")
    if case.get("expect_answer") is not None:
        check(case["expect_answer"] in (result.text or ""),
              f"answer {result.text!r} lacks {case['expect_answer']!r}")
    if case.get("expect_memory") == "accepted":
        check(len(inserted) == 1, f"memory accepted: inserts={len(inserted)}")
    if case.get("expect_memory") == "rejected":
        check(inserted == [], f"memory rejected: inserts={inserted}")
    if case.get("expect_claim") is not None:
        statuses = [c.get("status") for c in result.claims]
        check(statuses[:1] == [case["expect_claim"]],
              f"claim status {statuses} != [{case['expect_claim']}]")

    return {
        "id": case["id"],
        "area": case["area"],
        "passed": not failures,
        "failures": failures,
        "metrics": {
            "latency_ms": round(latency_ms, 1),
            "tool_calls": len(executed),
            "approvals": len(approvals),
            "confirms": len(confirms),
            "tokens_in": None,  # pending metering (model-routing phase)
            "tokens_out": None,
            "estimated_cost_usd": None,
        },
    }


def run_all(area: str | None = None) -> dict:
    """Run cases (optionally one area). Prints a line per case plus a summary."""
    selected = [c for c in CASES if not c.get("live") and (area is None or c["area"] == area)]
    results = [run_case(case) for case in selected]
    failed = [r for r in results if not r["passed"]]
    latencies = [r["metrics"]["latency_ms"] for r in results]
    summary = {
        "total": len(results),
        "passed": len(results) - len(failed),
        "failed": len(failed),
        "accuracy": round((len(results) - len(failed)) / max(len(results), 1), 4),
        "avg_latency_ms": round(sum(latencies) / max(len(latencies), 1), 1),
        "areas": sorted({c["area"] for c in CASES}),
    }
    for r in results:
        mark = "ok" if r["passed"] else "FAIL"
        print(f"  {mark}  {r['id']} ({r['metrics']['latency_ms']}ms, "
              f"{r['metrics']['tool_calls']} tools)")
        for f in r["failures"]:
            print(f"        - {f}")
    print(f"evals: {summary['passed']}/{summary['total']} passed "
          f"(accuracy {summary['accuracy']}, avg {summary['avg_latency_ms']}ms)")
    return {"results": results, "summary": summary}


if __name__ == "__main__":
    import sys

    area = sys.argv[1] if len(sys.argv) > 1 else None
    raise SystemExit(0 if run_all(area)["summary"]["failed"] == 0 else 1)
