# Design: Demo-wow viz (funnel_3d + sankey_flow) + public-link hardening

Date: 2026-09-10. Status: drafted, awaiting spec review.
Goal (locked in chat): Demo wow → public link (Vercel + Render free) → viz mới.
Approach (locked): A + hardening tối thiểu của B. No live-real-data work (option C deferred).

## Context

Metallica renders 11 viz types through one contract (`src/lib/visualization/types.ts`
→ `normalization.ts` → `REGISTRY` in `FridayVisualization.tsx` → `layoutResolver.ts`).
The scene, planner, and tests are in good shape, but a public-link demo has three
load-bearing traps:

1. `NEXT_PUBLIC_FRIDAY_API` is baked at build time. Unset on a deploy → bundle points
   at `localhost:8000` → fetch fails → offline regex planner answers with canned numbers
   (`820 megabits`, `87%`) while only `console.error` says so (`fridayClient.ts:warnIfMisconfigured`).
2. Render free sleeps after 15 min idle → first query sits in `THINKING` 30–60 s, reads as hung.
3. `get_system_metrics` on a deploy measures the 512 MB / 0.1 CPU container, not the laptop.

Adding viz types today touches 5 places (FE type + `REGISTRY` + FE planner + backend
`schema.py` + `sampleSpec`/tests/docs). A mismatch renders nothing (`if (!Renderer) return null`),
silently. This spec keeps the change surface minimal and explicit.

## §1 — Contract (no `VizData` change)

```ts
// src/lib/visualization/types.ts — only this union grows:
export type VisualizationType =
  | "radial_gauge" | "health_core" | "radar" | "waveform"
  | "network" | "line_3d" | "bar_3d" | "particle_flow"
  | "globe" | "timeline" | "heatmap_3d"
  | "funnel_3d"     // NEW — reads data.metrics
  | "sankey_flow";  // NEW — reads data.nodes + data.links
```

Deliberately no new `VizData` fields:

- `funnel_3d` reads `metrics: { label, value (0–100 after normalize), unit? }[]`.
  Funnel stages already are labeled magnitudes — exactly what `metrics` is.
- `sankey_flow` reads `nodes: { id, label? }[]` + `links: [a, b][]`, uniform width
  in v1. Weighted flows are an explicit non-goal (see §7); uniform + animated flow
  dots still read as Sankey on stage.

`normalization.ts` needs no new sanitizer: metrics clamping, node id fallback
(`node-N` so link indices never shift), OOB link dropping, and title/scale/theme
handling already cover both. Unknown-type guard in `VizNode` stays as-is.

Backend `schema.py` (separate repo) adds the same two enum values. Until it does,
the backend never emits them; the FE planner and `?viz=` deep-link ( §4) are the
only producers. Wire shape is unchanged, so old backends keep working.

## §2 — Renderers (one new file, existing idioms only)

New file `src/components/friday/visualization/vizFlow.tsx` exporting `Funnel3D` and
`SankeyFlow`. No new dependencies, no GLSL strings, no new materials — boxes,
`HairLine`, `TechLabel`, `useMaterialize`, `STATE_LOOK` colors only.

**`Funnel3D({ metrics = DEFAULT_FUNNEL, color, accent })`**

- Layout: vertical stack centered at `CHART_ANCHOR`-equivalent `[0, 0.45, 1.1]`,
  stage height 0.32, gap 0.14. Width `= 0.6 + 3.2 * (v / max)` so the bottom never
  vanishes. Max 6 stages; beyond that render first 6 + dev-only `console.warn`
  (same idiom as `BAR_GROUP_MAX` in `vizCharts.tsx`).
- Each stage: one `boxGeometry` mesh (transparent 0.72, `toneMapped={false}`,
  `depthWrite={false}`), cold→hot lerp `color→accent` by `v/max`, value `TechLabel`
  right, stage label left with `decode`, conversion `TechLabel` under it defined as
  `round(current / previous * 100)` with `% OF PREV` (first stage shows `100% · TOP`).
- Drill-down: invisible hit box per stage with
  `userData.viz = { label: STAGE, detail: "62 · 62% OF TOP" }` — generic `DrillDown`
  untouched.
- Animation: `useMaterialize(0.8)` + grow-in via per-stage scale.x ease (mirrors
  `BarChart3D` grown loop, stops at 1 so no per-frame upload forever).

**`SankeyFlow({ nodes = DEFAULT_SANKEY_NODES, links, color, accent })`**

- Layout: columns by BFS depth from source nodes (no incoming links); `x = depth * 2.4`
  centered, `y` spread evenly per column at `z = 1.1` plane. Deterministic, no force
  pass. Cycles: BFS carries a visited set; already-visited nodes keep their first depth
  instead of looping. Caps: 12 nodes / 28 links; overflow → first N + dev-only warn.
- Nodes: octahedron (0.11) + ring + `TechLabel` below — same visual language as
  `Network3D` so the scene stays coherent. Edges: `HairLine` opacity 0.28 + 1 flow
  dot per edge (small sphere, `useFrame` param `t = (time * speed + offset) % 1`
  lerped along the segment). Reduced-motion: dots static at midpoint.
- Drill-down: node hit spheres carry `userData.viz = { label, detail: "NODE ONLINE" }`;
  edges are not pickable in v1 (avoids tiny-target frustration).

`REGISTRY` gains two lines; `resolveVisualizationLayout` scaleMap gains
`funnel_3d: 1.0, sankey_flow: 0.95`. Everything else (Entrance, Pulse, Title,
FocusMarker, focus-clear on `vizKey`) is reused unchanged.

## §3 — Planner (order matters)

Append to `RULES` in `src/lib/vizPlanner.ts` **before** `bar_3d`/`network` (both would
otherwise swallow the new triggers):

```ts
{ type: "funnel_3d",
  match: /funnel|conversion|pipeline stages|drop.?off|signup flow/i,
  build: () => ({ type: "funnel_3d", title: "CONVERSION FUNNEL", animation: "materialize",
    data: { metrics: [
      { label: "VISIT", value: 100 }, { label: "SIGNUP", value: 62 },
      { label: "ACTIVATE", value: 44 }, { label: "PAY", value: 27 } ] } }) },
{ type: "sankey_flow",
  match: /sankey|flow between|from .* to .* through|energy flow|budget flow/i,
  build: () => ({ type: "sankey_flow", title: "FLOW MAP", animation: "materialize",
    data: { nodes: [ {id:"a",label:"ADS"},{id:"b",label:"SIGNUP"},{id:"c",label:"PAY"},
                     {id:"d",label:"CHURN"} ],
             links: [[0,1],[1,2],[1,3]] } }) },
```

Ordering traps locked by tests: `"signup flow conversion"` → `funnel_3d` (not `bar_3d`
via "flow"); `"flow between services"` → `sankey_flow` (not `particle_flow` via "flow"
nor `network` via "services"). `sampleSpec` gains both types; `summarize` gains:

- funnel: `"Funnel drops hardest at activate — 44 of 100 visits remain."`
- sankey: `"Three flows live. The largest runs ads to signup."`

## §4 — Public-link hardening (minimal, demo-honest)

Four small FE-only changes; no infra, no new endpoint:

1. **LiveBadge (TopHud):** render derived status as text always during/after a turn —
   `LIVE` (cyan, when `liveMode==="live"`) / `DEMO` (amber, when `liveMode==="offline"`) /
   `CONNECTING` (pulsing, immediately on `liveMode==="connecting"`, relabeled `WAKING…`
   after 2 s via local timeout so a 30 s cold start reads as warming, not hung) /
   `REFUSED` (red, when `sessionError` is set by an `OrchestratorRefused` — not a new
   `LiveMode` value; the store union stays `connecting|live|offline|idle`). Today the
   mode exists in the store but is easy to miss on a shared screen.
2. **Misconfig banner:** promote `warnIfMisconfigured()` from `console.error`-only to
   a one-line DOM banner (`UNSPECIFIED BACKEND — SHOWING DEMO DATA`) when
   page host is public and API host is local. Dismissible, never blocks input.
3. **Warm ping:** on first mount, `GET {API}/health` (no model cost) to wake Render
   early; failure is silent (offline path already handles it). Shows `WAKING…` so a
   30 s cold start reads as warming, not hung.
4. **`?viz=` deep-link:** the client island (via `useSearchParams`, not the
   `force-dynamic` server shell) reads `?viz=funnel_3d|sankey_flow|<existing>`,
   renders `sampleSpec(type)` with `liveMode="offline"` + `DEMO` badge, no fake
   typing animation. Lets the speaker jump to the new viz in one click without
   pretending it is a live answer. Unknown value → ignored (today's idle screen).

Explicitly not in this spec: auto-tour sequencer, real-metrics proxy, latency
overlay, share/export snapshot.

## §5 — Layout, motion, a11y

- Single viz centered (existing branch); multi-viz fan unchanged — new types use the
  same `count/index` path so a funnel + bar pair fans like any other pair.
- `prefers-reduced-motion` / mobile reduced mode: flow dots static, funnel grow-in
  instant, particle counts follow existing caps (no new constants).
- Contrast: labels `#e5f6ff` on `rgb(2,5,10)` already pass AA per `textContrast()`;
  new labels reuse the same sizes (≥ 0.06) and opacities (≥ 0.7) so no new contrast
  risk. Input keeps `aria-label="Ask FRIDAY"`; badge uses `role="status"`.

## §6 — Testing

- Unit (`tests/unit/vizPlanner.spec.ts` extension): new ordering traps above,
  case-insensitivity, every `sampleSpec` has title + valid animation + non-empty
  data; funnel metrics within 0–100; sankey links in-range.
- Unit (`vizNormalize`/`vizLifecycle`): no new cases needed beyond type-union
  coverage — assert normalize passes funnel/sankey specs through unmutated and
  caps still hold at 3 entries.
- UI (`tests/ui/hologram.spec.ts` pattern): each new type differs > 1% pixels from
  idle baseline, mounts/unmounts with intact GL context, ≥ 24 fps gate unchanged
  (software-GL asserts liveness only).
- UI (badge/link): stub-unreachable run shows `DEMO` badge; `?viz=funnel_3d` renders
  title `CONVERSION FUNNEL` without any fetch; misconfig banner appears when page
  is public + API is local (fake hosts via query override in test).
- Drill-down: click funnel stage / sankey node locks `FOCUS · …` in edge telemetry;
  switching viz clears focus (existing `vizKey` effect covers it).

## §7 — Non-goals (deferred, not forgotten)

Weighted sankey links, funnel stage images/icons, auto-play tour, metrics proxy that
reports the viewer's machine, RAG/vision/new tools, export PNG/CSV, voice changes,
PostFX retune. Each would grow `VizData`, cost model calls, or need infra — wrong
for a free-tier public demo.

## Open items for the backend owner (separate repo)

Add `"funnel_3d"`, `"sankey_flow"` to the `VisualizationPlan` type enum in
`friday/schema.py` with the same data fields (`metrics` / `nodes+links`). No transport
change. Until then the FE planner is the sole producer — by design, not a drift.
