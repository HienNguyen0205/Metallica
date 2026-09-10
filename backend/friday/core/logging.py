"""Logging setup — extracted so main.py stays bootstrap-only."""

import logging
import os


def configure_logging() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(levelname)s %(name)s: %(message)s",
    )
