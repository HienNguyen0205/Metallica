"""Browser fetch: extraction, caps, and the SSRF guardrails.

Local HTTP fixture only — no external network anywhere in this file.

    PYTHONPATH=. python tests/unit/test_browser.py
"""

import asyncio
import json
import os
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from friday import policy
from friday.policy import PolicyContext
from friday.tools.integrations import fetch as fetch_mod
from friday.tools.integrations import firecrawl
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
    # nothing of the <body> tag itself, and no <head> text either
    assert out["content"] == "Hi readable text here", out
    assert out["truncated"] is False and out["url"].endswith("/page")


def test_body_tag_and_head_stay_out_of_the_extract() -> None:
    raw = b'<HTML><HEAD><TITLE>T</TITLE><script>var x = 1;</script></HEAD><BODY class="a">only this</BODY></HTML>'
    assert fetch_mod._extract(raw) == ("T", "only this")


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
    assert tool.timeout_s == 50.0
    ok = policy.evaluate(tool, "fetch_url", {"url": "https://example.com"},
                         PolicyContext())
    assert ok.decision == "allow", ok
    denied = policy.evaluate(tool, "fetch_url", {"url": "https://example.com"},
                             PolicyContext(granted_capabilities=frozenset({"system.read"})))
    assert denied.decision == "deny"
    missing = policy.evaluate(tool, "fetch_url", {}, PolicyContext())
    assert missing.decision == "deny"


# ---------- Firecrawl fallback ----------
# A public-looking URL so the private-host rule does not skip the fallback; the
# direct read is replaced by a stub, so nothing leaves this machine.

PUBLIC_URL = "https://example.com/app"
scrapes: list[dict] = []
scrape_status = {"code": 200}


class _Firecrawl(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        scrapes.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
        code = scrape_status["code"]
        body = {"success": True, "data": {
            "markdown": "# Rendered\n\nthe text a browser would show",
            "metadata": {"title": ["Rendered app", "dup"], "statusCode": 200},
        }}
        raw = json.dumps(body).encode() if code == 200 else b'{"error":"no"}'
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def with_firecrawl(direct, *, key=True, status=200, url=PUBLIC_URL):
    """Run fetch_url with the direct read stubbed and a fake Firecrawl up."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Firecrawl)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    scrapes.clear()
    scrape_status["code"] = status
    saved = (fetch_mod._fetch, firecrawl.FIRECRAWL_URL, os.environ.get("FIRECRAWL_API_KEY"))
    fetch_mod._fetch = direct
    firecrawl.FIRECRAWL_URL = f"http://127.0.0.1:{server.server_address[1]}/v2"
    if key:
        os.environ["FIRECRAWL_API_KEY"] = "fc-test"
    else:
        os.environ.pop("FIRECRAWL_API_KEY", None)
    try:
        return asyncio.run(run_fetch_url({"url": url}))
    finally:
        fetch_mod._fetch, firecrawl.FIRECRAWL_URL, old_key = saved
        if old_key is None:
            os.environ.pop("FIRECRAWL_API_KEY", None)
        else:
            os.environ["FIRECRAWL_API_KEY"] = old_key
        server.shutdown()
        server.server_close()


def _shell(_url):
    return b"<html><body><div id=root></div>Enable JavaScript.</body></html>", "text/html"


def _status(code):
    def raise_it(url):
        raise urllib.error.HTTPError(url, code, "x", None, None)
    return raise_it


def test_js_shell_is_rendered_by_firecrawl() -> None:
    out = with_firecrawl(_shell)
    assert out["source"] == "firecrawl", out
    assert "the text a browser would show" in out["content"]
    assert out["title"] == "Rendered app", "a repeated <title> comes back as a list"
    assert scrapes[0]["url"] == PUBLIC_URL and scrapes[0]["formats"] == ["markdown"]


def test_bot_wall_falls_back() -> None:
    out = with_firecrawl(_status(403))
    assert out["source"] == "firecrawl", out


def test_gone_page_is_not_scraped() -> None:
    out = with_firecrawl(_status(404))
    assert out == {"error": "fetch returned 404"}, out
    assert scrapes == [], "a renderer cannot bring back a deleted page"


def test_both_failures_are_named() -> None:
    out = with_firecrawl(_status(403), status=402)
    assert out["error"] == "fetch returned 403; firecrawl returned 402", out


def test_thin_page_survives_a_failed_scrape() -> None:
    out = with_firecrawl(_shell, status=500)
    assert out["content"] == "Enable JavaScript.", "a short page beats no page"
    assert "source" not in out


def test_no_key_means_no_fallback() -> None:
    out = with_firecrawl(_status(403), key=False)
    assert out == {"error": "fetch returned 403"}, out
    assert scrapes == []


def test_private_hosts_never_reach_firecrawl() -> None:
    old = allow_private(True)
    try:
        out = with_firecrawl(_status(403), url="http://127.0.0.1:9/x")
    finally:
        restore_private(old)
    assert out == {"error": "fetch returned 403"}, out
    assert scrapes == [], "Firecrawl cannot reach it, and the URL would leave the machine"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("all checks passed")
