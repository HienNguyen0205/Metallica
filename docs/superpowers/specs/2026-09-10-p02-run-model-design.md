# Design: P0.2 Run/Turn/Step model (BE) + FE step consumption

Date: 2026-09-10. Status: approved in chat (approach A), awaiting spec review.
Parent plan: `docs/CLAUDE_IMPROVEMENT_PLAN.md` §4 (P0.2). Builds on P0.1 envelope (branch `feat/event-envelope-p0.1`).

## Context

BE agent loop (`backend/friday/agent/agent.py`) is a generator yielding `AgentEvent(kind, payload)`
with no run identity: one `/query` POST = one `agent.run()` = up to `MAX_TURNS=6` LLM iterations,
tool calls interleaved. `AgentResult` holds only `text` + evidence list. FE infers progress from
event strings alone. Approval futures are process-local (`PENDING` dict in `routes.py`).

Plan §4 requires first-class Run/Step objects, tracked status/timestamps, retry counts, and a FE
that displays the current step without guessing from event strings. Approach locked in chat: **A —
in-memory RunRegistry + `step` SSE events through the P0.1 envelope**, no new infra (BE is
single-process by design; documented in backend README).

Two repos change: `backend/` (its own git repo, branch `feat/p0.2-run-model`) and this FE repo
(branch stacked on `feat/event-envelope-p0.1`).

## §1 — BE domain model (`backend/friday/runs.py`, new)

```python
StepKind = Literal["plan", "reason", "search", "tool", "memory_read",
                   "memory_write", "visualization", "verification", "answer"]
RunStatus = Literal["queued", "planning", "waiting_approval", "running",
                    "verifying", "completed", "failed", "cancelled", "expired"]
StepStatus = RunStatus  # same vocabulary per §4

@dataclass
class AgentStep:
    step_id: str          # "s1", "s2", … sequential per run
    run_id: str
    turn_id: str          # "turn_1" … — LLM iteration index
    kind: StepKind
    status: StepStatus
    tool_name: str | None = None
    input: dict | None = None        # sanitized args, audit-grade only
    output_summary: str | None = None
    evidence_ids: list[str] = field(default_factory=list)
    retry_count: int = 0
    started_at: float | None = None  # time.time()
    completed_at: float | None = None
    error: str | None = None

@dataclass
class AgentRun:
    run_id: str           # "run_" + uuid4().hex[:12]
    session_id: str | None
    goal: str             # the query
    status: RunStatus
    created_at: float
    started_at: float | None = None
    completed_at: float | None = None
    deadline: float | None = None    # None until P0.6
    budget: dict | None = None       # None until P0.7
    current_step_id: str | None = None
    steps: list[AgentStep] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)

class RunRegistry:  # dict + LRU cap 200 (mirrors memory.py session cap)
    def create(session_id, goal) -> AgentRun
    def get(run_id) -> AgentRun | None
    def begin(run_id) -> None          # queued → planning → running
    def finish(run_id, status) -> None # terminal: completed | failed | cancelled
```

Rules: ids never reused; a run carries many steps; only the registry mutates runs (agent emits
events, `run_query` translates). No persistence — restart loses history by design (short-lived
turns); durable history is deferred with approach B.

## §2 — BE event emission (gated)

**Env gate `FRIDAY_EVENTS_V2` (default off).** Off ⇒ wire format byte-identical to today
(verified by golden test). On ⇒ every frame is a P0.1 envelope:

```json
{"version":1,"run_id":"run_x","session_id":"sess_x","turn_id":"turn_1",
 "sequence":17,"timestamp":"…Z","event":"step","payload":{…}}
```

- `sequence` starts at 1, +1 per frame, never reused, nothing published after `done` (§3.2 rules).
- `turn_id` = current LLM iteration (`turn_1`…`turn_6`).
- `serializer.py` gains `sse_envelope(run, turn, sequence, event, payload)`.

`agent.run()` additionally yields (only when a `steps` callback/flag is on — the generator gains an
optional `emit_steps: bool = False` parameter so V2-off runs do zero extra work):

| Moment | Step event |
|---|---|
| LLM call starts/ends | `reason` running → completed (summary = tool-call count or "final answer") |
| tool call starts | `tool` running (`tool_name`, `retry_count` = prior attempts of same tool this run) |
| approval requested | same tool step → `waiting_approval` |
| approval denied | tool step → `failed`, error `"denied by operator"` |
| approval granted | tool step → back to `running` |
| tool raised | tool step → `failed`, error = exception type name |
| tool ok | tool step → `completed`, `output_summary` ≤ 120 chars |
| final text set | `answer` completed |

All step events are emitted by `agent.run` itself — it owns the turn index and tool context. The
`approve()` callback (routes) stays unchanged; `agent.run` wraps its own `await approve(...)`
call to emit the waiting_approval/denied/granted transitions, so no turn context ever crosses
the generator boundary. Run-level status mirrors at `RunRegistry` (`run_query` flips run status
`waiting_approval` when its confirm future is pending, back to `running` after).

Step payloads carry **operational metadata only** — `step_id, kind, status, tool?, summary?,
retry_count?` — never chain-of-thought, never raw tool output (§4.3).

`routes.run_query`: creates the run, flips run status (`waiting_approval` while a confirm is
pending), emits `step` frames through the same pump, marks run `completed`/`failed` in `finally`,
and stamps `completed_at`. `memory.remember` and consolidation are untouched.

## §3 — FE consumption (stacked on P0.1)

- `src/lib/agent/events.ts`: new union member
  `{ type: "step"; step: { stepId: string; kind: StepKind; status: StepStatus; tool?: string; summary?: string; retryCount?: number } }` —
  strict enum validation (both kinds and statuses), junk → null. `StepKind`/`StepStatus` typed
  unions mirror the BE literals (schema `definitions.stepPayload` documented in
  `contracts/events.v1.json` extension — see §4).
- `src/lib/store.ts`: `currentStep: CurrentStep | null` + `setCurrentStep`; cleared at turn start
  alongside `clearMemories()`; survives to idle like answer/viz (next turn replaces it).
- `src/lib/agentStream.ts`: `case "step": store.setCurrentStep(…)`; P0.1 StreamGuard already
  rejects duplicate/stale/wrong-run step frames for free.
- `src/components/friday/hud/ToolHud.tsx`: when `currentStep` is set, render one line in the
  existing idiom — `STEP · <KIND> · <STATUS>` (plus `· <TOOL>` for tool steps). No boxes/cards
  (anti-dashboard test). `toolActivity` behavior unchanged.

## §4 — Testing & acceptance

**BE** (`backend/tests`, `PYTHONPATH=. .venv` pattern):
- `test_runs.py` (new): registry LRU cap, id uniqueness, status transitions, retry_count
  accumulation, timestamps set.
- `test_stream.py` (extend): V2-off golden — frames identical to today; V2-on — all frames
  enveloped, sequence strictly +1 from 1, nothing after `done`; tool flow emits
  tool step running→completed; denied path marks step failed; no raw tool output in any payload.

**FE** (Playwright unit + ui):
- `events.spec.ts`: step parse valid/invalid (bad kind/status/tool type → null).
- `store.spec.ts` / `agentStream.spec.ts`: dispatch sets/clears `currentStep`; wrong-run step
  frame skipped; duplicate skipped.
- UI: `stubOrchestrator.ts` gains an optional V2 mode (enveloped frames incl. `step`, sequence
  from 1); one test asserts the `STEP ·` readout appears — this end-to-ends P0.1 unwrap + guard
  + step parsing in a real browser.

**Contract:** `contracts/events.v1.json` gains `step` in the event enum + a documentary
`stepPayload` definition (parser-enforced until BE `$ref`s — same policy as P0.1).

Acceptance §4 map: run object ✓ (`AgentRun`+registry), run holds many steps ✓, status+timestamps ✓,
retry tracked ✓, FE shows step without string inference ✓.

## §5 — Non-goals (deferred, not forgotten)

Durable run history (approach B), budget/deadline enforcement (P0.6/0.7 — fields stay None),
policy engine (§9/P0.9), resume/reconnect endpoints (P0.5 — envelope sequence already lays the
groundwork), step timeline UI, multi-worker shared run state.

## Open items

None blocking. `turn_id` semantics locked: one `/query` = one run; turn = LLM iteration inside it.
