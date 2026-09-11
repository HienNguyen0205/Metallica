# Metallica — Claude Code Implementation Plan

## 0. Mission

This document is the implementation specification for improving the current Metallica monorepo:

- Frontend: Next.js 16 + React + React Three Fiber + Three.js/WebGPU/TSL
- Backend: FastAPI + Python agent runtime under `backend/`
- Agent transport: SSE
- Agent protocol: versioned events / Run-Step model
- Visualization: typed `VisualizationSpec` + renderer registry
- Safety: tool risk classification + human approval
- Current deployment model: frontend/backend can deploy independently, despite living in one repository

The goal is **not** to redesign Metallica from scratch.

Preserve the existing strengths and incrementally turn the current system into a more reliable, testable, observable and production-shaped AI agent runtime.

---

# 1. Non-negotiable principles

Claude Code MUST follow these principles:

1. Do not rewrite working architecture merely for style.
2. Preserve existing WebGPU/TSL architecture.
3. Preserve the VisualizationSpec + renderer registry abstraction.
4. Preserve guarded agent state transitions.
5. Preserve human approval for high-risk tools.
6. Do not let the LLM directly generate executable frontend/WebGL code.
7. Backend and frontend remain independently deployable.
8. Shared contracts become the source of truth.
9. Every protocol change must have compatibility tests.
10. Every agent-runtime change must add or update tests.
11. Do not add new tools/capabilities unless the runtime can safely execute them.
12. Prefer small, reviewable changes grouped by phase.
13. Do not silently change externally observable behavior.
14. When uncertain, inspect the current implementation first instead of assuming the repository matches this document.

---

# 2. Current target architecture

Target architecture:

```text
                           USER
                             |
                             v
                     +---------------+
                     |   API Layer   |
                     +-------+-------+
                             |
                             v
                     +---------------+
                     |  Run Manager  |
                     | session/run   |
                     +-------+-------+
                             |
                             v
                     +---------------+
                     | Policy Engine |
                     | auth/budget   |
                     | capabilities  |
                     +-------+-------+
                             |
                             v
                     +---------------+
                     |    Planner    |
                     | goal -> plan  |
                     +-------+-------+
                             |
               +-------------+-------------+
               |                           |
               v                           v
        +-------------+             +-------------+
        | Tool Runner |             |   Memory    |
        | validation  |             | working /   |
        | timeout     |             | semantic /  |
        | retry       |             | episodic    |
        +------+------+             +------+------+
               |                           |
               +-------------+-------------+
                             |
                             v
                     +---------------+
                     |   Evidence    |
                     | claims/source |
                     +-------+-------+
                             |
                             v
                     +---------------+
                     |   Verifier    |
                     | verify/replan |
                     +-------+-------+
                             |
                    +--------+--------+
                    |                 |
                    v                 v
              +-----------+     +-----------+
              |  Answer   |     |    Viz    |
              +-----+-----+     +-----+-----+
                    |                 |
                    +--------+--------+
                             |
                             v
                       SSE / Events
                             |
                             v
                    Metallica Frontend
                             |
             +---------------+---------------+
             |                               |
             v                               v
       Agent state                      WebGPU/TSL
                                         renderer
```

Do not implement everything in one pass. Build this incrementally.

---

# 3. Phase P0 — Monorepo correctness

Priority: CRITICAL

The repositories are now combined. The first objective is to make the monorepo a real shared development unit.

## P0.1 Establish a single source of truth for contracts

Create or consolidate:

```text
contracts/
  events/
    events.v1.json
    events.v2.json
  visualization/
    visualization.v1.json
  run/
    run.v1.json
  tool/
    tool.v1.json
  error/
    error.v1.json
```

Do not duplicate contract files between frontend and backend unless generated artifacts require it.

Preferred structure:

```text
contracts/
    source schemas

src/
    generated/client types if needed

backend/
    generated/server validation if needed
```

Requirements:

- FE parser validates against the same semantic schema used by BE.
- BE event emitter is tested against the same schema.
- VisualizationSpec schema is validated in backend and frontend tests.
- Contract version is explicit.

Add tests that fail if a producer emits fields not accepted by the contract.

---

## P0.2 Event envelope

Use a canonical event envelope:

```json
{
  "version": 2,
  "run_id": "...",
  "session_id": "...",
  "turn_id": "...",
  "sequence": 17,
  "timestamp": "...",
  "event": "tool",
  "payload": {}
}
```

Rules:

- `version` is mandatory.
- `run_id` is mandatory for every run event.
- `turn_id` is mandatory for turn-scoped events.
- `sequence` is monotonically increasing within a stream/run.
- timestamps are server-generated.
- event payload is validated separately.
- terminal events must be explicit.

Frontend requirements:

- reject stale run events
- detect sequence gaps when appropriate
- ignore duplicate events
- ignore events for completed/expired runs
- expose protocol errors to the store/state machine instead of silently failing

Backend requirements:

- never emit malformed envelopes
- never emit events after terminal completion
- do not reuse sequence numbers
- preserve run/session identity across the full execution

---

## P0.3 Finish FE Events v2 migration

Current BE already has Events v2 / Run-Step semantics.

Complete the migration so the FE is fully tolerant of v2 before making v2 the default.

Requirements:

- parser accepts v2
- store handles v2
- agent state machine maps v2 `state`/`step` events correctly
- visualization events work through v2
- approval events work through v2
- terminal events close the stream cleanly
- legacy v1 may remain temporarily for compatibility, but must have a clear removal plan

Add an end-to-end test proving:

```text
BE v2 event
    -> SSE
    -> FE parser
    -> store
    -> state machine
    -> UI
```

---

## P0.4 Root-level developer commands

The root repository must expose a coherent developer experience.

Add/update scripts so developers can run:

```bash
npm run dev
npm run dev:frontend
npm run dev:backend

npm run lint
npm run typecheck

npm run test
npm run test:frontend
npm run test:backend
npm run test:e2e
npm run test:contracts

npm run verify
```

Optional but preferred:

```bash
npm run dev:full
```

which starts frontend and backend together.

Document:

- environment variables
- backend setup
- frontend setup
- local ports
- how SSE works locally
- how approval flow is tested
- how to run full-stack E2E

Do not require contributors to reverse-engineer this from README files.

---

## P0.5 Full-stack CI

Current frontend CI is good but backend and contract validation must be part of the root CI.

Required PR checks:

```text
frontend:
  lint
  typecheck
  unit

backend:
  tests
  type checking
  linting if configured

contracts:
  schema validation
  producer validation
  consumer validation

integration:
  backend SSE
  frontend consumer
  tool/approval flow

e2e:
  critical agent journey
```

Do not make a real paid external LLM API call in normal CI.

Use deterministic fake model/provider fixtures.

---

## P0.6 Documentation re-baseline

Because BE is now under `backend/`, update all documentation that still says backend is in a separate repository.

Search:

```text
separate repository
repo riêng
backend repo
Metallica_BE
```

Update:

- root README
- backend README
- architecture docs
- CLAUDE.md
- AGENTS.md
- deployment docs
- testing docs

Document the canonical architecture:

```text
monorepo
  frontend/
  backend/
  shared contracts/
```

Do not leave historical instructions active without labeling them as historical.

---

# 4. Phase P1 — Harden the agent runtime

Priority: HIGH

The current Run/Step work is good. The next objective is turning it into a stronger execution model.

## P1.1 Formal AgentRun model

Define:

```text
AgentRun
```

or the Python equivalent with:

```text
run_id
session_id
turn_id
goal
status
created_at
started_at
completed_at
deadline
budget
plan
steps
evidence
final_answer
error
```

Run status should be explicit:

```text
queued
planning
running
waiting_approval
verifying
completed
failed
cancelled
expired
```

Do not infer run state only from the last event.

---

## P1.2 Formal AgentStep model

Each step must contain:

```text
step_id
run_id
kind
status
tool
input
summary
started_at
completed_at
retry_count
error
evidence_ids
```

Possible kinds:

```text
plan
tool
observation
memory
verification
visualization
answer
```

This is an execution model, not just logging.

---

## P1.3 Separate planning from execution

Current loop is primarily:

```text
LLM -> tool -> result -> LLM
```

Introduce:

```text
goal
  ↓
plan
  ↓
execute
  ↓
observe
  ↓
verify
  ↓
replan if necessary
  ↓
answer
```

Do not force every request through complex planning.

Support at least:

```text
simple request
  -> direct execution

multi-step request
  -> explicit plan
```

Use a deterministic heuristic or planner classification to decide when a plan is needed.

---

## P1.4 Task/Plan graph

Create a lightweight plan model:

```text
AgentPlan
  nodes[]
  dependencies[]
  current_node
```

Example:

```text
A = collect system metrics
B = inspect processes, depends on A
C = verify anomaly, depends on B
D = produce answer, depends on C
```

The first version can remain sequential.

Do not build a complex DAG scheduler unless tests demonstrate a real need.

---

## P1.5 Cancellation

Add a first-class cancel flow:

```text
POST /runs/{run_id}/cancel
```

Behavior:

- running tools receive cancellation when possible
- LLM loop terminates
- pending approval resolves as cancelled
- final event is emitted once
- frontend returns to idle safely
- cancellation is idempotent

Add tests for:

- cancel while thinking
- cancel during tool
- cancel while waiting approval
- cancel after completion
- duplicate cancel

---

## P1.6 Timeout and budget model

Create per-run budgets:

```text
max_wall_time
max_tool_calls
max_tokens
max_search_calls
max_context_size
max_estimated_cost
```

Tool budgets:

```text
tool_timeout
retry_limit
max_output_size
```

When a budget is exceeded:

```text
status = budget_exceeded
```

Emit a structured error.

Do not let the run die with an ambiguous generic exception.

---

# 5. Phase P1.7 — Policy engine

Priority: HIGH

Current risk/approval behavior is good. Formalize it.

Create:

```text
PolicyDecision
  allow
  deny
  ask_human
  step_up
```

Example:

```json
{
  "tool": "database.query",
  "decision": "ask_human",
  "reason": "sensitive dataset",
  "constraints": {
    "max_rows": 100
  }
}
```

Do not let the LLM provide or override the tool risk level.

Policy inputs should include:

```text
tool
user/session identity
capabilities
resource
arguments
risk
environment
budget
```

---

# 6. Phase P1.8 — Capability-based tool security

Move beyond simple:

```text
low / high risk
```

toward:

```text
capabilities
```

Example:

```text
database.read.orders
database.read.customers
notes.write
browser.read
browser.submit
```

Tool declarations should specify required capabilities.

Arguments should be validated before execution.

This becomes important before adding filesystem, browser, database, email or calendar tools.

---

# 7. Phase P1.9 — Durable/distributed state

Priority: HIGH

Current process-local approval/session state is a scaling bottleneck.

Introduce a storage abstraction:

```text
StateStore
```

Do not hard-code Redis everywhere.

Interface:

```text
get_run(run_id)
save_run(run)
update_run(...)
get_approval(...)
resolve_approval(...)
```

Initial implementations:

```text
InMemoryStateStore
RedisStateStore
```

Use the in-memory version for local tests.

Use Redis/shared storage in production.

Keep the agent code independent from storage implementation.

---

# 8. Phase P1.10 — Reconnect/resume SSE

Add:

```text
GET /runs/{run_id}/events?after_sequence=N
```

or equivalent.

Requirements:

- FE can reconnect after network interruption
- server replays missed events
- replay does not re-execute tools
- duplicate events are safely ignored
- terminal run can still provide final state
- stale runs return a clear status

This is important because streaming UI should not lose agent state after a browser/network interruption.

---

# 9. Phase P2 — Evidence system

Priority: HIGH

This is one of the highest-value intelligence improvements.

Current pipeline:

```text
tool result
   ↓
LLM
   ↓
answer
```

Target:

```text
tool result
   ↓
evidence
   ↓
claims
   ↓
verification
   ↓
answer
```

Define:

```text
Evidence
  evidence_id
  source_type
  source_id
  content
  retrieved_at
  confidence
  provenance
```

Define:

```text
Claim
  claim_id
  statement
  evidence_ids[]
  confidence
  status
```

The final answer should be able to map important claims back to evidence.

Do not require citations for purely local/internal tool results unless useful.

---

# 10. Phase P2 — Verification and re-planning

Add a verifier step for multi-step/high-impact answers.

Example:

```text
plan
 ↓
execute
 ↓
collect evidence
 ↓
verify
 ├── pass → answer
 └── fail → replan
```

Verifier should catch:

- missing required tool results
- conflicting observations
- unsupported claims
- incomplete task
- stale data
- malformed visualization data

Keep verification bounded.

Do not create infinite:

```text
plan -> verify -> replan -> verify
```

Use a small verification budget.

---

# 11. Phase P2 — Memory redesign

Do not immediately implement a huge RAG system.

First define memory layers:

```text
Working Memory
  current run state

Episodic Memory
  past interactions/runs

Semantic Memory
  durable facts

Preference Memory
  user preferences

Evidence Memory
  source-backed observations
```

Every memory item should have:

```text
memory_id
type
content
source
provenance
confidence
created_at
updated_at
last_used_at
ttl
```

---

## Memory policy

LLM should only propose memory.

Example:

```text
LLM
 ↓
memory proposal
 ↓
MemoryPolicy
 ↓
validate
 ↓
deduplicate
 ↓
contradiction check
 ↓
persist
```

Reject obvious prompt-injection content.

Track provenance:

```text
user
tool
system
model_inferred
external_source
```

Do not treat `model_inferred` as authoritative.

---

# 12. Phase P2 — Semantic visualization planner

Current VisualizationSpec architecture is strong. Do not replace it.

Instead add semantic planning before selecting renderer.

Target:

```text
user question
 ↓
intent
 ↓
metric
 ↓
dimension
 ↓
data shape
 ↓
visual encoding
 ↓
renderer type
 ↓
VisualizationSpec
```

Example:

```json
{
  "intent": "compare",
  "metric": "memory_usage",
  "group_by": "process",
  "sort": "descending",
  "emphasis": ["top_3"],
  "visualization": "bar_3d"
}
```

The renderer registry remains unchanged.

This reduces presentation-driven model decisions.

---

# 13. Phase P2 — Model routing

Add a model router:

```text
ModelRouter
```

Possible categories:

```text
simple_answer
tool_reasoning
planning
structured_visualization
summarization
verification
```

Route to different configured models/providers when appropriate.

Every model call must record:

```text
model
provider
latency
input_tokens
output_tokens
estimated_cost
success/failure
```

Do not let model routing become hidden behavior.

Make routing observable.

---

# 14. Phase P2 — Evaluation framework

Priority: VERY HIGH

This is required to measure whether FRIDAY is actually getting smarter.

Create:

```text
evals/
  tool_selection/
  planning/
  memory/
  safety/
  web_search/
  visualization/
  multi_step/
  regression/
```

Each evaluation should define:

```yaml
input:
must_call:
must_not_call:
expected_output_properties:
expected_visualization:
expected_safety_decision:
```

Track:

```text
tool selection accuracy
planning accuracy
verification accuracy
memory precision
hallucination rate
visualization correctness
safety violations
latency
token usage
estimated cost
```

Use deterministic fake providers for CI.

Use real model evaluation separately.

---

# 15. Phase P3 — Observability

Priority: HIGH before production scale

Introduce IDs everywhere:

```text
request_id
trace_id
run_id
turn_id
step_id
tool_call_id
model_call_id
```

Expose structured logs.

Metrics:

```text
agent_runs_total
agent_failures_total

tool_calls_total
tool_latency_ms
tool_error_total

llm_calls_total
llm_latency_ms
llm_tokens_total
llm_cost_estimate

approval_wait_ms

memory_latency_ms

verification_failures_total
replan_total

sse_disconnect_total
sse_reconnect_total
```

Make sure sensitive user data is not logged accidentally.

---

# 16. Phase P3 — Authentication and authorization

Before adding powerful tools:

Add identity abstraction:

```text
UserIdentity
```

Do not make `session_id` the only security boundary.

The system should eventually support:

```text
user_id
session_id
run_id
tenant_id (if multi-user)
```

Policy evaluation should know who owns a run.

Audit sensitive operations.

---

# 17. Phase P3 — Audit log

Audit events for:

```text
tool execution
approval requested
approval granted
approval denied
memory created
memory deleted
policy denial
authentication
run cancellation
high-impact action
```

Do not store secrets in audit logs.

Use append-only semantics where practical.

---

# 18. Phase P4 — New capabilities

Only after the runtime is hardened.

Potential capabilities:

```text
RAG
browser
vision
database
filesystem sandbox
email
calendar
```

For each new tool:

1. explicit schema
2. capability requirements
3. risk classification
4. timeout
5. output limit
6. audit behavior
7. approval policy
8. evaluation cases
9. failure/retry semantics

Never add a tool with only a Python function and a model description.

---

# 19. Frontend-specific requirements

Do not regress the current graphics architecture.

Preserve:

- WebGPURenderer
- TSL
- fallback behavior
- adaptive quality
- reduced-motion support
- context-loss recovery
- visualization registry
- generic drill-down behavior
- pixel/UI testing

Add:

## Event v2 robustness

FE must:

- ignore duplicate sequence
- handle stale run
- recover from reconnect
- display structured run failure
- handle cancellation
- handle waiting approval
- handle budget exceeded

## Semantic accessibility

Each visualization should eventually provide:

```text
aria summary
semantic description
key values
important anomalies
```

Example:

```text
"Network topology with 8 nodes and 12 links.
Database node has highest centrality."
```

The 3D visual must not be the only way to understand the result.

---

# 20. Frontend performance requirements

Do not optimize blindly.

Maintain or improve:

```text
stable FPS
low React rerender rate
GPU efficient particles
instancing
adaptive DPR
reduced motion
software renderer fallback
```

Add performance regression thresholds to CI where practical.

Track:

```text
first render
scene init
shader compile
frame time
FPS
memory
context loss
```

Do not fail CI due to minor machine-to-machine FPS variance. Use statistically reasonable thresholds.

---

# 21. Deployment architecture

Keep deployment independent even though code is in one repository:

```text
Git repository
     |
     +---- frontend -> Vercel
     |
     +---- backend  -> Render/other service
```

Do not merge backend runtime into Next.js merely for repository convenience.

Production backend should eventually support:

```text
multiple workers
shared state
distributed approval
durable run storage
```

Until then, clearly label the deployment as single-instance/prototype.

---

# 22. Do NOT do these things

Claude Code must avoid the following unless explicitly requested:

- rewrite the entire backend framework
- migrate away from FastAPI without reason
- replace Three.js/R3F
- replace WebGPU/TSL with old GLSL
- introduce a heavy workflow framework just for planning
- add Redis before creating a storage abstraction
- add 20+ tools before capability security exists
- add multiple agents just because multi-agent is fashionable
- remove approval gates for convenience
- let the model decide its own permissions
- let visualization models emit arbitrary code
- store raw secrets/tokens in events or memory
- make frontend directly call internal tool APIs
- duplicate contract definitions without tests
- weaken tests to make a change pass

---

# 23. Suggested implementation order

Use this order unless repository inspection reveals a blocking dependency:

```text
STEP 1
Shared contracts
        ↓
STEP 2
Events v2 complete on FE + BE
        ↓
STEP 3
Root developer commands
        ↓
STEP 4
Full-stack CI + contract tests
        ↓
STEP 5
Durable AgentRun / AgentStep abstractions
        ↓
STEP 6
Cancellation + timeout + budget
        ↓
STEP 7
Storage abstraction + Redis implementation
        ↓
STEP 8
Reconnect/resume SSE
        ↓
STEP 9
Policy/capability engine
        ↓
STEP 10
Evidence model
        ↓
STEP 11
Verification + replan
        ↓
STEP 12
Memory policy + memory layers
        ↓
STEP 13
Evaluation suite
        ↓
STEP 14
Observability
        ↓
STEP 15
Auth + audit
        ↓
STEP 16
New tools / RAG / browser / vision
```

---

# 24. Definition of Done for P0

P0 is complete only when all are true:

- [ ] FE and BE use one canonical contract source
- [ ] Events v2 fully parsed by FE
- [ ] BE validates outbound events
- [ ] duplicate/stale events are handled
- [ ] root commands exist
- [ ] frontend tests pass
- [ ] backend tests pass
- [ ] contract tests pass
- [ ] full-stack SSE integration test passes
- [ ] critical E2E passes
- [ ] docs no longer claim BE is a separate repository
- [ ] local setup is documented and reproducible

---

# 25. Definition of Done for P1

- [ ] AgentRun is first-class
- [ ] AgentStep is first-class
- [ ] cancellation exists
- [ ] timeout exists
- [ ] cost/token budget exists
- [ ] policy engine exists
- [ ] capability checks exist
- [ ] storage abstraction exists
- [ ] distributed store can replace in-memory store
- [ ] SSE reconnect/resume exists
- [ ] approval works across workers in integration tests

---

# 26. Definition of Done for P2

- [ ] evidence objects exist
- [ ] claims can cite evidence
- [ ] verifier exists
- [ ] bounded re-planning exists
- [ ] memory policy exists
- [ ] memory provenance exists
- [ ] semantic/episodic/preference memory are distinguishable
- [ ] visualization planner has semantic intent
- [ ] model routing is observable
- [ ] evaluation suite measures decision quality

---

# 27. Definition of Done for production beta

A production-beta claim should require:

- [ ] shared durable state
- [ ] multi-worker safe approval
- [ ] authentication
- [ ] authorization/capabilities
- [ ] audit logs
- [ ] structured error model
- [ ] reconnectable runs
- [ ] cancellation
- [ ] budget controls
- [ ] metrics/tracing
- [ ] evaluation regression suite
- [ ] load test
- [ ] security tests
- [ ] failure-mode documentation

---

# 28. How Claude Code should work

Before changing code:

1. Inspect current repository structure.
2. Inspect existing tests.
3. Inspect contract files.
4. Inspect agent/run/event implementation.
5. Inspect frontend SSE parser/store/state machine.
6. Confirm which parts of this plan are already implemented.
7. Do not recreate features that already exist.

For each phase:

```text
inspect
→ design minimal change
→ implement
→ add tests
→ run tests
→ review diff
→ update docs
```

At the end of each phase, report:

```text
implemented
tests added
tests run
known limitations
next recommended phase
```

Do not claim a phase is complete if tests are skipped.

---

# 29. Priority summary

## CRITICAL

```text
shared contracts
Events v2
full-stack CI
contract tests
root DX
documentation cleanup
```

## HIGH

```text
AgentRun
AgentStep
cancel
timeout
budget
policy engine
capabilities
durable state
SSE resume
evidence
verification
evaluation
```

## MEDIUM

```text
memory layers
model routing
observability
auth
audit
semantic visualization planner
```

## LATER

```text
RAG
browser
vision
database
email
calendar
filesystem
multi-agent
```

---

# 30. Final target

The target is NOT merely:

```text
beautiful 3D AI UI
```

and not merely:

```text
LLM + tools
```

The target is:

```text
Metallica
=
Reliable Agent Runtime
+
Safe Tool Execution
+
Durable Run State
+
Evidence/Verification
+
Memory
+
Streaming Protocol
+
GPU Visualization
+
Excellent Developer Experience
```

The existing visualization and WebGPU work should be preserved.

The next major engineering value should come from making FRIDAY:

```text
more reliable
more explainable
more measurable
more secure
more recoverable
and more intelligent
```

rather than simply adding more visual effects or more tools.
