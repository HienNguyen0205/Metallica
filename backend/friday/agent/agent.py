"""§9 agent loop — plan, call tools, gather results."""

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any

from friday import llm
from friday import observability
from friday import policy
from friday import verify
from friday import evidence as evidence_mod
from friday.memory import long_term
from friday.tools.registry import REGISTRY, api_tools

from .state import AgentEvent, AgentResult

log = logging.getLogger("friday.agent")

MAX_TURNS = 6

SYSTEM = """You are FRIDAY, an AI operations interface.

Use your tools to answer from real data rather than estimating. \
`get_system_metrics` reads the machine this orchestrator runs on — call it \
whenever the question touches system load, CPU, memory or disk. Do not answer \
those questions from memory or guesswork; you have no numbers until a tool \
gives you some.

`search_web` reaches the public internet, so it can only answer what the public \
internet knows. The public internet knows nothing whatsoever about this machine \
— not its topology, its services, its history, its configuration, nor anything \
else about it, no matter how the question is phrased. Never search for anything \
about this host: either a tool here measures it, or you say you cannot see it. \
Do not search for facts that do not change either.

If a tool is denied by the operator, say so plainly; do not retry it and do not \
substitute invented figures for the data you were refused.

When you have what you need, answer in one or two calm, factual sentences."""

Approver = Callable[[str, str, dict[str, Any]], Awaitable[bool]]


def _echo(call: Any) -> dict[str, Any]:
    return {key: value for key, value in call.model_dump().items() if value is not None}


def _arguments(call: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(call.function.arguments or "{}")
    except json.JSONDecodeError:
        log.warning("unparseable arguments for %s", call.function.name)
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _tool_summary(output: dict[str, Any]) -> str:
    return ", ".join(f"{k}={str(v)[:40]}" for k, v in list(output.items())[:3])


async def run(
    query: str,
    approve: Approver,
    result: AgentResult,
    history: Sequence[dict[str, str]] = (),
    memories: str = "",
    emit_steps: bool = False,
) -> AsyncIterator[AgentEvent]:
    api = llm.client()
    # Provenance của ký ức đọc từ đây. Set mới mỗi turn để hai query song song
    # không thấy tool của nhau.
    long_term.TURN_TOOLS.set(set())
    # Ký ức đi kèm system prompt chứ không phải như một lượt hội thoại: nó là
    # thứ FRIDAY biết, không phải thứ ai đó đã nói.
    system = f"{SYSTEM}\n\n{memories}" if memories else SYSTEM
    # §15 — prior exchanges sit between the system prompt and the new question,
    # which is what lets "and the disk?" resolve to anything.
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        *history,
        {"role": "user", "content": query},
    ]

    step_n = 0
    tool_attempts: dict[str, int] = {}
    collected: list[evidence_mod.Evidence] = []
    replans_used = 0

    def _close_answer(text: str, status: str = "unverified") -> None:
        """Final text plus the claim citing everything collected (P2)."""
        result.text = text
        claim = evidence_mod.build_answer_claim(text, collected).to_dict()
        claim["status"] = status
        result.claims.append(claim)

    def _next_step_id() -> str:
        nonlocal step_n
        step_n += 1
        return f"s{step_n}"

    def step(step_id: str, kind: str, status: str, turn: int, *, tool: str | None = None,
             summary: str | None = None, retry: int | None = None,
             error: str | None = None) -> AgentEvent:
        payload: dict[str, Any] = {
            "step_id": step_id, "turn_id": f"turn_{turn}", "kind": kind, "status": status,
        }
        if tool:
            payload["tool"] = tool
        if summary:
            payload["summary"] = summary[:120]
        if retry:
            payload["retry_count"] = retry
        if error:
            payload["error"] = error
        return AgentEvent("step", payload)

    for turn in range(1, MAX_TURNS + 1):
        if emit_steps:
            reason_id = _next_step_id()
            yield step(reason_id, "reason", "running", turn)
        llm_start = time.perf_counter()
        try:
            response = await api.chat.completions.create(
                model=llm.model(),
                messages=messages,  # type: ignore[arg-type]
                tools=api_tools(),  # type: ignore[arg-type]
            )
        except Exception:
            observability.incr("llm_calls_total", 1, {"model": llm.model(), "status": "error"})
            raise
        observability.record_llm_usage(
            response, llm.model(), (time.perf_counter() - llm_start) * 1000)
        message = response.choices[0].message
        calls = message.tool_calls or []

        if not calls:
            # §2 — the reason step closes with "final answer"; the final text
            # set then closes the run as the answer step.
            text = (message.content or "").strip()
            verdict = verify.verify_answer(text, collected)
            if not verdict.ok:
                observability.incr("verification_failures_total")
            if verdict.ok or replans_used >= verify.MAX_REPLANS or not verdict.retryable:
                if emit_steps:
                    yield step(reason_id, "reason", "completed", turn, summary="final answer")
                    yield step(_next_step_id(), "answer", "completed", turn)
                _close_answer(text, status="supported" if verdict.ok else "unverified")
                return
            # Bounded replan: one more pass with the verifier's hint instead of
            # accepting a structurally broken answer. Turn budget still caps us.
            replans_used += 1
            observability.incr("replan_total")
            log.info("verification failed (%s); replanning", ",".join(verdict.issues))
            if emit_steps:
                yield step(_next_step_id(), "verification", "failed", turn,
                           summary="; ".join(verdict.issues), error=verdict.hint)
            messages.append({
                "role": "user",
                "content": f"Verification flagged this turn ({'; '.join(verdict.issues)}): {verdict.hint}",
            })
            continue
        if emit_steps:
            yield step(reason_id, "reason", "completed", turn, summary=f"{len(calls)} tool call(s)")

        messages.append(
            {
                "role": "assistant",
                "content": message.content,
                "tool_calls": [_echo(c) for c in calls],
            }
        )

        for call in calls:
            name = call.function.name
            tool = REGISTRY.get(name)
            if tool is None:
                messages.append(
                    {"role": "tool", "tool_call_id": call.id,
                     "content": json.dumps({"error": "unknown tool"})}
                )
                continue

            payload = _arguments(call)

            if emit_steps:
                attempts = tool_attempts.get(name, 0)
                tool_attempts[name] = attempts + 1
                tool_id = _next_step_id()
                yield step(tool_id, "tool", "running", turn, tool=name, retry=attempts or None)

            # P1.7/P1.8 — every call passes the policy gate first. Denials never
            # reach the human; ask_human and step_up share the confirm flow
            # (separated for audit, same UX until the frontend distinguishes).
            decision = policy.evaluate(tool, name, payload, policy.default_context())
            if decision.decision == "deny":
                log.info("policy denied %s: %s", name, decision.reason)
                if emit_steps:
                    yield step(tool_id, "tool", "failed", turn, tool=name,
                               retry=attempts or None,
                               error=f"denied by policy: {decision.reason}")
                yield AgentEvent("denied", {"tool": tool.name})
                messages.append(
                    {"role": "tool", "tool_call_id": call.id,
                     "content": json.dumps({"error": f"denied by policy: {decision.reason}"})}
                )
                continue
            if decision.decision in ("ask_human", "step_up"):
                if decision.decision == "step_up":
                    log.info("policy step_up %s: %s", name, decision.reason)
                if emit_steps:
                    yield step(tool_id, "tool", "waiting_approval", turn, tool=name, retry=attempts or None)
                approved = await approve(tool.name, tool.risk, payload)
                if not approved:
                    if emit_steps:
                        yield step(tool_id, "tool", "failed", turn, tool=name,
                                   retry=attempts or None, error="denied by operator")
                    yield AgentEvent("denied", {"tool": tool.name})
                    messages.append(
                        {"role": "tool", "tool_call_id": call.id,
                         "content": json.dumps({"error": "denied by operator"})}
                    )
                    continue
                if emit_steps:
                    yield step(tool_id, "tool", "running", turn, tool=name, retry=attempts or None)

            yield AgentEvent("state", {"state": "tool_execution"})
            yield AgentEvent("tool", {"tool": tool.name, "risk": tool.risk})
            tool_start = time.perf_counter()
            try:
                if tool.timeout_s:
                    output = await asyncio.wait_for(tool.run(payload), tool.timeout_s)
                else:
                    output = await tool.run(payload)
                if tool.max_output_bytes:
                    blob = json.dumps(output)
                    if len(blob.encode()) > tool.max_output_bytes:
                        output = {"truncated": True,
                                  "preview": blob[:tool.max_output_bytes]}
            except Exception as err:
                observability.incr("tool_calls_total", 1, {"tool": tool.name, "status": "error"})
                observability.observe("tool_latency_ms",
                                      (time.perf_counter() - tool_start) * 1000,
                                      {"tool": tool.name})
                log.exception("tool %s failed", tool.name)
                output = {"error": type(err).__name__}
                if emit_steps:
                    yield step(tool_id, "tool", "failed", turn, tool=name,
                               retry=attempts or None, error=type(err).__name__)
            else:
                observability.incr("tool_calls_total", 1, {"tool": tool.name, "status": "ok"})
                observability.observe("tool_latency_ms",
                                      (time.perf_counter() - tool_start) * 1000,
                                      {"tool": tool.name})
                if emit_steps:
                    yield step(tool_id, "tool", "completed", turn, tool=name,
                               retry=attempts or None, summary=_tool_summary(output))

            result.evidence.append({"tool": tool.name, "output": output})
            collected.append(evidence_mod.collect_tool_evidence(tool.name, output, len(collected) + 1))
            evid = collected[-1]
            result.evidence[-1].update({
                "evidence_id": evid.evidence_id,
                "confidence": evid.confidence,
                "provenance": evid.provenance,
            })

            long_term.mark_tool_used(tool.name)

            if tool.name == "remember":
                event = _memory_event(output)
                if event is not None:
                    yield event

            if tool.preview and "error" not in output:
                try:
                    yield AgentEvent("preview", tool.preview(output))
                except Exception:
                    log.exception("preview for %s failed", tool.name)

            messages.append(
                {"role": "tool", "tool_call_id": call.id, "content": json.dumps(output)}
            )

        yield AgentEvent("state", {"state": "processing"})

    log.warning("hit MAX_TURNS without a final answer")
    _close_answer("I wasn't able to finish that within the step budget.")


def _memory_event(output: dict) -> AgentEvent | None:
    """Một kết quả `remember` thành một AgentEvent, hoặc None nếu tool đó lỗi."""
    if "remembered" not in output:
        return None
    return AgentEvent(
        "memory",
        {"id": output["id"], "fact": output["remembered"], "provenance": output["provenance"]},
    )
