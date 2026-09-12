# Testing

Metallica uses **Playwright Test for everything** — both pure unit tests and
browser-driven UI tests — so there is a single runner, config, reporter and
CI integration. There is no separate vitest/jest setup.

```bash
npm run test:unit       # fast: no browser, no server, no build
npm run test:frontend   # same as test:unit — the frontend half
npm run test:backend    # whole Python suite via backend/runtests.py
npm run test:contracts  # contract gate: FE specs + BE test_contracts.py
npm run test:e2e        # full: production build + headless Chromium (test:ui alias)
npm run test           # all Playwright tests (unit + ui)
npm run verify         # full gate: lint + typecheck + frontend + backend + contracts + e2e
```

## Projects (`playwright.config.ts`)

| Project | Files | Notes |
|---|---|---|
| `unit` | `tests/unit/**` | No browser or `webServer` — the config parses `--project=` itself so a unit-only run never boots the production server. |
| `ui` | `tests/ui/**` | Desktop Chrome, 1440×900, trace on failure, webServer runs `npm run build && npx next start -p 3100`. |

Global settings: 120 s test timeout, 10 s expect timeout, 30 s action timeout
for UI actions, retries 2 in CI, workers 1, GitHub+HTML+list reporters.

The action timeout is the fail-fast bound: without it every action inherits
the 120 s test timeout, so a systemically dead page (no canvas, hung server)
costs ~6 min per test (120 s × 3 attempts) and the shards die at the job
limit with nothing completed. 30 s is generous — real actions take
milliseconds, and every legitimately long poll (`waitForHologram`, flow
recording) passes an explicit timeout that overrides it.

## Unit project (`tests/unit/` — 24 specs)

### `store.spec.ts` / `agentFlow.spec.ts` / `agentStream.spec.ts`

Drives the zustand store directly via `getState()/setState()`:

- initial state is idle with null answer/visualization/focus,
- happy-path walk through the machine succeeds,
- illegal edges refused (`idle→speaking`, `error→thinking`,
  `speaking→visualizing`),
- `error` reachable from all 8 working states, recovers **only** via `idle`,
- `setState` unguarded, `reset()` clears answer/visualization/focus,
- audio toggle persists, render backend defaults to `"webgl2"`,
- `endTurn` lands idle silently (no illegal-transition noise),
 - live stream dispatches state/viz/answer then lands idle; 429 refusal never
   falls back to the canned planner; unreachable orchestrator uses offline
   planner; interrupted/early-ended streams surface errors with `liveMode`
   reset to `idle`; aborting mid-fallback stops the local run before it
   paints anything.

### `vizPlanner.spec.ts` / `vizNormalize.spec.ts` / `vizLifecycle.spec.ts` / `vizFocus.spec.ts`

Locks planner rule ordering and invariants:

- `"show me the network topology"` → `network`,
- `"compare requests per service"` → `bar_3d` (not topology),
- unmatched queries (incl. former `particle_flow`/`radar`/`heatmap_3d`
  triggers) → `radial_gauge` fallback,
- case-insensitivity; every spec has a title + valid animation;
- `sampleSpec` exists for all 10 types with non-empty data (timeline/globe
  ship minimal events/points so empty axes never pass);
- gauge values within 0–100; `summarize` distinct non-empty per type,
 - normalization never mutates input, coerces non-finite metrics, coerces
   wire labels/ids/units to non-empty strings (metrics/events without one are
   dropped; node ids fall back to `node-N` so `links` indices never shift),
   sanitizes colors/scale/position/title, drops OOB links, respects partial overrides,
- lifecycle keeps at most 3 visualizations (bulk `setVisualizations` capped),
  settle by stable id survives eviction,
- `nextFocus` pure move/release semantics tested without a browser.

### Other unit specs

`sse` (chunk splits, CRLF, comments, abort), `events` (rejects unknown
states/risks/viz), `eventContract` + `contracts` (canonical schemas ↔
parser parity, incl. the funnel/sankey drift fix), `envelopedFlow` (full v2
turn, rejection surfacing, server-cancel, resume-from-log), `agentStream`
(duplicate/wrong-run/step handling), `streamGuard` (ordering verdicts),
`store` (guarded transitions), `sessionBanner`, `coreDock`, `vizBarGroups`,
`vizFlow` (funnel/sankey math), `ttsPlayer` (header parse, truncation,
abort, backpressure, 30 s anti-hang timeout), `audioBus` (TTS-first
fallback, FFT mapping, mic lifecycle), `gpu` (shared software-GL
classifier), `quality` (heavy truth table), `labelCapacity` (texture never
clips), `spriteGeometry` (shared geometry never disposed).

## UI project

UI tests assert what actually reaches the screen — including pixels — not just
DOM presence. All suites run against the production build.

### Pixel & GL helpers (`tests/ui/helpers.ts`)

Because Tailwind v4 emits oklab colors that can't be regex-parsed from CSS,
contrast math composites the element color over the known background
(`rgb(2,5,10)`) on an offscreen canvas and computes WCAG relative luminance.

| Helper | Purpose |
|---|---|
| `shot()` / `regionStats()` | Screenshot pixel stats: mean luma + "cyan ratio" classifier |
| `diffRatio()` | Fraction of perceptibly changed pixels between frames |
| `textContrast()` | WCAG contrast ratio for HUD elements |
| `waitForHologram()` | Polls center-region luma > 20 instead of fixed sleeps |
| `recordFlow()` / `readFlow()` | In-page MutationObserver timestamping `hud-state` + `answer-line` changes — catches sub-second states |
| `glRenderer()` / `isSoftwareGL()` | Detects SwiftShader/llvmpipe to relax perf assertions |

### Suites

**`friday.spec.ts` — composition & UX acceptance**

- Canvas fills viewport; page never scrolls; zero dashboard chrome
  (no nav/aside/sidebar/card/table).
- WCAG AA (≥ 4.5:1) contrast for nine named HUD elements.
- All ten states reflected in the HUD label via the dev state rail.
- **Response-flow ordering:** submitting *"system health"* records a state
  sequence that passes THINKING → SEARCHING → TOOL EXECUTION → VISUALIZING →
  SPEAKING in order, with the answer text appearing only after VISUALIZING.
- **STREAMING_FLOW (§18):** stub orchestrator streams preview → viz → answer →
  done over SSE on `:8123`; answer text pinned (`73 percent`) so a stub-bind
  failure cannot silently downgrade to the offline fallback.
- **Confirm flow:** high-risk tool shows `alertdialog` with focus trap + ESC;
  failed button delivery keeps the gate open instead of dismissing as denied,
  while ESC delivers a deny fire-and-forget (unblocks the orchestrator now
  instead of after 120 s of silence) and still dismisses locally.
- **Voice:** mic rail guarded (`listening → thinking`), TTS-first speak with
  synthesis fallback; stub `ttsRequests` asserted per-test.
- Responsive at 1366×768 / 1920×1080 / 2560×1440; mobile 375×812 uses the
  simplified scene without overflow (mobile AUDIO toggle in TopHud).
- Accessibility basics: labeled input (`aria-label="Ask FRIDAY"`), mic toggle
  with 24px hit target, focusable input, atomic live regions.

**`hologram.spec.ts` — render health**

- Hologram actually paints: center luma > 12 and cyan ratio > 0.5%.
- Centre-weighted composition: center luma > 2× corner luma.
- Idle animation alive: > 0.1% pixels change within 700 ms.
- Each of the 10 visualization types differs > 1% from the idle baseline.
- Cycling all 10 states produces zero console/page errors and an intact GL
  context; all vizzes mount/unmount cleanly without context loss.
- ≥ 24 fps on real GPUs (software-GL CI runners assert liveness only).

**`drilldown.spec.ts` — interaction**

Contains its own world→screen pinhole projection of gauge node coordinates so
it can click exact metric nodes in 3D space:

- clicking CPU/RAM/DISK/NET nodes locks focus (visible as `FOCUS · …` in edge
  telemetry),
- switching visualizations clears stale focus.
- release-on-second-click is intentionally untested (flaky via dynamic 3D
  coordinates — see `drilldown.spec.ts` comments); the wiring lives in
  `FridayVisualization.tsx` (`onClick`/`onPointerMissed`).

**`memoryRail.spec.ts` — long-term memory**

- `/memory` rows validated (malformed rows dropped, never render `undefined`);
- operator review + FORGET flow deletes permanently (backend RAM cache too).

**`dock.spec.ts` + `groupedBars.spec.ts` — layout & charts**

- docked core clears the center when a viz owns the stage;
- grouped bars spread symmetrically and stay within one category slot.

## Backend tests (`backend/tests/` — via `backend/runtests.py`)

No pytest: every `test_*.py` runs standalone with `PYTHONPATH=backend`, and
`runtests.py` discovers and runs all of them (unit, then integration), so a
new file can never be silently skipped by CI. From the repo root:
`npm run test:backend`; filtered: `python backend/runtests.py test_contracts`.

Areas mirror `backend/README.md` §Tests: contracts, runs/steps, transport and
permissions, memory (+policy), persistence, evidence/verification, cancel and
budgets, reconnect, observability, identity/audit, tools, search, provider —
plus `test_evals.py`, the decision-quality gate over `backend/evals/` (12+
scripted cases with must/must-not-call sets, approval, memory and claim
assertions; model scripted, no key, no network).

## CI (`.github/workflows/ci.yml`)

Triggers: push to main/master, any PR, manual dispatch. Concurrency group with
cancel-in-progress. Node 22, `NEXT_TELEMETRY_DISABLED=1`.

| Job | Steps | Budget |
|---|---|---|
| **static** ("Lint · Types · Unit") | npm ci → lint → typecheck → `test:unit` | 10 min |
| **backend** ("Orchestrator (Python)") | pip install → `runtests.py unit` → `runtests.py integration` | 10 min |
| **contracts** ("FE consumer · BE producer") | npm ci + pip install → `test:contracts` | 10 min |
| **ui** ("UI (WebGL)") | npm ci → cache Playwright browsers keyed on version → install chromium deps → cache `.next/cache` → `test:ui` (suite builds itself) | 30 min |

The `ui` job uploads `playwright-report/` (14 days) on every non-cancelled
run and `test-results/` traces on `always()` — a timed-out job concludes
`cancelled`, yet each test that died before the kill already wrote its
trace, so the partial evidence is kept instead of skipped. (Artifact dirs
are `mkdir -p`'d first so the upload never fails on a missing path.)
