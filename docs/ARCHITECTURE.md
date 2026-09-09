# Architecture

This document walks through how Metallica is put together: the data flow, the
rendering layers, the custom shaders, and every deliberate performance and
compatibility decision.

```
                    ┌──────────────────────────────────────────────┐
   user query       │  InputBar ──▶ runQuery (agentStream.ts)      │
  ─────────────────▶│      │                                        │
                    │      ▼        guarded transition()            │
                    │  zustand store  ◀── setState (dev rails)      │
                    │  state · answer · visualization · focus       │
                    │      │                                        │
                     │      ├──────────────┬────────────────┐        │
                     │      ▼              ▼                ▼        │
                     │  DOM HUD        FridayCore     FridayVis     │
                     │  (hud/ modules) + SpatialHud    (REGISTRY)    │
                     │                 + lights/camera rig           │
                     └──────────────────────────────────────────────┘
```

## 1. Layers

The application has four cooperating layers:

| Layer | Location | Responsibility |
|---|---|---|
| **State** | `src/lib/store.ts` | Single source of truth: agent state machine (+ `endTurn` landing), current answer, `visualizations: VisualizationEntry[]` (max 3, stable id, transient `preview` flag), drill-down focus, `pendingConfirm` gate, `toolActivity`/`deniedTool`, `liveMode`/`sessionError`, `memories`, render backend/quality/lang, audio flag. |
| **Logic** | `src/lib/vizPlanner.ts`, `src/lib/agentStream.ts`, `stateLook.ts` | Pure planner (query → spec), SSE orchestrator + offline `runLocal` fallback, state → look tables. |
| **3D scene** | `src/components/friday/**` | The R3F canvas: core hologram, particles, rings, waveform, spatial HUD, visualization registry, shaders, post-processing. |
| **DOM HUD** | `src/components/friday/hud/` per-component modules (`TopHud`, `EdgeTelemetry`, `AnswerLine`, `VizRail`, `StateRail`, `FocusPanel`, `AudioCues`, plus `useHudDepth`/`devRails` helpers; `Hud.tsx` is a back-compat barrel re-exporting them) | Everything above the canvas: top bar, edge telemetry, dev rails, answer line, input bar. |

`src/app/page.tsx` is a server shell composing client islands; the 3D scene
lives behind `SceneIsland`, the one `dynamic(..., { ssr: false })` boundary
(`ssr: false` is forbidden in Server Components, and WebGL needs a real
browser context). The page is `force-dynamic` so the CSP nonce proxy can
inject into it (see §14).

## 2. State management (`src/lib/store.ts`)

A single Zustand store holds everything the UI needs. The renderer-contract
types (`VisualizationSpec`, `VizData`, `VisualizationEntry`, …) live in
`src/lib/visualization/types.ts` — pure modules (planner, normalization,
event parsing) import that path directly; the store re-exports them so
existing `@/lib/store` type imports keep working.

```ts
// Mirrors src/lib/store.ts:FridayStore — the shape, not a copy.
interface FridayStore {
  state: FridayState;
  answer: string | null;
  visualizations: VisualizationEntry[]; // { id, spec, lifecycle, preview? }, max 3
  focus: VizFocus | null;
  pendingConfirm: PendingConfirm | null; // §11 approval gate (not a state)
  toolActivity: ToolActivity | null;
  deniedTool: string | null;
  liveMode: LiveMode;                    // connecting | live | offline | idle
  sessionError: string | null;
  renderBackend: RenderBackend;
  quality: RenderQuality;
  lang: SupportedLang;
  audioEnabled: boolean;
  memories: MemoryNote[];                // newest first, max 3 on screen

  transition(next: FridayState): void; // guarded — see below
  setState(state: FridayState): void;  // unguarded — dev rails only
  endTurn(): void;                     // silent idle landing, keeps output
  setAnswer(v: string | null): void;
  addVisualization(spec: VisualizationSpec, opts?: { preview?: boolean }): void; // stable id, slice(-3)
  setVisualizations(vizs: VisualizationSpec[]): void; // bulk, capped like add
  clearVisualizations(): void;
  settleVisualization(id: number): void; // by id, never by index
  setFocus(focus: VizFocus | null): void;
  setPendingConfirm(p: PendingConfirm | null): void;
  setToolActivity(a: ToolActivity | null): void;
  setDeniedTool(t: string | null): void;
  setLiveMode(m: LiveMode): void;
  setSessionError(m: string | null): void;
  setRenderBackend(b: RenderBackend): void;
  setQuality(q: RenderQuality): void;
  setLang(l: SupportedLang): void;
  toggleAudio(): void;
  addMemory(note: MemoryNote): void;
  clearMemories(): void;
  reset(): void; // preserves renderBackend/quality/lang/audioEnabled
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

`runQuery(store, query)` in `src/lib/agentStream.ts` drives the machine from SSE:

1. clears `answer` / visualizations / confirm / errors, `setLiveMode("connecting")`,
2. `streamQuery` → typed `FridayEvent` → `dispatch()` → store (`transition`,
   `addVisualization`, `setAnswer`, …),
3. live answer is held until `speak()` finishes (voice) or 3.6 s (typed),
   then `endTurn()` (silent idle landing); answer/viz persist until the next turn.

Offline fallback `runLocal()` (same file) simulates the pipeline with timed
waits (`thinking → searching → tool_execution → processing → visualizing →
speaking → idle`) via `planVisualization`/`summarize`. The waits take the
turn's `AbortSignal`, so ESC/cancel stops a demo run mid-flight instead of
letting scheduled transitions fire after the reset. Voice answers go through
`speakUnlessAborted` — a barge-in abort mid-utterance is intentional silence,
not a session error. `TtsPlayer.play()` is bounded by `PLAY_TIMEOUT_MS`
(30 s, `AbortError`): a backend that goes silent mid-stream cannot freeze the
turn with the input disabled. `OrchestratorRefused`
(403/429) never falls back — a refusal is not an outage.

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
  heatmap_3d: Heatmap3D, // 11 types total
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
    ├── AdaptiveDpr / AdaptiveEvents (never pixelated)
    └── PostFX (RenderPipeline, TSL — both backends)
        Bloom · God-ray shafts · ChromaticAberration · Film · Vignette (no DoF)
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

1. **Energy core** — sphere r=0.5, TSL `createCoreMaterial()` (noise
   displacement; color/glow/distort/speed driven as uniforms, no recompile).
2. **Inner lattice** — wireframe icosahedron r=0.66.
3. **Fresnel shell** — icosahedron r=0.86 with TSL `createHologramMaterial()`
   (fresnel + scanlines + flicker, compiles to WGSL or GLSL).
4. **CoreRings** — inner tick dial (r≈1.02), three tilted spinning torus rings
   (1.28/1.55/1.82), dashed arcs (1.42/2.35), broken outer frame arcs (2.75).
5. **CoreParticles** — see below.
6. **Identity labels** — "AI CORE" + current state name, decoded on change.
7. **WaveformRing** — 96 instanced bars at r=2.08; height from layered sines
   through an injectable `getLevel(bin, time)` seam, smoothed at `delta*12`.
   `FridayCore` feeds it real levels: shared-bus mic FFT while listening,
   streamed-TTS analyser levels while speaking, synthesised motion otherwise
   (null falls back to synth, so a denied mic degrades gracefully).
8. **Jitter** — positional shake scaled by `look.jitter`, non-zero only for
   `warning`/`error`.

## 7. Custom shaders (`effects/materials.ts`)

Three TSL node factories (`createHologramMaterial`, `createParticleField`,
`createCoreMaterial`), each returning `{ material, apply/update }`. One node
graph compiles to WGSL or GLSL depending on the loaded backend — no `compat`
flag, no GLSL string splicing (which is why `@react-three/postprocessing`,
drei `<Text>`/`<Line>` and `MeshDistortMaterial` were dropped).

| Factory | Purpose |
|---|---|
| `createHologramMaterial` | Fresnel edge glow + travelling scanlines + flicker. Core shell & rings. |
| `createParticleField` | GPU particle motion from per-particle attributes; orbit vs outward flow via mode. |
| `createCoreMaterial` | Noise-displaced energy core; color/glow/distort/speed are uniforms. |

## 8. Particles (`CoreParticles.tsx`)

- One `<points>` draw call; buffers built deterministically (seeded trig noise,
  no RNG drift between reloads/tests).
- Skewed size distribution: mostly fine dust plus a few bright motes.
- Intensity eases smoothly toward `STATE_LOOK.particleIntensity` on state change
  instead of snapping.
- Reused by `ParticleFlow` visualization with `mode="flow"` and count 1400.

## 9. Rendering backends (`rendererBackend.ts`)

```ts
createRenderer(props) → always WebGPURenderer
  requestAdapter() ok ? WebGPU backend : WebGL2 backend
  NEXT_PUBLIC_FORCE_WEBGL=1 pins the WebGL2 backend for debugging
```

- Backend reported to the store by reading `backend.isWebGPUBackend` (not
  `isWebGPURenderer`, which is true on both) and shown in EdgeTelemetry.
- Software renderer detection (SwiftShader / llvmpipe) disables god-ray shafts —
  the full-resolution march that tanks CPU-rasterized frames hardest.
- `webglcontextlost` bumps a `ctxKey` used as the Canvas `key`, remounting and
  rebuilding the whole context automatically.

## 10. Post-processing (`effects/PostFX.tsx` — TSL `RenderPipeline`, both backends)

| Effect | Settings | Gating |
|---|---|---|
| Bloom | strength 0.55, radius 0.3, threshold 0.62 (UnrealBloom, half-res on dense) | always |
| God-ray shafts | radial-decay march, 30 taps (16 on dense), threshold 0.6 matched to bloom | only when `heavy && sun` |
| ChromaticAberration | offset 0.0012, radial | always |
| Film | opacity 0.022 (0.012 reduced) | always |
| Vignette | smoothstep(0.22, 1.0, r) * 0.92 | always |

No depth of field: measured `bokehScale 1.1` ≈ 1 px — invisible, for a
full-resolution pass. `PostFX` owns the frame via `useFrame(..., 1)`.

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
drives PWR/MEM/NET level columns from the same counters. The loop is
ref-counted: each mounted consumer starts it, the last unmount stops it. It
pauses while the tab is hidden (a backgrounded rAF loop would report dead
0 fps as data) and resumes on visible; `stopTelemetry()` force-stops it as a
test-only seam.

## 12. Styling

Tailwind v4 CSS-first config: `@theme inline` maps `--background/--foreground`
CSS variables into utilities and wires Geist font variables into
`--font-sans/--font-mono`. HUD styling is deliberately anti-dashboard — tiny
monospace uppercase cyan labels, tracking-wide, hairline dividers, no boxes or
cards (enforced by a test asserting no nav/aside/card/table chrome exists).

## 13. Reduced mode

Triggered by `(max-width: 768px)` or `(prefers-reduced-motion: reduce)`:

- DPR capped at `[1, 1.5]` (vs `[1, 2]`),
- particles 260 (vs 950),
- god-ray shafts disabled,
- outer frame, reticles and level columns hidden.

Mobile tests assert the simplified layout renders without overflow while
keeping the state label and input functional.

## 14. Content Security Policy (nonce proxy)

`next.config.ts` sets `nosniff` / `DENY` / strict referrer headers but
deliberately no CSP: a static `script-src 'self'` blocks the inline bootstrap
Next.js needs to hydrate any prerendered page — no hydration means no canvas,
and every UI test burns its full timeout until CI shards die at the job
limit (exactly what happened in Sep 2026).

`src/proxy.ts` (Next 16 Proxy convention) owns the CSP instead. Per request
it mints a nonce, puts `script-src 'self' 'nonce-…'` on the response, and
forwards the nonce as `x-nonce` so Next stamps it onto its own inline
scripts automatically. Everything else mirrors the old static policy
(`connect-src` keeps the orchestrator/stub hosts, `object-src 'none'`,
`frame-ancestors 'none'`, `style-src` keeps `'unsafe-inline'`).

Two deliberate constraints:

- **No `strict-dynamic`.** It would void the `'self'` allowlist, and the TTS
  `AudioWorklet` module (same-origin `/audio/tts-worklet.js` fetched via
  `addModule`, not `<script>`) is not provable-safe under it by the UI suite.
  Nothing third-party loads here, so it buys no threat coverage.
- **`force-dynamic` page.** A nonce cannot be injected into a build-time
  prerender, so `page.tsx` opts out of static rendering (a live hologram has
  no use for one anyway).
