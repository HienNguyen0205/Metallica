<div align="center">

# METALLICA // FRIDAY

**A holographic AI interface, rendered in real-time WebGL.**

A sci-fi style "FRIDAY" assistant hologram — pulsing AI core, orbital rings,
GPU particle fields, spatial HUD and ten types of 3D data visualizations —
built with Next.js 16, React Three Fiber and a spec-driven rendering architecture.

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Next.js](https://img.shields.io/badge/Next.js-16-black)
![React Three Fiber](https://img.shields.io/badge/react--three--fiber-9-7d4cdb)
![License](https://img.shields.io/badge/license-private-lightgrey)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Scripts](#scripts)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
  - [Spec-driven visualization contract](#spec-driven-visualization-contract)
  - [Guarded agent state machine](#guarded-agent-state-machine)
  - [Scene composition](#scene-composition)
  - [Rendering backends & graceful degradation](#rendering-backends--graceful-degradation)
- [Visualizations](#visualizations)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Performance Notes](#performance-notes)
- [Documentation](#documentation)

---

## Overview

Metallica is a single-page, full-viewport **holographic AI interface**: an
Iron-Man-esque FRIDAY hologram rendered live in the browser.

Ask it anything in the `ASK FRIDAY` bar and watch it work — the hologram walks
through a simulated agent pipeline (`thinking → searching → tool_execution →
processing → visualizing → speaking`), materializes a 3D data visualization
matched to your query, then speaks its answer. Every subsystem — core shader,
rings, particles, waveform, lights, camera rig and HUD — responds coherently
to the current state.

> There is no backend. The query pipeline is a deterministic demo stand-in:
> swap the timed waits for stream events from a real LLM agent and everything
> else stays identical.

## Features

- 🧠 **Agent state machine** — a guarded transition table (`zustand`) that
  makes illegal state changes impossible, with per-state looks for all 10 states.
- 🔮 **Holographic core** — 8 stacked layers: distorted energy sphere, wireframe
  lattice, fresnel + scanline shader shell, tilted ring system, one-draw-call
  GPU particle field (950 particles), instanced waveform ring (96 bars).
- 🎨 **3 custom GLSL materials** — fresnel hologram, dotted grid plane with
  radial ripples, GPU-animated particle field; all with WebGPU-safe fallbacks.
- 📊 **10 visualization types** — gauges, health rings, radar sweep, waveform,
  network graph, 3D line/bar charts, particle flow, globe, timeline — selected
  by a rules-based query planner via a typed `VisualizationSpec`.
- 🖱️ **Drill-down interaction** — click any metric node / chart element to lock
  a focus reticle onto it in 3D space.
- 🎥 **Cinematic post-processing** — Bloom, Depth of Field, radial Chromatic
  Aberration, Noise and Vignette, plus DOM-level scanlines, scan-bar sweep and
  vignette overlays.
- 🎛️ **Live telemetry** — FPS, worst-frame time, JS heap, downlink and camera
  vector sampled at 4 Hz outside React's render loop.
- 🔊 **Audio cues** — WebAudio oscillator blips per state change, no assets.
- ♿ **Accessibility & responsiveness** — WCAG AA contrast enforced by tests;
  mobile / `prefers-reduced-motion` falls back to a simplified scene.
- ⚙️ **WebGPU opt-in** — `NEXT_PUBLIC_WEBGPU=1` enables WebGPU with automatic
  WebGL2 fallback and software-renderer detection.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 16](https://nextjs.org) (App Router) · [React 19](https://react.dev) |
| 3D | [Three.js r185](https://threejs.org) · [@react-three/fiber 9](https://docs.pmnd.rs/react-three-fiber) · [@react-three/drei 10](https://github.com/pmndrs/drei) |
| Post-processing | [@react-three/postprocessing](https://github.com/pmndrs/postprocessing) |
| State | [Zustand 5](https://zustand.docs.pmnd.rs) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) (CSS-first `@theme`) |
| Language | TypeScript (strict) |
| Testing | Playwright Test (both unit and UI/E2E projects) |

## Getting Started

Requirements: **Node.js ≥ 20** (CI uses Node 22) and npm.

```bash
git clone https://github.com/OWNER/REPO.git metallica
cd metallica
npm install
npm run dev
```

Open <http://localhost:3000>. Type something into `ASK FRIDAY`, or use the
left/right dev rails to preview any of the 10 visualization types or 10 agent
states directly.

For a production build:

```bash
npm run build
npm run start
```

> **Note:** the scene needs a working WebGL2 context. On machines without a
> real GPU (e.g. CI runners), the app detects software renderers
> (SwiftShader/llvmpipe) and automatically skips expensive post passes.

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start the development server on `:3000`. |
| `npm run build` | Production build. |
| `npm run start` | Serve the production build. |
| `npm run lint` | ESLint (flat config, `eslint-config-next`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test` | Run all Playwright tests (unit + ui). |
| `npm run test:unit` | Unit project only — pure logic, no server/browser. |
| `npm run test:ui` | UI project only — drives a production build in headless Chromium. |
| `npm run test:headed` | UI tests with a visible browser. |
| `npm run test:debug` | UI tests in the Playwright inspector. |
| `npm run test:report` | Open the last HTML test report. |
| `npm run verify` | Full gate: lint + typecheck + all tests. |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_WEBGPU` | unset | Set to `1` to opt the scene into a WebGPU renderer (falls back to WebGL2 when unavailable). |

## Architecture

Full details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Highlights:

### Spec-driven visualization contract

Nothing in the app renders a component directly. A query is planned into a
serializable **`VisualizationSpec`** (type, data payload, animation, theme,
interaction, position/scale), and a registry maps each semantic
`VisualizationType` to its renderer:

```ts
// src/lib/store.ts — the renderer contract
export interface VisualizationSpec {
  type: VisualizationType;
  data?: VizData;
  animation?: "materialize" | "pulse" | "none";
  interaction?: "none" | "drill_down"; // "none" disables picking
  theme?: { color?: string; accent?: string };
  position?: [number, number, number];
  scale?: number;
  title?: string;
}
```

Today the planner (`src/lib/vizPlanner.ts`) is an ordered regex rule table;
tomorrow it can be replaced by an LLM function call that emits the same spec —
nothing downstream changes.

### Guarded agent state machine

The store exposes two mutators: `transition(next)` only accepts edges declared
in the transition table (illegal moves are silently ignored); `setState(next)`
is the unguarded escape hatch reserved for the developer rails. Error states
recover only through `idle`. See [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md).

### Scene composition

One route (`/`) mounts a single `<Canvas>` (dynamically imported, `ssr: false`)
containing: state-driven lights, an eased pointer-parallax `CameraRig`, the
in-scene `SpatialHud`, the 8-layer `FridayCore`, the active visualization, and
a post-processing stack (WebGL path only).

### Rendering backends & graceful degradation

- **WebGL2 by default**, WebGPU opt-in via env var.
- Software renderers detected → depth-of-field and heavy effects disabled.
- `(max-width: 768px)` or `prefers-reduced-motion` → reduced mode (lower DPR,
  fewer particles, simplified HUD).
- `webglcontextlost` → canvas rebuilt automatically via key remount.

## Visualizations

| Type | Trigger examples | Renderer |
|---|---|---|
| `radial_gauge` *(fallback)* | any unmatched query | Metrics orbiting the core with segmented fill arcs |
| `health_core` | *"system health"*, *"status"* | Dominant health ring pair around the core |
| `radar` | *"scan"*, *"search"*, *"threat"* | Flat sweep with positioned contact blips |
| `waveform` | *"voice"*, *"audio"* | Large 128-bar audio-reactive ring |
| `network` | *"topology"*, *"dependencies"* | Golden-angle sphere graph with edges |
| `particle_flow` | *"traffic"*, *"throughput"* | Outward-flowing GPU particle column |
| `globe` | *"where"*, *"region"* | Wireframe globe with lat/lon markers |
| `line_3d` | *"trend"*, *"over time"* | Depth-layered series over a hairline floor |
| `bar_3d` | *"compare"*, *"distribution"* | Instanced boxes growing along an arc |
| `timeline` | *"events"*, *"incident log"* | Horizontal axis with event ticks |

All visualizations support optional drill-down focus unless
`interaction: "none"`.

## Testing

Testing strategy and helper utilities are documented in
[`docs/TESTING.md`](docs/TESTING.md). Summary:

- **Unit project** (`tests/unit`) — runs the zustand store and the viz planner
  directly under Playwright's runner; no browser, no server, no build.
- **UI project** (`tests/ui`) — drives the production build in Chromium and
  asserts *pixel statistics*, not just DOM: center-weighted luma composition,
  cyan-ratio (is the hologram actually painting?), perceptible frame diffs,
  GL context health across all 10 states, ≥ 24 fps on real GPUs, WCAG AA
  contrast computed against the true background color, and response-flow
  ordering recorded via an in-page `MutationObserver`.
- **Drill-down tests** include their own world→screen projection math to click
  exact gauge nodes in 3D space.

```bash
npm run test:unit   # fast feedback loop (~seconds, no browser)
npm run verify      # full CI-equivalent gate locally
```

CI (`.github/workflows/ci.yml`) runs two jobs on every push/PR:
`static` (lint · typecheck · unit) → `ui` (cached Playwright install, WebGL
suite against the production build, report artifact uploaded).

## Project Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout — Geist fonts, metadata, typed LayoutProps
│   └── page.tsx                # "/" — Canvas + DOM HUD overlays
├── components/friday/
│   ├── Scene.tsx               # <Canvas>, camera rig, lights, postprocessing
│   ├── primitives.tsx          # ArcSegments, TickDial, Reticle, TechLabel, ...
│   ├── core/
│   │   ├── FridayCore.tsx      # 8-layer central hologram
│   │   ├── CoreRings.tsx       # Tilted ring & arc system
│   │   ├── CoreParticles.tsx   # One-draw-call GPU particle field
│   │   └── WaveformRing.tsx    # Instanced audio-reactive bars
│   ├── effects/materials.ts    # 3 custom shaderMaterials (+ JSX typings)
│   ├── hud/
│   │   ├── Hud.tsx             # TopHud, EdgeTelemetry, rails, AnswerLine, AudioCues
│   │   ├── InputBar.tsx        # ASK FRIDAY input
│   │   └── SpatialHud.tsx      # In-scene 3D HUD (grid, readouts, level columns)
│   └── visualization/
│       ├── FridayVisualization.tsx  # Spec → REGISTRY dispatch + DrillDown
│       ├── vizRadial.tsx        # Gauge, HealthCore, Radar, Waveform
│       ├── vizCharts.tsx        # LineChart3D, BarChart3D, Timeline3D
│       └── vizSpatial.tsx       # Network3D, Globe3D, ParticleFlow
└── lib/
    ├── store.ts                # Zustand store + guarded state machine + spec types
    ├── vizPlanner.ts           # Query → VisualizationSpec rules + samples + summaries
    ├── demoQuery.ts            # Timed simulated agent pipeline
    ├── stateLook.ts            # Per-state colors/motion/camera parameters
    ├── telemetry.ts            # rAF singleton: fps, frames, heap, camera
    ├── uiSound.ts              # WebAudio state blips
    └── rendererBackend.ts      # WebGPU detection + WebGL2 fallback
tests/
├── unit/                       # Store & planner logic (no browser)
└── ui/                         # Pixel-statistics & interaction suites (Chromium)
```

## Performance Notes

- **Draw-call discipline** — particles are a single `<points>` draw call with
  all motion computed in the vertex shader; arcs, ticks and bars are instanced.
- **Telemetry off the hot path** — one shared rAF loop measures counters in
  500 ms windows; React re-samples at 4 Hz instead of per frame.
- **Adaptive quality** — `AdaptiveDpr` + `AdaptiveEvents`; reduced mode caps
  DPR at 1.25 and drops particle count from 950 to 260.
- **Post-processing gated** — DoF disabled on reduced motion and software GL;
  the entire composer is skipped on the WebGPU path.

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Full walkthrough: layers, shaders, scene graph, data flow. |
| [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) | Transition table, per-state look parameters, design rationale. |
| [`docs/TESTING.md`](docs/TESTING.md) | Test projects, pixel-statistics helpers, CI pipelines. |

---

<div align="center">
<sub>Built with Next.js 16 · React Three Fiber · Zustand · Tailwind CSS 4</sub>
</div>
