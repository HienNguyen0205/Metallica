"""Tool remember trong vòng agent: đăng ký, không bị gate, phát event, gắn provenance.

    PYTHONPATH=. python tests/integration/test_remember_flow.py
"""

import asyncio
import dataclasses
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from friday import agent, tools
from friday.memory import long_term as lt
from friday.tools.registry import REGISTRY

REMEMBER_CALL = ("remember", {"fact": "operator prefers dark mode"})
SEARCH_CALL = ("search_web", {"query": "office hours"})


class _ScriptedProvider(BaseHTTPRequestHandler):
    """Scripts a fixed list of tool calls, one per round, then a plain answer.

    Same technique as tests/integration/test_provider.py's FakeProvider: a
    throwaway local OpenAI-compatible server so agent.run() runs for real,
    just scripted for the tools this file is about. Which call comes next is
    read off how many tool results are already in the transcript, so the whole
    script runs through the real loop rather than one call at a time.
    """

    SCRIPT: list = []

    def log_message(self, *_args):  # keep test output clean
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        done = sum(1 for m in body["messages"] if m.get("role") == "tool")
        if done >= len(self.SCRIPT):
            message = {"role": "assistant", "content": "Noted.", "tool_calls": None}
            finish_reason = "stop"
        else:
            name, arguments = self.SCRIPT[done]
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": f"call_{done}",
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments)},
                    }
                ],
            }
            finish_reason = "tool_calls"

        payload = {
            "id": "chatcmpl-fake",
            "object": "chat.completion",
            "created": 0,
            "model": "fake",
            "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        }
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def stub_memory():
    lt.clear()
    lt.store_configured = lambda: True
    lt.store_insert = lambda fact, prov, emb: {
        "id": 1, "fact": fact, "provenance": prov,
        "created_at": "2026-01-01", "last_used_at": "2026-01-01",
    }

    async def fake_embed(texts):
        return [[1.0, 0.0] for _ in texts]

    lt.embed = fake_embed


def drive(script):
    """Run the real agent.run() against a provider scripted with these calls."""
    handler = type("_Scripted", (_ScriptedProvider,), {"SCRIPT": script})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]

    previous = {k: os.environ.get(k) for k in ("FRIDAY_LLM_BASE_URL", "FRIDAY_LLM_API_KEY")}
    os.environ["FRIDAY_LLM_BASE_URL"] = f"http://127.0.0.1:{port}/v1"
    os.environ["FRIDAY_LLM_API_KEY"] = "test-key"

    events = []
    try:
        result = agent.AgentResult(text="")

        async def approve(*_):
            raise AssertionError("nothing in these scripts is high risk")

        async def run():
            async for event in agent.run("remember that I like dark mode", approve, result):
                events.append(event)

        asyncio.run(run())
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        server.shutdown()
        server.server_close()
    return events


def test_remember_is_registered_and_ungated():
    tool = tools.get("remember")
    assert tool is not None, "model không thể gọi thứ không có trong registry"
    assert not tool.needs_confirmation(), "một ghi chú không nên ngắt lời người dùng"


def test_a_write_reaches_the_operator_as_an_event():
    """Drives the real agent.run() loop — not a stand-in for the emission.

    Ghi âm thầm là ghi không ai kiểm được - đây là toàn bộ biện pháp bảo vệ, nên
    phải test đường thật: model gọi remember qua vòng lặp thật, run_remember
    thật sự ghi, rồi event phải lọt ra ngoài cho operator thấy.
    """
    stub_memory()
    events = drive([REMEMBER_CALL])

    memory_events = [e for e in events if e.kind == "memory"]
    assert memory_events, events
    assert memory_events[0].payload["fact"] == "operator prefers dark mode", memory_events
    assert memory_events[0].payload["provenance"] == "user", memory_events


def test_a_fact_distilled_after_a_search_is_marked_as_coming_from_the_web():
    """Cùng một vòng lặp thật, chỉ khác là search_web chạy trước.

    `long_term.mark_tool_used(tool.name)` trong agent.py là lời ghi *duy nhất*
    vào TURN_TOOLS ở production. Không có test nào ở đây, xoá dòng đó vẫn xanh
    hết - và mọi ký ức chưng cất từ một trang web độc sẽ được ghi và hiện ra là
    `(user)`: cảnh báo `(tool)` trong khối recall không bao giờ bật, HUD không
    bao giờ hiện FROM WEB, không log nào nói gì. Nên provenance phải được đọc ở
    đầu ra thật của vòng lặp, sau khi hai tool chạy thật trong cùng một turn.
    """
    stub_memory()

    async def fake_search(payload):
        return {"results": [{"title": "t", "url": "u", "extract": "the office closes at 9pm"}]}

    original = REGISTRY["search_web"]
    REGISTRY["search_web"] = dataclasses.replace(original, run=fake_search)
    try:
        events = drive([SEARCH_CALL, REMEMBER_CALL])
    finally:
        REGISTRY["search_web"] = original

    tools_run = [e.payload["tool"] for e in events if e.kind == "tool"]
    assert tools_run == ["search_web", "remember"], tools_run

    memory_events = [e for e in events if e.kind == "memory"]
    assert memory_events, events
    assert memory_events[0].payload["provenance"] == "tool", memory_events
    assert lt.CACHE[0].provenance == "tool", lt.CACHE


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all remember flow tests passed")
