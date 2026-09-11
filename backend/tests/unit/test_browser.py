"""Browser fetch: extraction, caps, and the SSRF guardrails.

Local HTTP fixture only — no external network anywhere in this file.

    PYTHONPATH=. python tests/unit/test_browser.py
"""

import asyncio
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from friday import policy
from friday.policy import PolicyContext
from friday.tools.integrations import fetch as fetch_mod
from friday.tools.integrations.fetch import run_fetch_url

BIG_TEXT = "lorem ipsum dolor sit amet " * 200  # ~5k chars, over the cap


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _send(self, body: bytes, content_type="text/html", code=200):
        self.send_response(code)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/page":
            self._send(b"<html><head><title>Fixture</title></head>"
                       b"<body><h1>Hi</h1><p>readable text here</p></body></html>")
        elif self.path == "/big":
            self._send(f"<html><body><p>{BIG_TEXT}</p></body></html>".encode())
        elif self.path == "/bin":
            self._send(b"\x00\x01\x02", "application/octet-stream")
        else:
            self._send(b"nope", "text/plain", 404)


def serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def allow_private(on: bool):
    old = os.environ.get("FRIDAY_ALLOW_PRIVATE_FETCH")
    if on:
        os.environ["FRIDAY_ALLOW_PRIVATE_FETCH"] = "1"
    else:
        os.environ.pop("FRIDAY_ALLOW_PRIVATE_FETCH", None)
    return old


def restore_private(old):
    if old is None:
        os.environ.pop("FRIDAY_ALLOW_PRIVATE_FETCH", None)
    else:
        os.environ["FRIDAY_ALLOW_PRIVATE_FETCH"] = old


def test_extracts_title_and_text() -> None:
    server, base = serve()
    old = allow_private(True)
    try:
        out = asyncio.run(run_fetch_url({"url": f"{base}/page"}))
    finally:
        restore_private(old)
        server.shutdown()
        server.server_close()
    assert out["title"] == "Fixture", out
    assert "readable text here" in out["content"], out
    assert out["truncated"] is False and out["url"].endswith("/page")


def test_truncates_long_pages() -> None:
    server, base = serve()
    old = allow_private(True)
    try:
        out = asyncio.run(run_fetch_url({"url": f"{base}/big"}))
    finally:
        restore_private(old)
        server.shutdown()
        server.server_close()
    assert out["truncated"] is True
    assert len(out["content"]) == fetch_mod.MAX_EXTRACT_CHARS


def test_http_status_and_content_guards() -> None:
    server, base = serve()
    old = allow_private(True)
    try:
        assert "error" in asyncio.run(run_fetch_url({"url": f"{base}/missing"}))
        refused = asyncio.run(run_fetch_url({"url": f"{base}/bin"}))
        assert "non-text" in refused["error"], refused
    finally:
        restore_private(old)
        server.shutdown()
        server.server_close()


def test_scheme_and_private_hosts_refused_by_default() -> None:
    old = allow_private(False)
    try:
        for url in ["ftp://x/y", "file:///etc/passwd", "not a url",
                    "http://localhost:9/", "http://127.0.0.1:9/",
                    "http://10.0.0.1/", "http://169.254.169.254/"]:
            out = asyncio.run(run_fetch_url({"url": url}))
            assert "error" in out, url
    finally:
        restore_private(old)


def test_policy_declared_and_gated() -> None:
    from friday.tools import registry as registry_mod

    tool = registry_mod.REGISTRY["fetch_url"]
    assert tool.risk == "low" and tool.capabilities == ("web.read",)
    assert tool.timeout_s == 20.0
    ok = policy.evaluate(tool, "fetch_url", {"url": "https://example.com"},
                         PolicyContext())
    assert ok.decision == "allow", ok
    denied = policy.evaluate(tool, "fetch_url", {"url": "https://example.com"},
                             PolicyContext(granted_capabilities=frozenset({"system.read"})))
    assert denied.decision == "deny"
    missing = policy.evaluate(tool, "fetch_url", {}, PolicyContext())
    assert missing.decision == "deny"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
