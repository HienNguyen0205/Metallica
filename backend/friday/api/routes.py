"""API routes — extracted from main.py."""

import asyncio
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from openai import APIError, NotFoundError, RateLimitError

from friday import agent, llm, memory, observability
from friday.api import dependencies as deps
from friday.api.dependencies import PENDING, guard, require_known_origin
from friday.api.schemas import Decision, Query, RunBudget
from friday.core.config import settings
from friday.events.serializer import sse, sse_envelope
from friday.memory import consolidate
from friday.memory import embed as embed_mod
from friday.memory import long_term
from friday.memory import store as memory_store
from friday.memory.store import StoreError

# Keep CONFIRM_TIMEOUT_S readable for old imports, but resolve dynamically
CONFIRM_TIMEOUT_S = deps.CONFIRM_TIMEOUT_S


def _get_confirm_timeout() -> float:
    # Tests monkey-patch friday.main.CONFIRM_TIMEOUT_S; respect that live value.
    try:
        import friday.main as main_mod

        val = getattr(main_mod, "CONFIRM_TIMEOUT_S", None)
        if isinstance(val, (int, float)):
            return float(val)
    except ImportError:
        pass
    return float(deps.CONFIRM_TIMEOUT_S)


async def _get_plan():
    # Tests monkey-patch friday.main.plan; respect that if set.
    try:
        import friday.main as main_mod

        maybe = getattr(main_mod, "plan", None)
        # If main.plan was overridden to a fake, use it (check if it's not the original import)
        if maybe is not None:
            import friday.planner as planner_mod

            if maybe is not planner_mod.plan:
                return maybe
    except ImportError:
        pass
    from friday.planner import plan as real_plan

    return real_plan

log = logging.getLogger("friday")

router = APIRouter()

#: Strong references for fire-and-forget background tasks (consolidation).
#: asyncio only holds a *weak* ref to a task, so one nothing else points to
#: can be GC'd before it ever runs — dropped silently, since `consolidate.run`
#: swallows its own exceptions. Each task removes itself on completion, so
#: this stays bounded.
_BACKGROUND_TASKS: set[asyncio.Task] = set()

#: Live streaming tasks by run_id. `POST /runs/{id}/cancel` cancels the task;
#: the run_query handler below translates that into a terminal `cancelled`
#: state. Entries are removed in run_query's finally — a present-but-done
#: entry simply means the run already ended (cancel is idempotent).
_RUN_TASKS: dict[str, asyncio.Task] = {}


def quota_detail(err: Exception) -> str:
    """Which limit the provider refused on, and when it clears.

    This used to read "the API key is over quota" for every 429, which was
    wrong in the common case and expensively so: the free tier's binding limit
    is requests *per minute*, and one query spends two or three of them, so a
    normal run trips it at around the sixth question. Someone reading "over
    quota" goes looking at billing for a wall that clears in twelve seconds.

    Every field is optional. Only Gemini's OpenAI shim is known to send this
    shape, and it wraps the object in a list; anything else falls through to
    the bare message rather than guessing.
    """
    body = getattr(err, "body", None)
    if isinstance(body, list):
        body = body[0] if body else None
    if not isinstance(body, dict):
        return ""

    quota_id = ""
    retry = ""
    for entry in (body.get("error") or {}).get("details") or []:
        if not isinstance(entry, dict):
            continue
        for violation in entry.get("violations") or []:
            quota_id = violation.get("quotaId") or quota_id
        retry = entry.get("retryDelay") or retry

    if "PerMinute" in quota_id:
        window = " - requests-per-minute limit, not the daily quota"
    elif "PerDay" in quota_id:
        window = " - the daily quota for this model is spent"
    else:
        window = ""

    return f"{window}{f'; retry in {retry}' if retry else ''}"


async def recall_block(query: str) -> str:
    """Ký ức liên quan tới câu hỏi này, đã đóng gói cho prompt.

    Chuỗi rỗng là câu trả lời hợp lệ và là mặc định khi có bất cứ gì hỏng: không
    có ký ức, không cấu hình store, embedding chết. Ký ức là phần thêm — không
    lý do gì để một câu hỏi thất bại vì FRIDAY không nhớ ra.
    """
    if not long_term.CACHE:
        return ""
    try:
        mem_start = time.perf_counter()
        vectors = await embed_mod.embed([query])
        observability.observe("memory_latency_ms",
                              (time.perf_counter() - mem_start) * 1000,
                              {"op": "recall_embed"})
        hits = long_term.top_k(vectors[0], long_term.TOP_K_DEFAULT)
        if hits:
            asyncio.get_running_loop().run_in_executor(None, _touch, [m.id for m in hits])
        return long_term.render_block(hits)
    except Exception:
        # Bắt rộng có chủ ý: "memory là phần thêm, không bao giờ là điều kiện"
        # phải đúng theo cấu trúc, không phải vì hôm nay tình cờ mọi callee chỉ
        # ném EmbedError. Vector lệch chiều, cache hỏng, top_k đổi ngày mai —
        # không cái nào được phép giết một turn.
        log.warning("recall skipped", exc_info=True)
        return ""


def _touch(ids: list[int]) -> None:
    from friday.memory.store import touch

    touch(ids)


async def _run_query_events(
    query: str, session_id: str | None = None, run=None
) -> AsyncIterator[tuple[str, dict]]:
    """Domain events of one turn, as (event, payload) tuples.

    P0.2 — the V2 dispatcher below wraps these in the envelope and mirrors
    steps into the registry; V2-off re-serializes them flat, byte-identical.
    """
    from friday.runs import REGISTRY

    yield ("state", {"state": "thinking"})

    outcome = agent.AgentResult(text="")
    events: asyncio.Queue[agent.AgentEvent | None] = asyncio.Queue()

    async def approve(tool: str, risk: str, payload: dict[str, Any]) -> bool:
        request_id = uuid.uuid4().hex
        decided: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        PENDING[request_id] = decided
        if run:
            REGISTRY.update_status(run.run_id, "waiting_approval")
        await events.put(
            agent.AgentEvent("confirm", {"id": request_id, "tool": tool, "risk": risk, "input": payload})
        )
        try:
            wait_start = time.perf_counter()
            try:
                approved = await asyncio.wait_for(decided, _get_confirm_timeout())
            finally:
                observability.observe(
                    "approval_wait_ms", (time.perf_counter() - wait_start) * 1000)
            return approved
        except (asyncio.TimeoutError, asyncio.CancelledError):
            log.info("approval for %s timed out", tool)
            return False
        finally:
            PENDING.pop(request_id, None)
            if run:
                REGISTRY.update_status(run.run_id, "running")

    failure: BaseException | None = None
    memories = ""

    async def pump() -> None:
        nonlocal failure
        try:
            # Only a V2 run (registry-created) asks the agent for step events;
            # passing the kwarg unconditionally would break plain generators.
            kwargs = {"emit_steps": True} if run is not None else {}
            async for event in agent.run(query, approve, outcome, memory.history(session_id), memories, **kwargs):
                await events.put(event)
        except BaseException as err:
            failure = err
        finally:
            await events.put(None)

    task: asyncio.Task | None = None
    stage = "agent"
    # §18 — the component the last preview already materialised. The planner is
    # pinned to it rather than allowed to re-decide: a preview is derived from
    # the tool's own output shape without a model call, so it is both right and
    # the same every run, while the planner re-reads the same JSON and reaches a
    # different conclusion often enough to be visible — the user watches bars
    # build and then get replaced by gauges for no reason they can see.
    pinned_type: str | None = None
    try:
        # Trong try: `state: thinking` đã gửi đi rồi, nên bất cứ gì ném ra
        # ngoài đây sẽ kết thúc stream không `error`, không `done`, và HUD kẹt.
        memories = await recall_block(query)
        task = asyncio.create_task(pump())
        while True:
            event = await events.get()
            if event is None:
                break

            if event.kind == "preview":
                pinned_type = event.payload.get("type") or pinned_type
                yield ("viz", {"animation": "materialize", "interaction": "none", **event.payload})
                continue

            yield (event.kind, event.payload)

        if failure is not None:
            raise failure

        stage = "planner"
        plan_fn = await _get_plan()
        result = await plan_fn(query, outcome.text, outcome.evidence, pinned_type)
    except NotFoundError:
        log.exception("model %r not available at %s", llm.model(), llm.base_url())
        yield ("error", {"message": f"model '{llm.model()}' unavailable at this endpoint"})
        yield ("state", {"state": "error"})
        yield ("done", {})
        return
    except RateLimitError as err:
        log.exception("provider rate limit hit for model %r", llm.model())
        yield (
            "error",
            {"message": f"provider rate limit reached ({stage}){quota_detail(err)}"},
        )
        yield ("state", {"state": "error"})
        yield ("done", {})
        return
    except APIError as err:
        log.exception("model call failed")
        yield ("error", {"message": f"{stage} error: {type(err).__name__}"})
        yield ("state", {"state": "error"})
        yield ("done", {})
        return
    except Exception:
        log.exception("query failed in %s stage", stage)
        yield ("error", {"message": f"{stage} unavailable"})
        yield ("state", {"state": "error"})
        yield ("done", {})
        return
    finally:
        if task is not None and not task.done():
            task.cancel()

    yield ("state", {"state": "visualizing"})
    yield ("viz", result.model_dump(exclude={"answer"}, exclude_none=True))
    yield ("state", {"state": "speaking"})
    answer = outcome.text or result.answer
    # Recorded only once the turn has actually produced an answer — a failed
    # turn returns above, so a provider outage cannot poison the session with
    # an exchange that never happened.
    memory.remember(session_id, query, answer)
    yield ("answer", {"text": answer})
    if run is not None:
        # P2 — mirror the turn's evidence and answer claims into the run for
        # durable reads (reconnect) and verification. V2 only: run is None on
        # the flat path.
        from friday.runs import REGISTRY as _REGISTRY

        for entry in outcome.evidence:
            _REGISTRY.record_evidence(run.run_id, entry)
        for claim in outcome.claims:
            _REGISTRY.record_claim(run.run_id, claim)
    yield ("done", {})
    # Sau `done`, không chờ: nó tốn một model call và người dùng không có lý do
    # gì phải đợi FRIDAY dọn dẹp.
    consolidate.note_turn()
    if consolidate.should_run():
        bg_task = asyncio.create_task(consolidate.run())
        _BACKGROUND_TASKS.add(bg_task)
        bg_task.add_done_callback(_BACKGROUND_TASKS.discard)


async def run_query(
    query: str, session_id: str | None = None, budget: RunBudget | None = None,
    request_id: str | None = None,
) -> AsyncIterator[str]:
    if not settings.events_v2:
        # P0.3 legacy flat path — removal plan: keep until FRIDAY_EVENTS_V2
        # becomes the default and one release of enveloped traffic has baked
        # without fallback, then delete this branch and the flag. FE already
        # tolerates both shapes (unwrapEnvelope), so removal is BE-only.
        async for event, payload in _run_query_events(query, session_id):
            yield sse(event, payload)
        return
    from friday.runs import REGISTRY

    run = REGISTRY.create(session_id, query)
    REGISTRY.begin(run.run_id)
    trace_id = uuid.uuid4().hex
    observability.request_id_var.set(request_id)
    observability.trace_id_var.set(trace_id)
    REGISTRY.set_metadata(run.run_id, {"request_id": request_id, "trace_id": trace_id})
    if budget is not None and budget.max_wall_time_ms:
        run.deadline = (run.started_at or time.time()) + budget.max_wall_time_ms / 1000
    max_tools = budget.max_tool_calls if budget is not None else None
    tool_count = 0
    sequence = 0
    turn = "turn_1"
    saw_error = False
    current = asyncio.current_task()
    if current is not None:
        _RUN_TASKS[run.run_id] = current
    agen = _run_query_events(query, session_id, run=run)

    async def budget_exceeded(reason: str) -> AsyncIterator[str]:
        """Structured terminal frames for an exhausted budget (P1.6): an
        `error` with code budget_exceeded, never an ambiguous exception."""
        nonlocal sequence
        REGISTRY.set_final(run.run_id, error=reason)
        for event, payload in (("error", {"code": "budget_exceeded", "message": reason}),
                               ("state", {"state": "error"}),
                               ("done", {})):
            sequence += 1
            REGISTRY.record_event(run.run_id, sequence, event, payload)
            yield sse_envelope(run.run_id, session_id, turn, sequence, event, payload)
        REGISTRY.finish(run.run_id, "failed")

    try:
        while True:
            # P1.6 — the deadline also bounds silence: wait_for on the next
            # event (not just a check per received event) so a hung tool or
            # model call trips the budget instead of stalling past it.
            if run.deadline is not None:
                remaining = run.deadline - time.time()
                if remaining <= 0:
                    async for chunk in budget_exceeded(
                        f"budget exceeded: wall time past {budget.max_wall_time_ms}ms"
                    ):
                        yield chunk
                    return
                try:
                    event, payload = await asyncio.wait_for(agen.__anext__(), remaining)
                except StopAsyncIteration:
                    break
                except asyncio.TimeoutError:
                    async for chunk in budget_exceeded(
                        f"budget exceeded: wall time past {budget.max_wall_time_ms}ms"
                    ):
                        yield chunk
                    return
            else:
                try:
                    event, payload = await agen.__anext__()
                except StopAsyncIteration:
                    break
            if event == "step":
                turn = str(payload.get("turn_id") or turn)
                REGISTRY.set_turn(run.run_id, turn)
                REGISTRY.record_step(run.run_id, payload)
                if payload.get("kind") == "tool" and payload.get("status") == "running":
                    tool_count += 1
                    if max_tools is not None and tool_count > max_tools:
                        async for chunk in budget_exceeded(
                            f"budget exceeded: {tool_count} tool calls (max {max_tools})"
                        ):
                            yield chunk
                        return
            if event == "answer":
                REGISTRY.set_final(run.run_id, answer=str(payload.get("text", "")))
            if event == "error":
                # §2 accuracy — an error frame is a failed turn, not a completed
                # one; P0.9 reads final_status from here.
                saw_error = True
                REGISTRY.set_final(run.run_id, error=str(payload.get("message", "")))
            sequence += 1
            REGISTRY.record_event(run.run_id, sequence, event, payload)
            yield sse_envelope(run.run_id, session_id, turn, sequence, event, payload)
        REGISTRY.finish(run.run_id, "failed" if saw_error else "completed")
        observability.incr("agent_runs_total", 1,
                           {"status": "failed" if saw_error else "completed"})
        if saw_error:
            observability.incr("agent_failures_total")
    except asyncio.CancelledError:
        # Client went away mid-turn — a cancellation, not a model failure.
        observability.incr("sse_disconnect_total")
        REGISTRY.finish(run.run_id, "cancelled")
        raise
    except BaseException:
        observability.incr("agent_runs_total", 1, {"status": "failed"})
        observability.incr("agent_failures_total")
        REGISTRY.finish(run.run_id, "failed")
        raise
    finally:
        _RUN_TASKS.pop(run.run_id, None)
        await agen.aclose()


@router.post("/runs/{run_id}/cancel", dependencies=[Depends(guard)])
async def cancel_run(run_id: str) -> dict[str, Any]:
    """P1.5 — cancel a live run. Idempotent: cancelling a finished run
    reports its terminal status; unknown runs are a 404. The streaming task
    gets CancelledError, which run_query translates into `cancelled` exactly
    once; a pending approval wait dies with it (PENDING is popped, never
    resolved as approved)."""
    from friday.runs import REGISTRY

    run = REGISTRY.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="no such run")
    if REGISTRY.update_status(run_id, "cancelled"):
        task = _RUN_TASKS.get(run_id)
        if task is not None and not task.done():
            task.cancel()
        return {"ok": True, "run_id": run_id, "status": "cancelled", "cancelled": True}
    return {"ok": True, "run_id": run_id, "status": run.status, "cancelled": False}


@router.get("/runs/{run_id}/events", dependencies=[Depends(guard)])
async def replay_run(run_id: str, after_sequence: int = 0) -> dict[str, Any]:
    """P1.10 — reconnect/resume. Returns enveloped frames already emitted for
    this run with sequence > after_sequence, plus the run status and whether
    it is terminal. Pure log read: replay never re-executes tools, the agent,
    or the planner. Unknown runs are a 404 (stale runs get a clear status,
    never an empty stream)."""
    from friday.runs import REGISTRY, _TERMINAL

    run = REGISTRY.get(run_id)
    if run is None:
        stored = REGISTRY.get_stored(run_id)
        if stored is None:
            raise HTTPException(status_code=404, detail="no such run")
        run = stored
    observability.incr("sse_reconnect_total")
    after = max(0, after_sequence)
    events = [e for e in run.events if e.get("sequence", 0) > after]
    return {
        "run_id": run_id,
        "status": run.status,
        "terminal": run.status in _TERMINAL,
        "events": events,
    }


@router.post("/query", dependencies=[Depends(guard)])
async def query_endpoint(body: Query) -> StreamingResponse:
    request_id = uuid.uuid4().hex
    return StreamingResponse(
        run_query(body.query, body.session_id, body.budget, request_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "X-Request-ID": request_id},
    )


@router.post("/confirm", dependencies=[Depends(guard)])
async def confirm_endpoint(body: Decision) -> dict[str, Any]:
    decided = PENDING.get(body.id)
    if decided is None or decided.done():
        raise HTTPException(status_code=404, detail="no pending decision with that id")
    decided.set_result(body.approved)
    return {"ok": True, "approved": body.approved}


@router.get("/memory", dependencies=[Depends(guard)])
async def list_memory() -> dict[str, Any]:
    """Mọi thứ FRIDAY nhớ. Không tính vào rate limit — không có model call nào.

    Đọc thẳng từ store chứ không từ cache. Đây là màn hình xem lại, không phải
    đường nóng, và toàn bộ giá trị của nó là cho thấy cái gì thật sự còn nằm
    đó: sau một lần khởi động lỗi, cache rỗng trong khi store đầy, và một danh
    sách trống là câu trả lời sai nhất có thể cho "trang web kia đã ghi gì".
    Store chết thì lùi về cache — và nói ra bằng `from_cache`.

    Vector không nằm trong response: 768 số float không nói gì với người đọc và
    làm payload phình lên vô ích.
    """
    try:
        rows = await asyncio.to_thread(memory_store.select_all)
    except StoreError:
        log.warning("memory listing fell back to the cache", exc_info=True)
        return {
            "memories": [
                {
                    "id": m.id,
                    "fact": m.fact,
                    "provenance": m.provenance,
                    "created_at": m.created_at,
                    "last_used_at": m.last_used_at,
                }
                for m in long_term.CACHE
            ],
            "from_cache": True,
        }
    return {
        "memories": [
            {key: row.get(key) for key in ("id", "fact", "provenance", "created_at", "last_used_at")}
            for row in rows
        ],
        "from_cache": False,
    }


@router.delete("/memory/{memory_id}", dependencies=[Depends(guard)])
async def forget_memory(memory_id: int) -> dict[str, Any]:
    return {"ok": await long_term.forget(memory_id)}

@router.get("/metrics", dependencies=[Depends(guard)])
async def metrics_endpoint() -> dict[str, Any]:
    """P3 — counters and latency summaries as JSON. Label values are
    component/status/model names only; never queries, sessions or facts."""
    return observability.snapshot()


@router.get("/health")
async def health() -> dict[str, Any]:

    return {
        "ok": True,
        "planner": llm.configured(),
        "model": llm.model(),
        "endpoint": llm.base_url(),
        # Reported so a deploy's limits can be read off the running service
        # rather than inferred from which env vars someone remembered to set.
        "limits": {
            "per_client_hourly": settings.rate_limit_per_hour,
            "global_hourly": settings.global_limit_per_hour,
        },
    }
