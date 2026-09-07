# State Machine

The agent is modeled as a finite state machine with a **static, guarded
transition table**. This document lists every state, every legal edge, and the
per-state presentation parameters.

## States

| State | Meaning | Color | Accent |
|---|---|---|---|
| `idle` | Waiting for a query | Cyan | Cyan |
| `listening` | Capturing input | Cyan | Violet |
| `thinking` | Reasoning about the query | Violet | Violet |
| `searching` | Retrieving information | Violet | Blue |
| `tool_execution` | Running tools | Violet | Amber |
| `processing` | Fusing results | Violet | Blue |
| `visualizing` | Materializing the spec | Cyan | Green |
| `speaking` | Answering | Cyan | White |
| `warning` | Degraded | Amber | Red |
| `error` | Failed | Red | Red |

## Transition table

```text
idle            → listening, thinking, warning, error
listening       → thinking, idle, warning, error
thinking        → searching, tool_execution, processing, visualizing, speaking, warning, error
searching       → processing, tool_execution, visualizing, speaking, warning, error
tool_execution  → processing, visualizing, speaking, warning, error
processing      → visualizing, tool_execution, speaking, warning, error
visualizing     → speaking, processing, idle, warning, error
speaking        → idle, listening, warning, error
warning         → idle, speaking, error
error           → idle                       // recovery only via idle
```

Source of truth is `src/lib/agent/stateMachine.ts:TRANSITIONS` — this table is
generated from it, do not edit by hand without updating the code.

Happy path (driven by `runLocal()` in `src/lib/agentStream.ts`, or SSE events
in live mode):

```text
thinking → searching → tool_execution → processing → visualizing → speaking → idle
```

### Guarantees

- Illegal edges are **silently ignored** by `transition()` — never thrown,
  because async producers racing each other must not crash the UI.
- Every working state may escalate to `warning`/`error`; `error` recovers only
  through `idle`, so a failure can't be papered over mid-pipeline.
- `setState()` bypasses the table and exists **only** for the developer state
  rail (`StateRail`) that previews any state's look.

These guarantees are locked by unit tests (`tests/unit/store.spec.ts`): illegal
edges refused, error reachable from all 8 working states, recovery only via
idle, `reset()` clears answer/visualization/focus.

## Per-state looks (`stateLook.ts`)

A single `STATE_LOOK: Record<FridayState, StateLook>` table drives everything
coherent at once:

```ts
interface StateLook {
  color: string;             // core + light tint
  accent: string;            // secondary tint (rings, HUD)
  coreDistort: number;       // MeshDistortMaterial distortion
  coreSpeed: number;         // distortion speed
  glow: string;              // emissive intensity
  ringSpeed: number;         // ring system multiplier
  particleIntensity: number; // eased target for CoreParticles
  waveform: number;          // waveform activity multiplier
  jitter: number;            // positional shake (warning/error only)
  scanSpeed: number;         // hologram scanline travel speed
}
```

Camera behavior lives in a parallel `STATE_CAMERA` table:

| State | Distance | Orbit amplitude |
|---|---|---|
| idle | 6.8 | 0.06 |
| listening | 6.55 | 0.10 |
| thinking | 6.15 | 0.20 |
| searching | 6.35 | 0.55 |
| processing | 6.4 | 0.30 |
| tool_execution | 6.3 | 0.35 |
| visualizing | 7.7 | 0.50 |
| speaking | 6.7 | 0.12 |
| warning | 6.5 | **0** — camera locks down |
| error | 6.45 | **0** — camera locks down |

Source of truth is `src/lib/stateLook.ts:STATE_CAMERA`.

Because both tables are keyed by state, one store write re-tints lights, speeds
up rings, excites particles and waveform, jitters the core and re-frames the
camera simultaneously — no component-level coordination needed.

## Audio cues (`uiSound.ts`)

Each state maps to an oscillator blip (frequency/duration/waveform); `warning`
and `error` play double square/sawtooth cues. The context unlocks on the first
pointer/key gesture (browser autoplay policy) and cues respect
`audioEnabled`.
