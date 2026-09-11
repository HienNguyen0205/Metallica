"""Application bootstrap — wiring only. See friday/api/routes.py for handlers."""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from friday.api.dependencies import CONFIRM_TIMEOUT_S, PENDING
from friday.api.routes import confirm_endpoint, health, query_endpoint, recall_block, router, run_query
from friday.api.schemas import Decision, Query
from friday.core.config import settings
from friday.core.lifecycle import lifespan
from friday.core.logging import configure_logging
from friday.events.serializer import sse
from friday.planner import plan

configure_logging()
log = logging.getLogger("friday")

# Re-export for backwards compatibility (tests import from friday.main)
ALLOWED_ORIGINS = settings.allowed_origins

app = FastAPI(title="FRIDAY Orchestrator", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["POST", "GET"],
    allow_headers=["content-type"],
    # Without this the browser hides Retry-After from the page, and a 429 the
    # UI cannot read the wait from is indistinguishable from a plain refusal.
    expose_headers=["Retry-After"],
)

app.include_router(router)

# Keep legacy symbols importable from friday.main
__all__ = [
    "ALLOWED_ORIGINS",
    "CONFIRM_TIMEOUT_S",
    "Decision",
    "PENDING",
    "Query",
    "app",
    "confirm_endpoint",
    "health",
    "plan",
    "query_endpoint",
    "recall_block",
    "run_query",
    "sse",
]
