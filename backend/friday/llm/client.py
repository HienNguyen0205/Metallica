"""LLM client — OpenAI-compatible gateway."""

import os

from openai import AsyncOpenAI

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEFAULT_MODEL = "gemini-3.5-flash-lite"
REQUEST_TIMEOUT_S = 60.0


def base_url() -> str:
    return os.getenv("FRIDAY_LLM_BASE_URL", GEMINI_BASE_URL)


def model() -> str:
    return os.getenv("FRIDAY_LLM_MODEL", DEFAULT_MODEL)


def api_key() -> str | None:
    return os.getenv("FRIDAY_LLM_API_KEY") or os.getenv("GEMINI_API_KEY")


def configured() -> bool:
    return bool(api_key())


def client() -> AsyncOpenAI:
    return AsyncOpenAI(
        base_url=base_url(),
        api_key=api_key() or "not-needed",
        timeout=REQUEST_TIMEOUT_S,
    )
