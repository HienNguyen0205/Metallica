# FRIDAY Orchestrator

The backend half of §2. One SSE endpoint drives the frontend state machine.

> Paths like `src/lib/store.ts` below live in this same repo, next to
> `backend/`. The two halves are contract-coupled but deploy
> independently: this service owns the event contract, the UI consumes it.

## Run

```bash
cd backend
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt  # macOS / Linux

# free key, no card: https://aistudio.google.com/apikey
export GEMINI_API_KEY=...
./.venv/Scripts/python.exe -m uvicorn friday.main:app --port 8000 --reload
```

The frontend points at `http://localhost:8000` by default; override with
`NEXT_PUBLIC_FRIDAY_API` in `.env.local`.

`GET /health` reports what the gateway is pointed at, and the caps it is
enforcing — read off the running service rather than inferred from which env
vars someone remembered to set:

```json
{
  "ok": true, "planner": true, "model": "gemini-2.5-flash", "endpoint": "...",
  "limits": { "per_client_hourly": 30, "global_hourly": 100 }
}
```

## §8 Model gateway

Every model call goes through an **OpenAI-compatible** endpoint (`friday/llm.py`),
so the provider is configuration rather than code. Defaults to Gemini's free
tier; three env vars move it anywhere else:

| Provider  | `FRIDAY_LLM_BASE_URL`                                       | Notes                       |
| --------- | ----------------------------------------------------------- | --------------------------- |
| Gemini    | *(default)*                                                  | ~1500 req/day free, no card |
| Groq      | `https://api.groq.com/openai/v1`                             | fastest; smaller models     |
| Cerebras  | `https://api.cerebras.ai/v1`                                 | high daily tokens, low RPM  |
| OpenRouter| `https://openrouter.ai/api/v1`                               | aggregator, some free models|
| Ollama    | `http://localhost:11434/v1`                                  | local, offline, no key      |

Budget roughly **2-3 model calls per user query** (one agent turn, one more
after a tool returns, one planner call). Requests-per-minute limits bite here
long before token limits do.

Free tiers usually permit training on your prompts — fine for a demo, not for
real data.

## The event contract

`POST /query` with `{"query": "..."}` returns `text/event-stream`. Each event
maps onto exactly one store action in `src/lib/store.ts`:

| Event     | Payload                                 | Frontend effect          |
| --------- | --------------------------------------- | ------------------------ |
| `state`   | `{"state": "thinking"}`                 | `transition(state)`      |
| `tool`    | `{"tool": "...", "risk": "low"}`        | (progress only)          |
| `confirm` | `{"id", "tool", "risk", "input"}`       | `setPendingConfirm()`    |
| `denied`  | `{"tool": "..."}`                       | (progress only)          |
| `viz`     | a `VisualizationSpec`                   | `setVisualization()`     |
| `answer`  | `{"text": "..."}`                       | `setAnswer(text)`        |
| `error`   | `{"message": "..."}`                    | logged, flow continues   |
| `done`    | `{}`                                    | stream complete          |

Adding a step to the agent flow means emitting another event — the transport
does not change.

## Events v2 (`FRIDAY_EVENTS_V2`)

Off (default): the wire is exactly as documented above. On: every frame is a
v1 envelope (`version/run_id/session_id/turn_id/sequence/timestamp/event/payload`,
see the FE repo's `contracts/events.v1.json`) and the agent emits `step` events
(`step_id/turn_id/kind/status/tool?/summary?/retry_count?/error?`) that mirror a
Run/Step model (`friday/runs.py`, LRU 200, in-memory like the §11 approvals).
Sequence starts at 1 and never skips; nothing is published after `done`.
Enable only once the frontend with P0.1+ (tolerant envelope reader) is deployed —
an older FE drops enveloped frames silently.

## §18 Streaming visualization

The hologram materializes as results land, not after the turn ends. A tool can
declare a `preview` (`friday/tools.py`) that maps its raw output to a partial
spec; each one goes out as a `viz` event the moment the tool returns, and the
planner's spec replaces it at the end. A single query therefore emits several
`viz` events:

```
thinking → tool_execution → viz(radial_gauge) → viz(bar_3d)
         → processing → visualizing → viz(final) → speaking
```

Previews are **deterministic** — no model call. A planner call per tool result
would triple our request count against a tier limited by requests-per-minute.

That determinism is also why the **last preview picks the component and the
planner may not change it**. The planner is pinned to that type through its JSON
schema (`_schema(pinned)` narrows `type` to a `const`), so the final spec refines
the data and the title while the shape on screen stays put.

Measured before the pin: the same question, asked twice, planned `bar_3d` once
and `radial_gauge` the next time. A preview reads the shape of the tool's own
output; the planner re-reads the same JSON and is entitled to a different
opinion, which the user experiences as bars building and then being replaced by
gauges for no reason they can see.

The pin is applied to the schema rather than to the finished plan on purpose. A
type swapped in afterwards arrives carrying the data fields of the type the
model *did* choose — forcing `bar_3d` onto a plan written as `radial_gauge`
yields a bar chart whose `series` is empty. Constrained up front, the model
fills the fields that component actually reads.

With no preview in the turn — `search_web` declares none — nothing is pinned and
the planner chooses freely.

A preview deliberately does **not** emit a `visualizing` state. FRIDAY is still
running tools, and the UI's transition table has no `visualizing →
tool_execution` edge; announcing it strands the HUD on VISUALIZING for the rest
of the turn, because guarded transitions drop illegal edges silently with no
error anywhere. `test_stream.py` mirrors that table and walks every emitted
sequence against it, and the UI asserts the same invariant from the other
side: `PROCESSING` must appear before the first `VISUALIZING`, since a stranded
HUD never shows `TOOL EXECUTION` again and any check against *that* passes in
both the healthy and the broken case.

Note the endpoint is **POST**, so the frontend uses `fetch` + a stream reader
rather than `EventSource`. `EventSource` is GET-only, which would put the
user's question in the URL and therefore in every access log along the way.

## §15 Memory

Short-term only, and on purpose. `POST /query` accepts an optional
`session_id`; `friday/memory.py` keeps the last **3 exchanges** for it in this
process and replays them between the system prompt and the new question. That
is the whole feature, and it is what makes "and the disk?" resolve to anything.

What it is not: durable, shared between workers, or searchable. The doc's §15
lists PostgreSQL, Redis, a vector DB and object storage behind five kinds of
memory; none of that is needed to fix the thing that was broken, and the §11
approvals already pin this service to one process, so process-local state costs
no deployment freedom that was available anyway.

**Only the final text of each turn is stored** — never `tool_calls`. Replaying a
tool call obliges us to replay its matching tool result too, or the provider
rejects the message list, and a half-replayed exchange is a quietly wrong prompt
rather than a loud error. Re-fetching through a tool is also the only way the
numbers stay current.

Two bounds that are not optional:

- **3 exchanges per session.** Each one is re-sent on every later turn, and a
  long tail of stale context makes the model answer the wrong question.
- **200 sessions, LRU.** `/query` is public and the id comes from the client, so
  an unbounded dict here is a way to exhaust the server's memory with a loop of
  random ids — not merely a leak.

A turn that fails is not recorded, so a provider outage cannot leave a
half-finished exchange as context for the next question.

The frontend generates the id per **tab** and keeps it in `sessionStorage`
(`src/lib/api/fridayClient.ts`): the memory it keys into dies with this process,
so an id that outlived the tab would point at nothing while implying continuity.
A client that sends no id gets the old stateless behaviour.

## §15 Long-term memory

Opt-in, on top of the short-term memory above. The model itself decides what
is worth keeping: a `remember` tool call stores one fact in Supabase with its
provenance (`user` or `tool`), and the most relevant facts are recalled into
the prompt on later turns, by any session, forever — until deleted. Set
`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to turn it on; unset, FRIDAY runs
exactly as before and logs one line at startup saying so.

**`remember` costs zero extra model calls.** It is one more tool in the
existing agent loop (`friday/tools/registry.py`) — the model calls it in the
same turn it is already running, the same way it calls `search_web` or
`read_note`. There is no separate "memory pass."

**Recall is top-k over an in-process cache, not a query to Postgres.**
`friday/memory/long_term.py` loads every row into `CACHE` at startup and
ranks it with a plain Python cosine loop; `friday/api/routes.py:recall_block`
embeds the question, takes the top 5 above a similarity floor, and renders
them into a fenced block in the prompt. This works because the service is
already pinned to a single uvicorn process by the §11 approval dict
(`PENDING` in `friday/main.py` — see `render.yaml`), so an in-memory cache
costs no deployment flexibility that a second worker could have used anyway.
At a few hundred memories this is sub-millisecond; the schema's `vector(768)`
column is ready for `pgvector`/`ivfflat` the day the table reaches the
thousands or the service stops being one process — whichever comes first.

**Frequency-based ranking was cut.** The schema carried a `use_count`
column and the code selected, stored and returned it, but nothing ever
incremented it — it was a zero on every row and in every response, which is
worse than absent because it reads like a measurement. It is gone from the
table, the dataclass and `GET /memory`. To bring it back: add the column,
have `store.touch()` PATCH `use_count = use_count + 1` (PostgREST cannot
express that, so it needs an `rpc` function or a raw `SELECT`-then-`PATCH`),
carry it on `Memory`, and give `top_k` a term that mixes it with similarity.
Recency (`last_used_at`) already covers the eviction ordering it was
originally wanted for.

**Consolidation runs after `done`, never in the request path.** A background
task (`consolidate.run`, kicked off from `run_query` right after the `done`
event) asks the model to drop duplicate, contradicted, or stale facts once
every 20 turns, or every 5 turns once the cache passes 100 memories. The
count threshold is a level, not an edge — `run()` cannot reliably bring the
count back under it, since the prompt says to keep anything it is unsure
about — so it is gated behind a turn counter of its own; without that gate a
cache of 101 facts would spend a model call after every single question. It costs a model call,
so it deliberately never sits between the user and their answer.

**`remember` escalates prompt injection from a one-turn problem to a
permanent one.** Without long-term memory, a hostile page reached through
`search_web` can only poison the current turn — the text is gone once the
response is sent. With `remember`, the model can decide that hostile text is
worth keeping, and if it does, that sentence is in *every future prompt,
for every session*, until an operator notices it in `GET /memory` and calls
`DELETE /memory/{id}`. A hostile line only has to land once.

Two hard blocks were considered and deliberately rejected: refusing
`remember` on any turn that also ran `search_web`, and marking `remember`
`risk="high"` so it goes through the same human-approval gate as a real
write. Both would have made the tool safe by making it useless for the thing
it exists to do — noticing something the operator said and holding onto it —
so neither shipped. What ships instead is three layers, all mandatory: the
`fact` field is always the model's own sentence, never raw tool output
verbatim; the recalled block is fenced and labelled explicitly as data, not
instructions, with each line tagged `(user)` or `(tool)` so a `(tool)` fact
is visibly suspect; and every successful `remember` fires a `memory` SSE
event the instant it happens, so the write is visible on the HUD rather than
silent. None of that stops a bad fact from being written — it only makes the
write visible and reversible.

`SUPABASE_SERVICE_KEY` bypasses row-level security entirely. It is read only
by this backend (`friday/memory/store.py`, via `os.getenv`) and must never be
given a `NEXT_PUBLIC_` prefix or otherwise reach the frontend bundle — that
would hand a browser script full read/write/delete on every operator's
memory table.

## Memory layers and proposal policy (P2)

Layers: working (short-term session history), episodic (past interactions —
the default for stored rows), semantic (durable facts), preference (operator
tastes, classified by heuristic), evidence (sourced observations). Every item
carries type/source/provenance/confidence/timestamps/TTL (`friday/memory/`
`Memory`; TTL stored, not yet enforced).

The model only *proposes* memory. `friday/memory_policy.py:propose()`
validates, deduplicates (cosine ≥ 0.95 reuses the row), supersedes on
contradiction (preference changes replace), and rejects prompt-injection
shapes on tool-sourced proposals — the operator's own words stay trusted,
matching the recall fence. Covered by `tests/unit/test_memory_policy.py`.

## §22 The gate on /query

`/query` is public, unauthenticated, and every call spends provider quota.
There is nothing to authenticate *against*: the caller is a static page on a
CDN, so any secret it could send is in a bundle anyone can read. A key checked
here would stop only the people who never opened devtools.

So the endpoint is not locked, it is **metered** — `api/dependencies.py`:

| Check | Refusal | What it is for |
| --- | --- | --- |
| `Origin` on the allowlist | `403` | another site driving this agent from a visitor's browser |
| per-caller, 30/hour | `429` + `Retry-After` | one visitor spending the whole allowance |
| global, 100/hour | `429` + `Retry-After` | everything else, including forged headers |

**The origin check is not the CORS middleware.** CORS stops the *browser* from
reading a cross-origin response, which happens after the handler has already
run — on a streaming endpoint that means the model calls were made and paid
for, and only the answer was discarded. Refusing before the handler is what
protects the quota.

**The global cap is the one that actually binds.** Per-caller buckets are keyed
on `X-Forwarded-For`, because behind Render's proxy the peer address is the
proxy and every visitor would share one bucket. That header is trivially
forged, so per-caller limits only separate honest callers from each other; the
number that bounds the bill is the global one. Size it against the key: a query
is 2-3 model calls, so 100/hour sustained is already a free tier's whole day.

Both windows are checked before either is charged — a request the global cap
refuses does not quietly consume the caller's own budget.

`/confirm` gets the origin check but not the meter. Its id is a `uuid4` nobody
can guess, and charging approvals against the query budget would let a
tool-heavy session run out of turns halfway through its own approval.

A refusal is deliberately **not** something the UI answers with its offline
demo planner. Unreachable means canned data is better than nothing; refused
means the service is up and said no, and swapping in an invented number there
would show the user a plausible answer with no sign it is not a real one. The
UI raises `OrchestratorRefused` and puts the reason on the HUD instead —
`Retry-After` is listed in `expose_headers`, or the browser would hide the
wait from the page.

## §10 Tools and §11 permissions

Tools are declared in `friday/tools.py` with a risk level. The orchestrator —
not the tool, and never the model — decides from that level whether a call needs
a human. Risk is stripped from the definition sent to the API: the model has no
say in its own permissions.

| Tool                 | Risk | Effect                                    |
| -------------------- | ---- | ----------------------------------------- |
| `get_system_metrics` | low  | reads host CPU / memory / disk (psutil)   |
| `get_process_list`   | low  | top processes by memory share             |
| `search_web`         | low  | public web search, three providers in turn |
| `write_note` | high | writes a markdown file under `notes/` |
| `list_dir` | low | lists one level under `FRIDAY_SANDBOX_DIR` (default `notes/`) |
| `read_file` | low | reads one text file under the sandbox, truncated with a flag |

`get_process_list` ranks by memory, not CPU: `cpu_percent` reads 0.0 the first
time a process is sampled, so a CPU ranking there would be noise wearing a
number.

A high-risk call emits `confirm` and **blocks**. The stream stays open while the
UI shows the tool name and its exact arguments; `POST /confirm {id, approved}`
releases it. Silence is not consent — after `CONFIRM_TIMEOUT_S` (120s) the call
is refused and the model is told it was denied.

## Cancellation and budgets

`POST /runs/{run_id}/cancel` stops a live run: the streaming task gets
`CancelledError`, the registry records `cancelled` exactly once, and a pending
approval wait dies unapproved (never resolved as approved). Cancelling a
finished run reports its terminal status; unknown runs are a 404 — both
idempotent. The UI also calls it on cancel/Escape; aborting the fetch alone
already ends the turn locally, the endpoint additionally stops server spend.

`POST /query` accepts an optional `budget` (`max_wall_time_ms`,
`max_tool_calls`, plus token/search/context/cost keys reserved for later
metering). An exhausted budget ends the turn with an `error` frame carrying
`code: "budget_exceeded"` — a structured error, never an ambiguous exception —
and the run is recorded `failed`. Per-tool `timeout_s` / `max_output_bytes`
ride the same failed/completed step path as any tool error. Covered by
`tests/integration/test_cancel.py` and `test_budgets.py` (cancel while
thinking / in tool / waiting approval / after completion / duplicate /
unknown; wall-time, tool-call, no-budget, tool timeout, output cap).

Per §22 there is no shell tool, no `eval`, and no arbitrary-path write.
`write_note` sanitises the model's string to a bare stem and rebuilds the path
itself, so nothing the model sends is ever used as a path component verbatim.

## Policy and capabilities (P1.7/P1.8)

Every tool call passes `friday/policy.py:evaluate()` before it runs — risk
level, required capabilities and argument shape are server declarations the
model cannot override (smuggled `risk`/`decision` keys in arguments are
ignored). Verdicts: `allow`, `ask_human` (high risk), `step_up` (sensitive
capabilities such as `memory.write`/`notes.write`, even on low-risk tools),
`deny` (unknown tool, missing capability, bad arguments — no human prompt).

Tools declare `capabilities` (e.g. `system.read`, `web.read`, `notes.write`);
the deployment grants a set via `FRIDAY_GRANTED_CAPABILITIES` (`*` by
default). `ask_human` and `step_up` share the existing confirm UX, separated
for audit. Covered by `tests/unit/test_policy.py` (matrix, capability and
argument gates, model-override proof, agent-loop denial without a prompt).

`search_web` is the only tool that reaches off this machine, and the only one
that puts text written by strangers into the model's context — a
prompt-injection surface by construction. The containment is the §11 gate rather
than filtering: every consequential tool is `risk="high"` and blocks on a human,
so a page instructing FRIDAY to write a note still has to get past the operator.

Three providers are tried in order, each falling through on failure:

| Order | Provider | Credentials | Free allowance |
| --- | --- | --- | --- |
| 1 | Google Programmable Search | `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX` | 100/day, **resets daily** |
| 2 | Tavily | `TAVILY_API_KEY` | fixed credit balance |
| 3 | DuckDuckGo | none | unlimited but rate-limited |

Google leads on quota shape, not answer quality — Tavily returns extracted page
text and Google only snippets. But Google's hundred come back every morning
while Tavily's credits, once spent, stay spent, so the renewable allowance goes
first and the finite one is held in reserve for the days it has run out.

Falling through on **failure** rather than only on a missing key is the whole
point: a balance runs out mid-conversation, and what arrives then is a 401.

With nothing configured search still works, on a scrape of DuckDuckGo's HTML
endpoint. Measured, that serves roughly a dozen requests before answering every
query with a captcha for several minutes, and it mixes sponsored results in
among the real ones — filtered here, because an advert summarised into an answer
is indistinguishable from a fact. Treat it as the tail of the chain, not a
plan: every measurement above ran from a residential connection, and search
engines refuse datacenter addresses far more readily, so on a deployed host it
may be blocked from the first call.

Results are trimmed to 5 items of 600 characters. That is a context budget, not
a display choice: tool output is replayed on every later turn of the same
conversation.

Requests go out on stdlib `urllib.request` in a thread. `httpx` is not a
declared dependency here — it arrives only under `openai`, which vendors it as
`httpx2`, having renamed it once already.

`get_system_metrics` exists mainly so the gauges show measurements. Without a
tool the planner has nothing but the model's prior, and a chart of invented
numbers is indistinguishable from a real one.

### Why the agent runs as a task, not a loop

`run_query` pumps `agent.run` through a queue rather than iterating it directly.
The approval callback blocks *inside* the agent generator, so a directly
iterated generator could not yield the approval prompt while it was itself
blocked waiting for the answer to that prompt — every high-risk call would stall
until it timed out.

## Why the model never draws

Per §25, Claude does not emit rendering code. It returns a `VisualizationPlan`
(`friday/schema.py`) naming one of ten components the frontend already knows,
plus the data that component reads. The schema is enforced by structured
outputs, so a malformed plan is a validation error rather than a broken scene.

Support for `json_schema` varies across OpenAI-compatible providers — some
reject Pydantic's `$defs`/`$ref` output. `planner.py` degrades to plain JSON
mode with the schema in the prompt when the provider returns a 400, and strips
markdown fences from models that add them anyway.

`friday/schema.py` must stay in lockstep with `VisualizationSpec` in
`src/lib/store.ts`. A field here that does not exist there renders as nothing.

## Fallback behaviour

If the orchestrator is unreachable the UI falls back to the local rules planner
in `src/lib/vizPlanner.ts` and logs a warning. That path serves **canned demo
data** — it exists so the interface is presentable with no backend running, not
as a degraded live mode.

## Run state storage (P1.9)

Every registry mutation persists a snapshot through `friday/store.py`'s
`StateStore` — live objects stay the operational truth, snapshots go durable.
`FRIDAY_STATE_BACKEND=memory` (default) keeps snapshots process-local;
`redis` (+ `FRIDAY_REDIS_URL`, `pip install redis`) puts them in Redis where
any worker can read them. No agent code imports redis. Single writer per run:
the streaming worker owns its run; approval *waits* stay process-local until
reconnect (P1.10) — only the request records are shared. Covered by
`tests/unit/test_store.py` (both backends against one contract, factory,
write-through, eviction).

## Evidence and claims (P2)

Every tool result becomes an `Evidence` (`friday/evidence.py`): id, tool
source, full output, timestamp, confidence and provenance. Third-party text
(`search_web`) is suspect by construction (0.7/`external_source`); direct
measurements and the operator's own words are 1.0; failures are recorded at
0.0 — a failure is still a sourced observation. The turn's final answer
becomes one `Claim` citing every collected id at weakest-link confidence,
`unverified` until the verifier step lands. Evidence entries keep their
`tool`/`output` keys so planner input is unchanged, and no citations are
injected into prompts. Runs persist both lists for reconnect reads and
verification. Covered by `tests/unit/test_evidence.py`.

## Verification and replan

`friday/verify.py` runs deterministic structural checks on the final answer
(empty text, all-evidence-failed) — no model call, no cost. A failure spends
one bounded replan (`MAX_REPLANS = 1`): the hint is appended and the loop
takes another pass inside the existing turn budget, emitting a `verification`
step event. An exhausted budget leaves the answer standing `unverified`
rather than looping; passing answers are marked `supported`. Semantic
judgments (conflicts, staleness, plausible-but-unsupported claims) need a
model-graded verifier and are explicitly out of v1 scope. Covered by
`tests/unit/test_verify.py`.

## Reconnect and resume (P1.10)

Every enveloped frame is appended to the run's replay log
(`GET /runs/{run_id}/events?after_sequence=N` reads it back with the run
status and a terminal flag). A client that loses the stream mid-turn resumes
from the log instead of re-asking: the replay is a pure log read, so tools,
the agent and the planner never re-execute, and already-seen sequences are
skipped by the frontend guard. Unknown runs are a 404, never an empty stream.
Covered by `tests/integration/test_reconnect.py` (verbatim replay, filtering,
no-reexecution, 404, live partial) and the resume cases in
`tests/unit/envelopedFlow.spec.ts`.

## Evaluation suite (P2)

`backend/evals/` scores decision quality, not just code paths: cases declare
input, scripted model turns, must/must-not-call sets, approval behavior,
answer text, memory outcome and claim status. The runner (`runner.py`)
reports per-case pass/fail plus latency/tool-call/approval metrics and exits
non-zero on failure; `tests/integration/test_evals.py` wires it into CI, so
the gate can never skip it.

The model is scripted because CI has no key — these evals measure the
harness (routing, gates, memory, verification, regressions), with token/cost
keys reserved for the metering phase. `live: True` cases (real models) are
skipped by the CI runner and run separately. Visualization correctness lives
in the FE suite (`tests/unit/vizPlanner.spec.ts`, ~190 planner cases plus
contract parity), not here.

Run it: `python backend/evals/runner.py [area]` from the repo root, or the
whole gate via `npm run test:backend`.

## Observability (P3)

`friday/observability.py` holds correlation IDs, counters and latency
histograms — dependency-free, process-local (a second worker would need a
shared sink). Every run gets `request_id` (per POST, echoed as
`X-Request-ID`) and `trace_id`, stored on the run record. Series: runs and
failures by status, tool calls/latency/errors by tool, LLM calls/latency by
model and status, tokens and cost estimate by model (usage-metered; cost
needs `FRIDAY_MODEL_PRICES_JSON`, otherwise 0.0 rather than a guess),
approval waits, memory read/write latency, verification failures, replans,
SSE disconnects and replay reads. `GET /metrics` serves the snapshot as
JSON. Label values are component/status/model names only — never queries,
sessions, arguments or facts. Covered by
`tests/unit/test_observability.py`.

## Identity and audit (P3)

Identity is plumbing, not login: requests without a trusted identity header
are anonymous and `session_id` stays their boundary. Runs record
`owner_user_id`; the cancel/replay endpoints refuse mismatched callers
(403) while anonymous-owned runs behave exactly as before. Headers count
only with `FRIDAY_TRUST_IDENTITY_HEADERS=true` (a proxy must strip them —
blind trust would let anyone be anyone).

`friday/audit.py` is an append-only ring (1000 entries): run lifecycle, tool
execution, policy denials, approval requested/resolved, memory created and
deleted, cancellations. Secret-shaped keys are redacted, long strings
trimmed, tool arguments logged by key name only. `GET /audit`
(`?run_id=`, `?limit=`) serves it to operators. Covered by
`tests/unit/test_identity_audit.py`.

## Tests

One command from the repo root — `npm run test:backend` (`python
backend/runtests.py`) — runs every file below in its own process. From
`backend/` directly:

```bash
PYTHONPATH=. ./.venv/Scripts/python.exe tests/unit/test_memory.py
PYTHONPATH=. ./.venv/Scripts/python.exe tests/integration/test_search.py
PYTHONPATH=. ./.venv/Scripts/python.exe tests/integration/test_stream.py
PYTHONPATH=. ./.venv/Scripts/python.exe tests/integration/test_provider.py
```

`test_stream.py` covers the event sequence, the approval gate (announced before
running, denial reported to the model, timeout refuses), that a dead model still
closes the stream rather than leaving the UI stuck in `THINKING`, and that a
hostile note name cannot escape `notes/`. Model calls are stubbed.

`test_memory.py` covers §15: that prior exchanges actually reach the model's
message list in order, that two sessions cannot see each other, that a failed
turn is not recorded, and that both caps hold.

`test_search.py` covers §10 web search against a local fake provider: a missing
key degrading to an error instead of an exception (and making no network call to
discover it), a provider 401 doing the same, and result trimming.

`test_provider.py` runs the **real** agent loop and planner against a local
fake OpenAI-compatible server: the tool-call round trip, evidence reaching the
planner, and the `json_schema` -> `json_object` fallback. No key, no network.

## Deploying to Render

`render.yaml` is a Blueprint: **New → Blueprint** in the dashboard, point it at
this repo, set the service's **Root Directory** to `backend/`, and it creates
the service. Or create a Web Service manually with:

| Field | Value |
| --- | --- |
| Runtime | Python |
| Build command | `pip install -r requirements.txt` |
| Start command | `uvicorn friday.main:app --host 0.0.0.0 --port $PORT` |
| Health check path | `/health` |

Then set two environment variables in the dashboard (not in the repo):

- `GEMINI_API_KEY` — your key
- `FRIDAY_ALLOWED_ORIGINS` — the deployed frontend's origin, e.g.
  `https://metallica.vercel.app`. No trailing slash, no path.

Finally rebuild the frontend with `NEXT_PUBLIC_FRIDAY_API` set to the Render
URL. It is inlined at build time, so changing it needs a redeploy of the UI,
not just an env var edit.

### Check the deploy actually worked

`GET /health` answers without a model call, so it stays green even when the
provider is misconfigured. Read the startup lines in Render's log instead:

```
INFO friday: planner configured: True
INFO friday: model: gemini-3.6-flash at https://...
INFO friday: allowed origins: ['https://metallica.vercel.app']
```

A `WARNING` on either of the last two is the cause of most failed first
deploys. A CORS rejection in particular is invisible server-side — Render logs
a clean 200 while the browser silently drops the response, and the UI falls
back to its canned offline planner as if nothing were wrong.

### Things that behave differently once deployed

**Do not add gunicorn workers.** §11 approvals live in an in-process dict, so a
second worker can answer `/confirm` without holding the Future the streaming
request waits on. Every high-risk tool would then time out as denied — and only
for some requests, which is worse than failing outright. One uvicorn process is
the deliberate ceiling until approvals move to shared state.

**The free tier sleeps.** Render spins a free service down after 15 minutes idle
and takes 30-60s to wake. The first query after a quiet spell leaves the HUD in
THINKING for about a minute. Nothing is broken, but it reads as broken.

**`get_system_metrics` now reports Render, not your laptop.** The tool reads the
host the orchestrator runs on, which after deploying is a 512 MB / 0.1 CPU
container. The gauges are still real measurements — of a different machine than
the one you tested on.

**`write_note` does not persist.** Render's filesystem is ephemeral, so `notes/`
is wiped on every deploy and restart. It needs a Render Disk or object storage
before it means anything.

**Latency roughly doubles.** A two-tool turn is three model calls; locally that
is 20-25s, and 0.1 CPU plus a further network hop does not help.

## Not built yet

RAG (§16) and vision (§14) have no implementation. Memory (§15) is short-term
only — see above; the episodic, semantic and preference tiers do not exist. Voice
(§12/§13) is implemented entirely in the UI on the browser's own speech
engines, so it needs nothing from this service — a spoken question arrives at
`/query` as ordinary text. Approvals are process-local, so the orchestrator is
single-instance until they move to shared state.

## Choosing a model

Measured against the free tier, because every assumption here has been wrong at
least once:

| Model | Tool call | Structured output | Note |
| --- | --- | --- | --- |
| `gemini-2.5-flash` | — | — | 404, retired for new users |
| `gemini-3.7-flash` | — | — | hangs past 45s |
| `gemini-flash-latest` | — | — | hangs past 45s |
| `gemini-3-flash-preview` | — | — | InternalServerError |
| `gemini-3.6-flash` | 2.9s | ok | **only 20 requests/day** |
| `gemini-3.5-flash` | 15.5s | 10.7s | slow |
| **`gemini-3.5-flash-lite`** | **0.8s** | **1.2s** | the default |

**The free daily quota is per model, and it is the binding constraint** — not
speed, and not tokens. A query costs 2-3 model calls, so `gemini-3.6-flash` at
20 requests/day allowed roughly six questions before every request returned
`RESOURCE_EXHAUSTED`. A full two-tool turn is ~6s on the default and was ~23s on
3.6-flash.

Pinned rather than using a `-latest` alias: an alias can move to a model with a
tiny quota without warning, which is exactly how 3.6-flash behaves.

When a 429 arrives, read the body — it names the real limit:

```
quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier
quotaValue: 20
```

If the daily quota is too tight for your usage, the gateway makes the escape one
env var: Groq's free tier is measured in thousands of requests per day rather
than tens.
