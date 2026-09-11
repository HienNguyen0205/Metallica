"""Observability (P3): correlation IDs, counters and latency histograms.

Dependency-free and import-cycle-free (nothing here imports friday), so any
module can record without ceremony. All state is process-local — the service
is single-process by design, and a second worker would need a shared metrics
sink, which is a multi-worker problem, not this file.

Privacy rule: label values are component names, statuses and model names.
Never query text, session ids, tool arguments, facts or answers.
"""

import json
import os
import threading
import time
from contextvars import ContextVar
from typing import Any

#: Per-HTTP-request id (set by the query endpoint, returned as a header).
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
#: Per-run trace id (one trace per run; spans share it via the run record).
trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)

_lock = threading.Lock()
_counters: dict[str, float] = {}
_latencies: dict[str, list[float]] = {}

#: Cap on retained latency samples per series: enough for avg/min/max, small
#: enough to never matter. Oldest samples fall off first.
MAX_SAMPLES = 1024

_STARTED_AT = time.time()


def _key(name: str, labels: dict[str, str] | None) -> str:
    if not labels:
        return name
    suffix = ",".join(f"{k}={labels[k]}" for k in sorted(labels))
    return f"{name}{{{suffix}}}"


def incr(name: str, amount: float = 1, labels: dict[str, str] | None = None) -> None:
    """Count occurrences (or accumulate gauges like cost estimates)."""
    with _lock:
        key = _key(name, labels)
        _counters[key] = _counters.get(key, 0) + amount


def observe(name: str, value_ms: float, labels: dict[str, str] | None = None) -> None:
    """Record a latency sample: tool_latency_ms, llm_latency_ms, ..."""
    with _lock:
        samples = _latencies.setdefault(_key(name, labels), [])
        samples.append(value_ms)
        del samples[: max(0, len(samples) - MAX_SAMPLES)]


def snapshot() -> dict[str, Any]:
    """Everything /metrics serves: counters plus latency summaries."""
    with _lock:
        counters = dict(_counters)
        latencies = {}
        for name, samples in _latencies.items():
            latencies[name] = {
                "count": len(samples),
                "avg_ms": round(sum(samples) / len(samples), 2) if samples else 0.0,
                "min_ms": round(min(samples), 2) if samples else 0.0,
                "max_ms": round(max(samples), 2) if samples else 0.0,
            }
    return {
        "service": "friday-orchestrator",
        "uptime_s": round(time.time() - _STARTED_AT, 1),
        "counters": counters,
        "latency_ms": latencies,
    }


def reset() -> None:
    """Tests only: clear all series."""
    with _lock:
        _counters.clear()
        _latencies.clear()


def _model_prices() -> dict[str, list[float]]:
    """Optional per-1M-token [input, output] USD prices. Empty by default:
    unknown models record 0.0 cost rather than a guessed number."""
    raw = os.getenv("FRIDAY_MODEL_PRICES_JSON", "")
    try:
        data = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    prices = _model_prices().get(model)
    if not prices or len(prices) != 2:
        return 0.0
    return round((prompt_tokens * prices[0] + completion_tokens * prices[1]) / 1_000_000, 6)


def record_llm_usage(response: Any, model: str, latency_ms: float,
                      status: str = "ok") -> tuple[int, int]:
    """Meter one model call from its response.usage (missing = zeros, never a
    crash — fake providers and some shims omit it). Returns (prompt, completion)."""
    usage = getattr(response, "usage", None)
    prompt = int(getattr(usage, "prompt_tokens", 0) or 0)
    completion = int(getattr(usage, "completion_tokens", 0) or 0)
    incr("llm_calls_total", 1, {"model": model, "status": status})
    observe("llm_latency_ms", latency_ms, {"model": model})
    if prompt or completion:
        incr("llm_tokens_total", float(prompt + completion), {"model": model})
        cost = estimate_cost_usd(model, prompt, completion)
        if cost:
            incr("llm_cost_estimate_usd", cost, {"model": model})
    return prompt, completion
