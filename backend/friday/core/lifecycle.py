"""Application lifespan — startup diagnostics without secrets."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from friday.llm import base_url, configured, model
from friday.memory import long_term
from friday.tools.integrations.search import configured as search_providers
from .config import settings

log = logging.getLogger("friday")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    log.info("planner configured: %s", configured())
    log.info("model: %s at %s", model(), base_url())
    log.info("allowed origins: %s", settings.allowed_origins)
    # Named and counted, because a mistyped second key is otherwise invisible
    # until the first one runs out — the worst moment to find out.
    keyed = search_providers()
    log.info("search providers: %s", ", ".join([*keyed, "duckduckgo (keyless)"]))
    if not keyed:
        log.warning(
            "no search key set - web search falls to the keyless provider, which "
            "rate-limits quickly and is often blocked outright from a deployed host"
        )
    if not configured():
        log.warning("no provider key set - every query will return an error event")
    if not settings.allowed_origins:
        log.warning("FRIDAY_ALLOWED_ORIGINS is empty - the browser will block every origin")
    elif settings.allowed_origins == ["http://localhost:3000"]:
        log.warning(
            "FRIDAY_ALLOWED_ORIGINS is still the localhost default; "
            "a deployed frontend will be blocked by the browser"
        )

    count = await long_term.load()
    log.info("long-term memory: %d facts", count)
    yield
