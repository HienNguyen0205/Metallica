"""Browser read — fetch one URL and extract its text (P4).

Read-only companion to search_web: search finds pages, this reads the one the
model actually wants. Same trust domain (stranger text into context), so the
same containment: low risk, web.read capability, human-gated only through
consequential tools, never filtered.

Checklist: explicit schema (registry), web.read, low risk, 15s timeout plus
the run wall-time, 3000-char extract cap, audit via tool.executed, allow
policy, eval cases on a local HTTP fixture (no external network), error-dict
failure semantics (DNS, timeout, HTTP status, non-text, oversize).

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

TIMEOUT_S = 15.0

#: Download ceiling: read stops past this, unfinished reads are an error
#: rather than a quarter of a page silently presented as the whole thing.
MAX_DOWNLOAD_BYTES = 1_000_000

#: Extract ceiling: a page is context, and context is budgeted per turn.
MAX_EXTRACT_CHARS = 3000

#: Browsers send this; some hosts serve bots a different (worse) page.
AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

_TAGS = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)

#: Literal refusals without DNS: loopback, private ranges, link-local and the
#: cloud metadata endpoints. Hostnames that *resolve* into these are a proxy's
#: job — documented, not handled.
_BLOCKED_HOSTS = frozenset({"localhost", "0.0.0.0"})


def _blocked_host(host: str) -> bool:
    # Escape hatch for tests and offline dev against a local fixture server
    # (mirrors NEXT_PUBLIC_FORCE_WEBGL): never set this on a deployment.
    if os.getenv("FRIDAY_ALLOW_PRIVATE_FETCH", "") == "1":
        return False
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
    body = page.split("<body", 1)[-1] if "<body" in page.lower() else page
    text = _WS.sub(" ", html.unescape(_TAGS.sub(" ", body))).strip()
    return title[:200], text


def _fetch(url: str) -> tuple[bytes, str]:
    """Blocking download: (body, content_type). Raises on any failure."""
    request = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        content_type = response.headers.get_content_type()
        body = response.read(MAX_DOWNLOAD_BYTES + 1)
    return body, content_type


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
    try:
        body, content_type = await asyncio.to_thread(_fetch, url)
    except urllib.error.HTTPError as err:
        return {"error": f"fetch returned {err.code}"}
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
    return {
        "url": url,
        "title": title,
        "content": text[:MAX_EXTRACT_CHARS],
        "truncated": len(text) > MAX_EXTRACT_CHARS,
    }
