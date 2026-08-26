# Testing

Metallica uses **Playwright Test for everything** — both pure unit tests and
browser-driven UI tests — so there is a single runner, config, reporter and
CI integration. There is no separate vitest/jest setup.

```bash
npm run test:unit    # fast: no browser, no server, no build
npm run test:ui      # full: production build + headless Chromium
npm run test         # both
npm run verify       # lint + typecheck + all tests (local CI gate)
```

## Projects (`playwright.config.ts`)

| Project | Files | Notes |
|---|---|---|
| `unit` | `tests/unit/**` | No browser or `webServer` — the config parses `--project=` itself so a unit-only run never boots the production server. |
| `ui` | `tests/ui/**` | Desktop Chrome, 1440×900, trace on failure, webServer runs `npm run build && npm run start`. |

Global settings: 120 s test timeout, 10 s expect timeout, retries 2 in CI,
workers 1, GitHub+HTML+list reporters.

## Unit project

### `store.spec.ts`

Drives the zustand store directly via `getState()/setState()`:

- initial state is idle with null answer/visualization/focus,
- happy-path walk through the machine succeeds,
- illegal edges refused (`idle→speaking`, `error→thinking`,
  `speaking→visualizing`),
- `error` reachable from all 8 working states, recovers **only** via `idle`,
- `setState` unguarded, `reset()` clears answer/visualization/focus,
- audio toggle persists, render backend defaults to `"webgl2"`.

### `vizPlanner.spec.ts`

Locks planner rule ordering and invariants across a 19-case table:

- `"show me the network topology"` → `network` (beats traffic rule),
- `"how is network traffic"` → `particle_flow`,
- `"compare requests per service"` → `bar_3d` (not topology),
- unmatched queries → `radial_gauge` fallback,
- case-insensitivity; every spec has a title + valid animation;
- `sampleSpec` exists for all 10 types with non-empty data;
- gauge values within 0–100; `summarize` distinct non-empty per type.

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
- Responsive at 1366×768 / 1920×1080 / 2560×1440; mobile 375×812 uses the
  simplified scene without overflow.
- Accessibility basics: labeled mic toggle, focusable input.

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
- clicking again releases focus,
- switching visualizations clears stale focus.

## CI (`.github/workflows/ci.yml`)

Triggers: push to main/master, any PR, manual dispatch. Concurrency group with
cancel-in-progress. Node 22, `NEXT_TELEMETRY_DISABLED=1`.

| Job | Steps | Budget |
|---|---|---|
| **static** ("Lint · Types · Unit") | npm ci → lint → typecheck → `test:unit` | 10 min |
| **ui** ("UI (WebGL)") | npm ci → cache Playwright browsers keyed on version → install chromium deps → cache `.next/cache` → `test:ui` (suite builds itself) | 40 min |

The `ui` job uploads `playwright-report/` (14 days) always and `test-results/`
traces on failure.
