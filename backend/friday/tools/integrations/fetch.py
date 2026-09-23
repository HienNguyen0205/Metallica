"""Browser read — fetch one URL and extract its text (P4).

Read-only companion to search_web: search finds pages, this reads the one the
model actually wants. Same trust domain (stranger text into context), so the
same containment: low risk, web.read capability, human-gated only through
consequential tools, never filtered.

Checklist: explicit schema (registry), web.read, low risk, 15s timeout plus
the run wall-time, 3000-char extract cap, audit via tool.executed, allow
policy, eval cases on a local HTTP fixture (no external network), error-dict
failure semantics (DNS, timeout, HTTP status, non-text, oversize).

Firecrawl fallback: when FIRECRAWL_API_KEY is set and the direct read fails —
bot wall (403/429/5xx), timeout, PDF or other non-text, or a page whose text is
a JS-rendered shell — the URL goes to Firecrawl's /scrape, which renders it and
returns main-content markdown. Not for 404/410 (the page is gone, a renderer
cannot bring it back) and never for private hosts (Firecrawl could not reach
them, and the URL would leave this machine for nothing).

SSRF posture is accidental-misuse grade, not adversarial: http(s) only, plus
literal loopback/private/metadata-IP refusal without DNS resolution. A
determined DNS-rebinding attack needs an egress proxy, which is documented
rather than pretended about here.
"""

import asyncio
import html
import ipaddress
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from . import firecrawl

TIMEOUT_S = 15.0

#: Download ceiling: read stops past this, unfinished reads are an error
#: rather than a quarter of a page silently presented as the whole thing.
MAX_DOWNLOAD_BYTES = 1_000_000

#: Extract ceiling: a page is context, and context is budgeted per turn.
MAX_EXTRACT_CHARS = 3000

#: Below this much text a 200 page is most likely a JS-rendered shell ("enable
#: JavaScript to run this app") rather than a short page.
#: ponytail: length heuristic, look for <noscript>/root-div markers if it misfires.
MIN_TEXT_CHARS = 200

#: The page is gone; rendering it will not bring it back.
_FINAL_STATUSES = frozenset({404, 410})

#: Browsers send this; some hosts serve bots a different (worse) page.
AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

_TAGS = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)
#: The whole opening tag, attributes and `>` included, so none of it leaks
#: into the extract.
_BODY = re.compile(r"<body[^>]*>", re.I)

#: Literal refusals without DNS: loopback, private ranges, link-local and the
#: cloud metadata endpoints. Hostnames that *resolve* into these are a proxy's
#: job — documented, not handled.
_BLOCKED_HOSTS = frozenset({"localhost", "0.0.0.0"})


def _blocked_host(host: str) -> bool:
    # Escape hatch for tests and offline dev against a local fixture server
    # (mirrors NEXT_PUBLIC_FORCE_WEBGL): never set this on a deployment.
    if os.getenv("FRIDAY_ALLOW_PRIVATE_FETCH", "") == "1":
        return False
    return _private_host(host)


def _private_host(host: str) -> bool:
    lowered = (host or "").lower().rstrip(".")
    if lowered in _BLOCKED_HOSTS or lowered == "::1":
        return True
    try:
        ip = ipaddress.ip_address(lowered)
    except ValueError:
        pass
    else:
        # is_private alone misses loopback. is_global False covers private,
        # loopback, reserved, multicast and unspecified in one predicate.
        return not ip.is_global
    if lowered.startswith("169.254.") or lowered == "metadata.google.internal":
        return True
    return False


def _extract(raw: bytes) -> tuple[str, str]:
    """(title, text) from an HTML document."""
    try:
        page = raw.decode("utf-8", errors="replace")
    except (ValueError, OverflowError):
        return "", ""
    title_match = _TITLE.search(page)
    title = html.unescape(_TAGS.sub("", title_match.group(1))).strip() if title_match else ""
    body = _BODY.split(page, maxsplit=1)[-1]
    text = _WS.sub(" ", html.unescape(_TAGS.sub(" ", body))).strip()
    return title[:200], text


def _fetch(url: str) -> tuple[bytes, str]:
    """Blocking download: (body, content_type). Raises on any failure."""
    request = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        content_type = response.headers.get_content_type()
        body = response.read(MAX_DOWNLOAD_BYTES + 1)
    return body, content_type


async def _direct(url: str) -> dict[str, Any]:
    """Stdlib read. Failures carry `status` when the server answered."""
    try:
        body, content_type = await asyncio.to_thread(_fetch, url)
    except urllib.error.HTTPError as err:
        return {"error": f"fetch returned {err.code}", "status": err.code}
    except (urllib.error.URLError, TimeoutError):
        return {"error": "fetch unreachable or timed out"}
    except (OSError, ValueError) as err:
        return {"error": f"fetch failed: {type(err).__name__}"}
    if len(body) > MAX_DOWNLOAD_BYTES:
        return {"error": f"page exceeds {MAX_DOWNLOAD_BYTES} bytes"}
    if not content_type.startswith("text/"):
        return {"error": f"refusing non-text content '{content_type}'"}
    title, text = _extract(body)
    if not text:
        return {"error": "no readable text on the page"}
    return {"url": url, "title": title, "text": text}


async def _scrape(url: str) -> dict[str, Any]:
    data = await firecrawl.post(
        "/scrape", {"url": url, "formats": ["markdown"], "onlyMainContent": True}
    )
    if "error" in data:
        return data
    text = str(data.get("markdown") or "").strip()
    if not text:
        return {"error": "firecrawl found no readable text"}
    title = (data.get("metadata") or {}).get("title") or ""
    if isinstance(title, list):  # repeated <title> tags come back as a list
        title = title[0] if title else ""
    return {"url": url, "title": str(title)[:200], "text": text, "source": "firecrawl"}


def _worth_scraping(direct: dict[str, Any], host: str) -> bool:
    if not firecrawl.key() or _private_host(host):
        return False
    if "error" in direct:
        return direct.get("status") not in _FINAL_STATUSES
    return len(direct["text"]) < MIN_TEXT_CHARS


async def run_fetch_url(payload: dict[str, Any]) -> dict[str, Any]:
    """Fetch one http(s) URL and return its title plus a trimmed extract."""
    url = str(payload.get("url", "")).strip()
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return {"error": f"malformed url {url!r}"}
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return {"error": f"only http(s) urls can be fetched: {url!r}"}
    if _blocked_host(parts.hostname):
        return {"error": f"refusing non-public host '{parts.hostname}'"}

    out = await _direct(url)
    if _worth_scraping(out, parts.hostname):
        scraped = await _scrape(url)
        if "error" not in scraped:
            out = scraped
        elif "error" in out:
            out = {"error": f"{out['error']}; {scraped['error']}"}
        # else: keep the thin direct read — a short page beats no page
    if "error" in out:
        return {"error": out["error"]}

    text = out.pop("text")
    return {
        **out,
        "content": text[:MAX_EXTRACT_CHARS],
        "truncated": len(text) > MAX_EXTRACT_CHARS,
    }
