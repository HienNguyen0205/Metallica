# GLOBE implementation notes

Upgrade of the `GLOBE` visualization from a cyan wireframe sphere to a
realistic, interactive Earth, per
`docs/Metallica_Globe_ClaudeCode_Implementation_Guide.md`.

## What changed

- **Contract (additive only):** `GeoPoint` gains `id/value/status/color/metadata`;
  `VizData` gains `routes: GlobeRoute[]` (`from`/`to` reference points by
  id → label → index). `links` semantics untouched. Old specs still render.
- **Normalization** (`src/lib/visualization/normalization.ts`): points keep
  their length with clamped lat/lon (routes can index into the array);
  routes are shape-validated, endpoint resolution happens at render.
- **Demo data** (`src/lib/vizPlanner.ts`): 6 markers (SFO/FRA/SIN/TYO/SYD/LON)
  with latency/traffic telemetry + 4 routes; `summarize("globe")` is now
  generated from the data (slowest region, degraded count).
- **New renderer** (`src/components/friday/visualization/globe/`):
  - `geo.ts` — canonical `latLonToVector3` (0° lon → +X, +Y north), log-scale
    metric normalization, slerp arcs with altitude profile, route resolution,
    `markerDetail`/`markerWhy`, `toAccessibleSummary`, quality resolver.
    Pure logic, covered by `tests/unit/globeGeo.spec.ts`.
  - `GlobeEarth.tsx` — procedural TSL Earth (continents/detail/ice/night
    speckle), fresnel atmosphere shell, drifting cloud shell, faint wireframe
    overlay. No binary assets (see `public/assets/globe/ASSETS.md`).
  - `GlobeMarkers.tsx` — size↔value, color↔status markers with halo, labels,
    hover/selected emphasis, focus dimming, alert pulse.
  - `GlobeRoutes.tsx` — slerp arcs (`HairLine`, TSL-compatible) + capped
    direction particles; thickness↔traffic, color↔status.
  - `useGlobeInteraction.ts` — drag rotate with inertia/damping, tilt clamp,
    wheel/pinch zoom, idle auto-rotate (pauses on input, resumes ~4s),
    double-click/keyboard focus with eased transitions, reset. Owns only the
    planet group's rotation/scale — the camera rig is untouched.
  - `GlobeVisualization.tsx` — `Globe3D` composition: fixed sun
    (terminator stays while the planet turns), staggered entrance,
    state-driven spin/particle speed, empty-state + node/route count line with
    `SOURCE LIVE/SIMULATED` from the store.
- **Registry** (`FridayVisualization.tsx`): globe entry now passes
  `data.routes`; old `Globe3D` removed from `vizSpatial.tsx`.

## Deliberate deviations from the guide

- **Procedural surface instead of texture maps** (§7/§45): license-safe,
  zero async loading. The palette was first authored in teal (§48), then
  reworked to an Earth-from-space look (blue oceans, climate-zoned land,
  ice caps) per operator request — the holographic framing (atmosphere rim,
  faint wireframe, HUD, mini core) keeps the Metallica identity.
- **No country borders in v1** (§12): without a vendored GeoJSON this would
  need a new binary asset + fetch path; the quality config already reserves
  the `borders` flag for it.
- **DOM a11y via existing surfaces** (§40): `toAccessibleSummary` feeds the
  same data-driven copy as `summarize` (AnswerLine) and per-marker detail
  reaches screen readers through `FocusPanel` on drill-down.

## Verification

- `npx playwright test --project=unit` — all green incl. 15 new globe tests.
- `npm run typecheck`, `npm run lint`.
- UI: existing `hologram.spec.ts` "every viz type renders something different"
  covers GLOBE distinctly; `dock.spec.ts` exercises the GLOBE rail button.
