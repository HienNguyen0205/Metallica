"""Centralised configuration — single source of truth for env vars.

All `os.getenv` access should go through `settings` instead of scattering
across modules. Keeps secrets out of logs and makes provider switching
a config change only.
"""

import os

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEFAULT_MODEL = "gemini-3.5-flash-lite"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---- Provider (§8) — stored defaults, but live env wins ----
    gemini_api_key: str | None = Field(default=None, alias="GEMINI_API_KEY")
    friday_llm_api_key: str | None = Field(default=None, alias="FRIDAY_LLM_API_KEY")
    friday_llm_base_url: str = Field(
        default=GEMINI_BASE_URL,
        alias="FRIDAY_LLM_BASE_URL",
    )
    friday_llm_model: str = Field(default=DEFAULT_MODEL, alias="FRIDAY_LLM_MODEL")

    # ---- Service ----
    friday_allowed_origins: str = Field(
        default="http://localhost:3000",
        alias="FRIDAY_ALLOWED_ORIGINS",
    )
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    confirm_timeout_s: float = Field(default=120.0, alias="FRIDAY_CONFIRM_TIMEOUT_S")
    events_v2: bool = Field(default=False, alias="FRIDAY_EVENTS_V2")  # envelope+step events (P0.2)
    # ---- P1.9 durable state ----
    state_backend: str = Field(default="memory", alias="FRIDAY_STATE_BACKEND")
    redis_url: str = Field(default="redis://localhost:6379/0", alias="FRIDAY_REDIS_URL")
    # ---- P1.8 capability grants ----
    granted_capabilities: str = Field(default="*", alias="FRIDAY_GRANTED_CAPABILITIES")
    # ---- P3 identity ----
    trust_identity_headers: bool = Field(default=False, alias="FRIDAY_TRUST_IDENTITY_HEADERS")
    identity_header: str = Field(default="X-User-Id", alias="FRIDAY_IDENTITY_HEADER")

    # ---- §22 abuse limits — see api/dependencies.py ----
    # Sized against the provider's free tier, not against demand: one query is
    # 2-3 model calls, so 100/hour globally is already the whole daily quota if
    # sustained. Raise them once the key has a budget behind it.
    friday_rate_limit_per_hour: int = Field(default=30, alias="FRIDAY_RATE_LIMIT_PER_HOUR")
    friday_global_limit_per_hour: int = Field(default=100, alias="FRIDAY_GLOBAL_LIMIT_PER_HOUR")

    # ---- Derived helpers — read live env so tests that mutate os.environ work ----
    @property
    def llm_api_key(self) -> str | None:
        return os.getenv("FRIDAY_LLM_API_KEY") or os.getenv("GEMINI_API_KEY") or self.friday_llm_api_key or self.gemini_api_key

    @property
    def llm_base_url(self) -> str:
        return os.getenv("FRIDAY_LLM_BASE_URL") or self.friday_llm_base_url

    @property
    def llm_model(self) -> str:
        return os.getenv("FRIDAY_LLM_MODEL") or self.friday_llm_model

    @property
    def allowed_origins(self) -> list[str]:
        raw = os.getenv("FRIDAY_ALLOWED_ORIGINS", self.friday_allowed_origins)
        # An Origin header never carries a trailing slash, so a value pasted in
        # as "https://app.example/" would match nothing — here or in the CORS
        # middleware, which reads this same list.
        return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]

    @property
    def gemini_api_key_live(self) -> str | None:
        return os.getenv("GEMINI_API_KEY") or self.gemini_api_key

    @property
    def is_configured(self) -> bool:
        return bool(self.llm_api_key)

    # Backwards compat aliases requested in the guide
    @property
    def gemini_api_key_alias(self) -> str | None:
        return self.llm_api_key

    @property
    def confirm_timeout_s_live(self) -> float:
        raw = os.getenv("FRIDAY_CONFIRM_TIMEOUT_S")
        if raw is not None:
            try:
                return float(raw)
            except ValueError:
                pass
        return self.confirm_timeout_s

    @property
    def rate_limit_per_hour(self) -> int:
        return _int_env("FRIDAY_RATE_LIMIT_PER_HOUR", self.friday_rate_limit_per_hour)

    @property
    def global_limit_per_hour(self) -> int:
        return _int_env("FRIDAY_GLOBAL_LIMIT_PER_HOUR", self.friday_global_limit_per_hour)


def _int_env(name: str, fallback: int) -> int:
    raw = os.getenv(name)
    if raw is not None:
        try:
            return int(raw)
        except ValueError:
            pass
    return fallback


settings = Settings()  # type: ignore[call-arg]
