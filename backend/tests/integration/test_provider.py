"""Checks the §8 gateway against a fake OpenAI-compatible provider.

Unlike the transport checks, these run the *real* `agent.run` and `planner.plan`
— the tool-call round trip, the JSON parsing, the schema fallback — against a
local server standing in for Gemini. No API key, no network, no cost.

    PYTHONPATH=. python tests/integration/test_provider.py
"""

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PLAN_JSON = {
    "type": "radial_gauge",
    "title": "SYSTEM LOAD",
    "animation": "materialize",
    "interaction": "drill_down",
    "data": {"metrics": [{"label": "CPU", "value": 12.5, "unit": "%"}]},
    "answer": "CPU is at 12.5 percent.",
}


class FakeProvider(BaseHTTPRequestHandler):
    """Scripted responses, plus a record of what the gateway actually sent."""

    requests: list[dict] = []
    #: Set True to make the json_schema attempt fail, exercising the fallback.
    reject_json_schema = False

    def log_message(self, *_args):  # keep test output clean
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeProvider.requests.append(body)

        if body.get("response_format", {}).get("type") == "json_schema":
            if FakeProvider.reject_json_schema:
                self._send(400, {"error": {"message": "json_schema unsupported"}})
                return
            self._send(200, self._message(content=json.dumps(PLAN_JSON)))
            return

        if body.get("response_format", {}).get("type") == "json_object":
            # a markdown fence the model was told not to emit, but did
            self._send(200, self._message(content=f"```json\n{json.dumps(PLAN_JSON)}\n```"))
            return

        # agent turns: first ask for the tool, then answer from its result
        already_ran = any(m.get("role") == "tool" for m in body["messages"])
        if already_ran:
            self._send(200, self._message(content="CPU is at 12.5 percent."))
        else:
            self._send(
                200,
                self._message(
                    tool_calls=[
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "get_system_metrics", "arguments": "{}"},
                            # Gemini attaches this and 400s the next turn if it
                            # is not echoed back.
                            "extra_content": {"google": {"thought_signature": "sig-abc"}},
                        }
                    ]
                ),
            )

    @staticmethod
    def _message(content=None, tool_calls=None) -> dict:
        return {
            "id": "chatcmpl-fake",
            "object": "chat.completion",
            "created": 0,
            "model": "fake",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content, "tool_calls": tool_calls},
                    "finish_reason": "tool_calls" if tool_calls else "stop",
                }
            ],
        }

    def _send(self, status: int, payload: dict):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def with_fake_provider(fn):
    """Point the gateway at a throwaway local server for one test."""

    def wrapper():
        FakeProvider.requests = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeProvider)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]

        previous = {k: os.environ.get(k) for k in ("FRIDAY_LLM_BASE_URL", "FRIDAY_LLM_API_KEY")}
        os.environ["FRIDAY_LLM_BASE_URL"] = f"http://127.0.0.1:{port}/v1"
        os.environ["FRIDAY_LLM_API_KEY"] = "test-key"
        try:
            fn()
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            server.shutdown()
            server.server_close()

    wrapper.__name__ = fn.__name__
    return wrapper


@with_fake_provider
def test_agent_runs_a_tool_and_answers_from_it() -> None:
    from friday import agent

    result = agent.AgentResult(text="")
    events = []

    async def approve(*_):  # not reached: get_system_metrics is low risk
        raise AssertionError("a low-risk tool must not ask for approval")

    async def drive():
        async for event in agent.run("how is the system", approve, result):
            events.append((event.kind, event.payload))

    asyncio.run(drive())

    assert result.text == "CPU is at 12.5 percent.", result.text
    assert [k for k, _ in events] == ["state", "tool", "preview", "state"], events

    # §18 — the preview carries real data, shaped without a model call
    preview = next(p for k, p in events if k == "preview")
    assert preview["type"] == "radial_gauge"
    labels = [m["label"] for m in preview["data"]["metrics"]]
    assert labels == ["CPU", "RAM", "DISK"], labels
    assert result.evidence and result.evidence[0]["tool"] == "get_system_metrics"
    # real psutil output, so only the shape is asserted
    assert "cpu_percent" in result.evidence[0]["output"]

    first, second = FakeProvider.requests[0], FakeProvider.requests[1]
    # tools go out in the OpenAI function shape
    assert first["tools"][0]["function"]["name"] in {"get_system_metrics", "write_note"}
    # the result is fed back as a tool message keyed to the call id
    tool_msg = next(m for m in second["messages"] if m.get("role") == "tool")
    assert tool_msg["tool_call_id"] == "call_1"

    # provider-specific extras must survive the round trip, or Gemini 400s the
    # second turn with "Function call is missing a thought_signature"
    replayed = next(m for m in second["messages"] if m.get("role") == "assistant")
    assert replayed["tool_calls"][0]["extra_content"]["google"]["thought_signature"] == "sig-abc", (
        replayed
    )


@with_fake_provider
def test_a_broken_preview_does_not_lose_the_tool_result() -> None:
    """A preview is decoration; the measurement is not."""
    from friday import agent, tools

    tool = tools.REGISTRY["get_system_metrics"]
    original = tool.preview

    def explode(_output):
        raise ValueError("bad preview")

    object.__setattr__(tool, "preview", explode)
    result = agent.AgentResult(text="")
    kinds = []

    async def approve(*_):
        raise AssertionError("low-risk tools must not ask")

    async def drive():
        async for event in agent.run("how is the system", approve, result):
            kinds.append(event.kind)

    try:
        asyncio.run(drive())  # must not raise
    finally:
        object.__setattr__(tool, "preview", original)

    assert "preview" not in kinds, kinds
    # the turn still completed and the evidence survived
    assert result.text == "CPU is at 12.5 percent.", result.text
    assert result.evidence[0]["tool"] == "get_system_metrics"


@with_fake_provider
def test_planner_parses_a_schema_constrained_reply() -> None:
    from friday.planner import plan

    FakeProvider.reject_json_schema = False
    result = asyncio.run(plan("how is the system", "CPU is at 12.5 percent.", []))
    assert result.type == "radial_gauge"
    assert result.data.metrics[0].value == 12.5
    assert FakeProvider.requests[-1]["response_format"]["type"] == "json_schema"


@with_fake_provider
def test_planner_falls_back_when_json_schema_is_rejected() -> None:
    """Providers vary on schema support; a 400 must degrade, not fail the turn."""
    from friday.planner import plan

    FakeProvider.reject_json_schema = True
    try:
        result = asyncio.run(plan("how is the system", "CPU is at 12.5 percent.", []))
    finally:
        FakeProvider.reject_json_schema = False

    assert result.type == "radial_gauge"
    # it retried in plain JSON mode, and stripped the markdown fence
    kinds = [r.get("response_format", {}).get("type") for r in FakeProvider.requests]
    assert kinds == ["json_schema", "json_object"], kinds


@with_fake_provider
def test_evidence_reaches_the_planner() -> None:
    """The whole point of the tool: the planner must see measured numbers."""
    from friday.planner import plan

    asyncio.run(
        plan("how is the system", "ok", [{"tool": "get_system_metrics", "output": {"cpu_percent": 12.5}}])
    )
    sent = FakeProvider.requests[-1]["messages"][-1]["content"]
    assert "12.5" in sent and "Measured evidence" in sent, sent


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all provider checks passed")
