# Per-visualization focus system (replacing the shared drill-down) — design

Status: **awaiting review** · Date: 2026-09-15 · Scope this round: **radial gauge + network + bar**

## 1. Problem

There is one interaction mechanism for every visualization: `DrillDown` (a group
wrapper in `FridayVisualization.tsx`) turns a click into a `store.focus`, and two
generic renderers react to it — `FocusMarker` (a 3D reticle + `Connector` line)
and `FocusPanel` (a bottom-of-screen DOM card). The same soulless ring is drawn
for a bar, a network node, a timeline event, a radar contact and a gauge.

The radial gauge now renders its own hover/selection (enlarge + `#eafcff` +
dim-siblings), so the shared chrome is pure duplication on top of it. Each
visualization type can express "this element is the one you picked" far better
than a generic ring.

## 2. Decisions already made

- **Option B — thin spine, per-viz render**: keep one small store selection as
  the single source of truth (so the HUD and a shared ESC-release keep working),
  but each visualization renders its own focus treatment and opts out of the
  shared reticle + card.
- **HUD `FOCUS ·` lane stays** (it reads the spine).
- **This round implements gauge + network + bar.** `line_3d`, `timeline`,
  `radar`, `sankey_flow` **keep using the existing `DrillDown`/reticle** until a
  later round migrates them — so nothing regresses for them now.
- **Hover labels become per-viz** (the shared hover `TechLabel` in `DrillDown`
  stays only for the not-yet-migrated types).

## 3. The spine (`store.focus`)

Generalize `VizFocus` so it can describe both a legacy reticle focus and a
native, self-drawn selection:

```ts
export interface VizFocus {
  owner: string;              // "globe" | "gauge" | "network" | "bar" | "drilldown"
  key: string;               // stable element id within that viz (unique per owner)
  label: string;             // HUD text
  detail: string;            // HUD text
  native: boolean;           // true → viz draws its own focus; shared reticle+card skip
  position?: [number, number, number]; // legacy reticle only
}
```

- `native: true` → `FocusMarker` returns null and `FocusPanel` returns null
  (the owner already shows everything in-scene). Replaces today's `globe` flag.
- `native: false` → today's behavior (reticle + card), used by the unwritten
  `DrillDown` path for the four not-yet-migrated types. The legacy `FocusPanel`
  ESC listener stays as-is (it only ever sees `native:false` focus).
- `position` becomes optional (only the legacy reticle needs it).
- Selection compare for a native viz uses the §3a helpers:
  `isFocusedBy(focus, owner, key)` for "this element is selected", `anyFocusedBy(focus, owner)`
  for "dim my siblings".
- `EdgeTelemetry` is unchanged — it still prints `focus.label · focus.detail`.

### 3a. Pure helpers (`src/lib/visualization/focus.ts`) — the tested core

All decision logic is extracted here (no React/three) so it is unit-testable,
in the same spirit as the existing pure `nextFocus`:

```ts
toggleFocus(current, next) → VizFocus | null   // same owner+key → null (release), else next
makeNativeFocus(owner, key, label, detail) → VizFocus  // native:true
makeDrilldownFocus(label, detail, position) → VizFocus // owner:"drilldown", key:label, native:false
isFocusedBy(focus, owner, key) → boolean       // owner+key match
anyFocusedBy(focus, owner) → boolean           // a focus from this owner exists
```

`makeDrilldownFocus` exists because `owner`/`key`/`native` become **required** on
`VizFocus`: the legacy `nextFocus`/`DrillDown` path builds every focus through
`makeDrilldownFocus`, so no legacy call site silently produces a focus missing
the new fields. `nextFocus` (legacy, label-based) stays for `DrillDown` until
the later round.

## 4. Shared plumbing

- **ESC / click-miss release**: one small hook `useFocusRelease(owner)` —
  a `keydown` listener that clears `store.focus` only when `focus.owner === owner`
  (so ESC releases the current viz's selection). The existing per-viz
  `onPointerMissed` at the viz root calls the same owner-scoped clear. Migrated
  viz each own hit-mesh handlers with `e.stopPropagation()` so the wrapper
  `DrillDown` never double-handles a migrated element.
- A **6px drag-vs-click gate** is replicated in the migrated handlers (network
  spins, bars are static but the camera orbits) exactly like `GlobeMarkers` does
  today, so orbiting never triggers a selection.

## 5. Per-viz focus treatments (native, in-scene)

Stable keys (must not collide within an owner):
gauge → `metric.label.toUpperCase()` · network → `node.id` · bar →
`"${seriesIndex}-${instanceId}"` · globe → `markerLabel(point, index)` (today's
compare key, unchanged semantics).

**Gauge** (`vizRadial.tsx`) — mostly already built.
- Selection moves off the raw `store.focus` label compare onto `isFocusedBy`.
- Node click → `toggleFocus(makeNativeFocus("gauge", metricKey, LABEL, detail))`.
- Keep: hover/selected scale ~1.15, `#eafcff` tint, value grows, dim siblings; no
  decode scramble; per-node `detail` (value+unit) shown.
- `noHoverLabel`/`userData.viz` no longer needed (the mesh owns its events).

**Network** (`vizSpatial.tsx`)
- Node click → selected node: octahedron brightens to `#eafcff`, ring grows +
  spins faster; **incident edges** (a or b === selected) go to full opacity; all
  other nodes and edges **dim** (opacity ~0.15); the selected node shows a
  second `TechLabel` line with its `detail`.
- Hover: same emphasis without committing (local `hovered` state), cursor pointer.
- Detail is data-driven: node degree → `detail: "${degree} LINK(S)"` instead of
  the generic "NODE ONLINE".
- Key = node id (unique). Owner "network".

**Bar** (`vizCharts.tsx`, `BarChart3D`)
- Bars are one `InstancedMesh` per series → per-instance focus via
  `mesh.setColorAt(instanceId, …)` + `instanceColor.needsUpdate`.
- Selected/hovered instance: color `#eafcff` and a small extra lift (rebuild that
  one matrix, `+0.06`); when something is selected, every other instance of every
  series is dimmed toward a darker color; with nothing selected, per-series base
  color returns. The lift is a **separate matrix pass** re-applying the final
  (post-grow) geometry with `y + 0.06` for the selected index — it must not race
  the grow animation: the grow loop only touches matrices while
  `grown.current < 1`; the focus pass runs whenever selection state changes or
  `grown.current` just reached 1 (a `selectionDirty` ref), then stops.
- Click a bar → `toggleFocus(makeNativeFocus("bar", "si-i", "SERIES · i+1", value+unit))`.
- The always-on value `TechLabel` above the peak/ends stays; the selected bar
  gets its own brighter value label.
- Remove the now-unused `userData.vizBar` (DrillDown path) for bar.

## 6. Rollout safety

- `DrillDown`, `FocusMarker`, `FocusPanel`, `VizTag`, `nextFocus`, `findVizTag`
  all **stay** this round (line/timeline/radar/sankey still use them). Only
  `FocusMarker`/`FocusPanel` gain the `native` short-circuit, and `VizFocus`
  gains fields. This keeps the diff reviewable and shippable without a big-bang.
- A later round migrates the remaining four types and then deletes the legacy
  chrome + `nextFocus`/`VizTag`/`findVizTag`/`userData.viz*` hooks entirely.

## 7. Testing (TDD)

- `focus.spec.ts` (new, unit): the four pure helpers — toggle release, owner/key
  isolation (a gauge focus must not highlight a same-key network node), `makeNativeFocus`
  shape, `isFocusedBy`/`anyFocusedBy` truth table, and `native:true`.
- Update `store.spec.ts` focus cases to the richer `VizFocus` shape (owner/key/native).
- `vizFocus.spec.ts` (`nextFocus`) unchanged this round (legacy path intact).
- Existing gauge visual test (`gaugeVisual`) — keep; selection now flows through
  `isFocusedBy` but the pure visual mapping is unaffected.
- `tsc --noEmit`, `eslint`, full unit suite. Network/bar instancing visuals are
  verified by manual `npm run dev` (instanced raycast + per-instance color can't
  be asserted in the node unit env).

## 8. Files touched

- `src/lib/visualization/types.ts` — richer `VizFocus`.
- `src/lib/visualization/focus.ts` — NEW pure helpers (tested).
- `src/components/friday/visualization/FridayVisualization.tsx` — `native`
  short-circuit in `FocusMarker`; ESC hook; keep legacy `DrillDown`.
- `src/components/friday/hud/FocusPanel.tsx` — `focus.native` → null.
- `src/components/friday/visualization/vizRadial.tsx` — gauge spine wiring (small).
- `src/components/friday/visualization/vizSpatial.tsx` — network native focus.
- `src/components/friday/visualization/vizCharts.tsx` — bar native focus (instanced color).
- `src/components/friday/visualization/globe/*` — migrate `globeFocusFor` → `makeNativeFocus("globe", …)`, drop `globe` flag use.
- tests: `focus.spec.ts` (new), `store.spec.ts` (shape), maybe `globeFocus.spec.ts`.

## 9. Out of scope (next round)

Migrating line/timeline/radar/sankey to native focus and **deleting** the shared
`DrillDown`/`FocusMarker`/`FocusPanel`/`nextFocus`/`VizTag` chrome.
