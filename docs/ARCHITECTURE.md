# Architecture

This document walks through how Metallica is put together: the data flow, the
rendering layers, the custom shaders, and every deliberate performance and
compatibility decision.

```
                    ┌──────────────────────────────────────────────┐
   user query       │  InputBar ──▶ runQuery (demoQuery.ts)        │
  ─────────────────▶│      │                                        │
                    │      ▼        guarded transition()            │
                    │  zustand store  ◀── setState (dev rails)      │
                    │  state · answer · visualization · focus       │
                    │      │                                        │
                    │      ├──────────────┬────────────────┐        │
                    │      ▼              ▼                ▼        │
                    │  DOM HUD        FridayCore     FridayVis     │
                    │  (Hud.tsx)      + SpatialHud    (REGISTRY)    │
                    │                 + lights/camera rig           │
                    └──────────────────────────────────────────────┘
```

## 1. Layers

The application has four cooperating layers:

| Layer | Location | Responsibility |
|---|---|---|
| **State** | `src/lib/store.ts` | Single source of truth: agent state machine, current answer, current `VisualizationSpec`, drill-down focus, render backend, audio flag. |
| **Logic** | `src/lib/vizPlanner.ts`, `demoQuery.ts`, `stateLook.ts` | Pure functions mapping queries → specs, states → looks, and simulating the agent pipeline. |
| **3D scene** | `src/components/friday/**` | The R3F canvas: core hologram, particles, rings, waveform, spatial HUD, visualization registry, shaders, post-processing. |
| **DOM HUD** | `src/components/friday/hud/Hud.tsx` | Everything above the canvas: top bar, edge telemetry, dev rails, answer line, input bar. |

`src/app/page.tsx` composes them in one client component; the `<Canvas>` is
dynamically imported with `ssr: false` because WebGL requires a real browser
context.

## 2. State management (`src/lib/store.ts`)

A single Zustand store holds everything the UI needs:

```ts
interface FridayStore {
  state: FridayState;
  answer: string | null;
  visualization: VisualizationSpec | null;
  focus: VizFocus | null;
  renderBackend: RenderBackend;
  audioEnabled: boolean;

  transition(next: FridayState): void; // guarded — see below
  setState(state: FridayState): void;  // unguarded — dev rails only
  setAnswer(v: string | null): void;
  setVisualization(spec: VisualizationSpec | null): void;
  setFocus(focus: VizFocus | null): void;
  setRenderBackend(b: RenderBackend): void;
  toggleAudio(): void;
  reset(): void;
}
```

### Why a guarded state machine?

`transition()` consults a static transition table:

```ts
const TRANSITIONS: Record<FridayState, FridayState[]> = { ... };
transition: (next) => {
  if (TRANSITIONS[get().state].includes(next)) set({ state: next });
};
```

Illegal edges are *silently ignored*, so a race between two async producers
can never corrupt the pipeline (e.g. a late "speaking" arriving after reset).
`setState` exists only for the developer rail that previews any state's look.

See [STATE_MACHINE.md](STATE_MACHINE.md) for the full table and rationale.

## 3. The query pipeline

`runQuery(store, query)` in `demoQuery.ts` simulates an agent:

1. clears `answer` / `visualization`,
2. walks `thinking → searching → tool_execution → processing` with timed waits,
3. at `visualizing`: sets the spec from `planVisualization(query)`,
4. at `speaking`: sets the spoken answer from `summarize(spec)` — the hologram
   materializes **before** the text appears,
5. after ~3.6 s returns to `idle` and clears everything.

The design contract: this module owns all timing. Replace its `wait()` calls
with stream events from a real agent backend and nothing else changes.

## 4. Spec-driven visualizations

`vizPlanner.ts` is pure and deterministic:

- `planVisualization(query)` — ordered rule table, most specific first.
  Example ordering trap covered by tests: *"show me the network topology"* must
  yield `network`, but *"how is network traffic"* must yield `particle_flow`.
- `sampleSpec(type)` — canonical demo spec per type (used by the dev VizRail).
- `summarize(spec)` — one canned sentence per type for the speaking phase.

`FridayVisualization.tsx` dispatches via a flat registry:

```ts
const REGISTRY: Record<VisualizationType, ComponentType<VizProps>> = {
  radial_gauge: RadialGauge,
  health_core: HealthCore,
  radar: Radar,
  waveform: Waveform,
  network: Network3D,
  line_3d: LineChart3D,
  bar_3d: BarChart3D,
  particle_flow: ParticleFlow,
  globe: Globe3D,
  timeline: Timeline3D,
};
```

Wrappers around the registry entry add behavior without each viz re-implementing it:

- **`DrillDown`** — pointer picking that walks `userData.viz` tags up the object
  tree (plus `userData.vizBar` + `instanceId` for instanced bars), toggling
  store focus; hover changes cursor; `onPointerMissed` clears focus; focus is
  cleared whenever the spec changes.
- **`Pulse`** — scale pulse loop when `animation: "pulse"`.
- **Title** — billboarded `TechLabel` with glyph-scramble decode animation.
- **`FocusMarker`** — pulsing ring reticle + connector locked onto the focused element.

### Drill-down data tagging

Renderers tag pickable meshes with `{ userData: { viz: VizFocus } }`. This keeps
the interaction layer generic — adding a new visualization never touches
`DrillDown`.

## 5. Scene graph (`Scene.tsx`)

```text
<Canvas dpr camera gl=...>
└── SceneBody
    ├── background/fog #02050a (7–16 range)
    ├── StateLights            ambient + two point lights tinted by STATE_LOOK[state]
    ├── CameraRig              eased drift + pointer parallax + per-state orbit/dolly
    ├── SpatialHud             dotted grid plane, outer frame arcs, corner brackets,
    │                          reticles, coord/sync readouts, level columns
    ├── FridayCore             8-layer hologram (below)
    ├── FridayVisualization    active spec via REGISTRY
    ├── AdaptiveDpr pixelated / AdaptiveEvents
    └── EffectComposer (WebGL only)
        Bloom · DepthOfField? · ChromaticAberration · Noise · Vignette
```

### Camera rig

Each frame the rig blends three inputs with eased interpolation:

- slow sinusoidal drift,
- pointer parallax (±0.55 x / ±0.30 y),
- per-state parameters from `STATE_CAMERA[state]` — orbit amplitude and target
  distance (e.g. `idle: 6.8/0.06`, `visualizing: 7.7/…`, `warning/error:
  orbit 0` — locked down when something is wrong).

Camera position is written into the telemetry singleton so the DOM HUD can
display a live VECTOR readout without React re-rendering the scene.

## 6. The core hologram (`FridayCore.tsx`)

Eight stacked layers, all driven by `STATE_LOOK[state]`:

1. **Energy core** — sphere r=0.5, `MeshDistortMaterial` (distort/speed/emissive
   from the look); standard emissive material under WebGPU compat mode.
2. **Inner lattice** — wireframe icosahedron r=0.66.
3. **Fresnel shell** — icosahedron r=0.86 with the `hologramMaterial` shader,
   `uTime` advanced manually per frame.
4. **CoreRings** — inner tick dial (r≈1.02), three tilted spinning torus rings
   (1.28/1.55/1.82), dashed arcs (1.42/2.35), broken outer frame arcs (2.75).
5. **CoreParticles** — see below.
6. **Identity labels** — "AI CORE" + current state name, decoded on change.
7. **WaveformRing** — 96 instanced bars at r=2.08; height from layered sines
   through an injectable `getLevel(bin, time)` seam (drop-in point for a real
   `AnalyserNode`), smoothed at `delta*12`.
8. **Jitter** — positional shake scaled by `look.jitter`, non-zero only for
   `warning`/`error`.

## 7. Custom shaders (`effects/materials.ts`)

Three drei `shaderMaterial`s registered via `extend()` with TS JSX typings:

| Material | Uniforms | Purpose |
|---|---|---|
| `hologramMaterial` | `uTime uColor uOpacity uFresnelPower uScanSpeed uScanDensity uFlicker` | Fresnel edge glow + travelling scanlines + hash-noise flicker. Core shell & rings. |
| `holoGridMaterial` | time/color/opacity | Dotted background grid plane with radial fade and outward ripple — one draw call for the whole floor. |
| `holoParticleMaterial` | `uTime uColor uOpacity uMode uPixelRatio` | Vertex-shader particle motion from per-particle attributes (`aRadius aAngle aSpeed aTilt aY aSize`). `uMode 0` = orbit, `uMode 1` = outward flow. Point size clamped `[0.6, 7.0]` scaled by `34/depth`; depth-graded alpha. |

All three are GLSL-only, so components receive a `compat` flag (true on WebGPU)
and swap to built-in materials where needed.

## 8. Particles (`CoreParticles.tsx`)

- One `<points>` draw call; buffers built deterministically (seeded trig noise,
  no RNG drift between reloads/tests).
- Skewed size distribution: mostly fine dust plus a few bright motes.
- Intensity eases smoothly toward `STATE_LOOK.particleIntensity` on state change
  instead of snapping.
- Reused by `ParticleFlow` visualization with `mode="flow"` and count 1400.

## 9. Rendering backends (`rendererBackend.ts`)

```ts
createRenderer(props) →
  NEXT_PUBLIC_WEBGPU=1 && navigator.gpu ? WebGPURenderer : WebGLRenderer
```

- Backend reported to the store on creation (`gl.isWebGPURenderer`) and shown in
  EdgeTelemetry.
- Software renderer detection (SwiftShader / llvmpipe) disables DepthOfField —
  the pass that tanks CPU-rasterized frames hardest.
- `webglcontextlost` bumps a `ctxKey` used as the Canvas `key`, remounting and
  rebuilding the whole context automatically.

## 10. Post-processing

WebGL path only (the composer stack is skipped entirely on WebGPU):

| Effect | Settings | Gating |
|---|---|---|
| Bloom | intensity 0.75, luminanceThreshold 0.18, mipmap blur | always (WebGL) |
| DepthOfField | focalLength 0.42, bokehScale 1.1 | off when reduced motion or software GL |
| ChromaticAberration | offset 0.0012, radial modulation out to 40% radius | always |
| Noise | opacity 0.022 (0.012 reduced) | always |
| Vignette | offset 0.22, darkness 0.92 | always |

DOM-level equivalents (`globals.css`) layer on top: CRT scanlines
(`mix-blend-mode: overlay`), a 7 s vertical scan-bar sweep, `.answer-rise`
animation, and a radial vignette overlay.

## 11. Telemetry (`telemetry.ts`)

A single module-level rAF loop measures counters over 500 ms windows:

- `fps`, worst `frameMs` per window,
- JS heap (`performance.memory`, Chromium-only),
- navigator downlink,
- camera vector (written by `CameraRig`).

Consumers call `useTelemetry(hz = 4)` which samples into React state at 4 Hz —
sampling per frame would cost more than the scene itself. `SpatialHud` also
drives PWR/MEM/NET level columns from the same counters.

## 12. Styling

Tailwind v4 CSS-first config: `@theme inline` maps `--background/--foreground`
CSS variables into utilities and wires Geist font variables into
`--font-sans/--font-mono`. HUD styling is deliberately anti-dashboard — tiny
monospace uppercase cyan labels, tracking-wide, hairline dividers, no boxes or
cards (enforced by a test asserting no nav/aside/card/table chrome exists).

## 13. Reduced mode

Triggered by `(max-width: 768px)` or `(prefers-reduced-motion: reduce)`:

- DPR capped at `[1, 1.25]` (vs `[1, 1.75]`),
- particles 260 (vs 950),
- DepthOfField disabled,
- outer frame, reticles and level columns hidden.

Mobile tests assert the simplified layout renders without overflow while
keeping the state label and input functional.
