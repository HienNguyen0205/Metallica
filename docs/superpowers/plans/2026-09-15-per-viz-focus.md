# Per-Visualization Focus (Gauge + Network + Bar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared drill-down chrome (reticle + Connector + FocusPanel) with native, type-appropriate focus for the radial gauge, network and bar visualizations, on a thin `store.focus` spine that keeps the HUD `FOCUS ·` lane and ESC release working.

**Architecture:** Option B (thin spine, per-viz render): `VizFocus` gains `owner/key/native`; a pure helper module (`src/lib/visualization/focus.ts`) holds every decision (toggle/release/compare); each migrated viz owns its pointer events (stopPropagation + 6px drag gate) and renders its own selection language. Legacy `DrillDown`/`FocusMarker`/`FocusPanel` stay untouched for the not-yet-migrated types (line/timeline/radar/sankey).

**Tech Stack:** React 19, @react-three/fiber 9, three 0.185 (TSL node materials), zustand 5, Playwright `--project=unit` (node env, **no DOM** — never touch `window`/`document`/`localStorage` in unit tests).

**Spec:** `docs/superpowers/specs/2026-09-15-per-viz-focus-design.md`

## Global Constraints

- Test runner: `npx playwright test --project=unit <file>`; typecheck `npx tsc --noEmit`; lint `npx eslint` (0 errors; the one pre-existing `SceneIsland.tsx:25` warning is NOT yours).
- React Compiler eslint rules are active: NO mutating `useMemo`-returned values after render (mutate via methods like `color.set()`/`copy()`, or use refs).
- `native: true` focus must render NO shared chrome: `FocusMarker` → null, `FocusPanel` → null.
- Every native click goes through the pure helpers — no inline owner/key conditionals inside components.
- Stable keys per owner (spec §5): gauge `label.toUpperCase()`, network `node.id`, bar `"${si}-${i}"`, globe `markerLabel(point, index)`.
- Commit per task (plan execution); do not push.

---

### Task 1: VizFocus spine + pure helpers

**Files:**
- Modify: `src/lib/visualization/types.ts` (`VizFocus`, ~line 99)
- Create: `src/lib/visualization/focus.ts`
- Create: `tests/unit/focus.spec.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces (used by Tasks 2–6):
  - `VizFocus { owner: string; key: string; label: string; detail: string; native: boolean; position?: [number, number, number] }`
  - `makeNativeFocus(owner: string, key: string, label: string, detail: string): VizFocus`
  - `makeDrilldownFocus(label: string, detail: string, position: [number, number, number]): VizFocus`
  - `toggleFocus(current: VizFocus | null, next: VizFocus): VizFocus | null`
  - `releaseFocus(current: VizFocus | null, owner: string): VizFocus | null`
  - `isFocusedBy(focus: VizFocus | null, owner: string, key: string): boolean`
  - `anyFocusedBy(focus: VizFocus | null, owner: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/focus.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import {
  makeNativeFocus,
  makeDrilldownFocus,
  toggleFocus,
  releaseFocus,
  isFocusedBy,
  anyFocusedBy,
} from "@/lib/visualization/focus";
import type { VizFocus } from "@/lib/visualization/types";

const GAUGE_A = makeNativeFocus("gauge", "CPU", "CPU", "73%");
const GAUGE_B = makeNativeFocus("gauge", "RAM", "RAM", "61%");
const NET_A = makeNativeFocus("network", "api", "API", "2 LINKS");

test("makeNativeFocus builds a chrome-free selection", () => {
  expect(GAUGE_A).toEqual({
    owner: "gauge",
    key: "CPU",
    label: "CPU",
    detail: "73%",
    native: true,
    position: undefined,
  });
});

test("makeDrilldownFocus wraps the legacy reticle shape", () => {
  const f = makeDrilldownFocus("SFO-03", "48", [1, 2, 3]);
  expect(f.owner).toBe("drilldown");
  expect(f.key).toBe("SFO-03");
  expect(f.native).toBe(false);
  expect(f.position).toEqual([1, 2, 3]);
});

test("toggleFocus: same owner+key releases, anything else replaces", () => {
  expect(toggleFocus(GAUGE_A, GAUGE_A)).toBeNull();
  expect(toggleFocus(null, GAUGE_A)).toEqual(GAUGE_A);
  expect(toggleFocus(GAUGE_A, GAUGE_B)).toEqual(GAUGE_B);
  // a network node with the SAME key is a different owner — never a release
  expect(toggleFocus(makeNativeFocus("network", "CPU", "C", "D"), GAUGE_A)).toEqual(GAUGE_A);
});

test("releaseFocus only clears this owner's selection", () => {
  expect(releaseFocus(GAUGE_A, "gauge")).toBeNull();
  expect(releaseFocus(NET_A, "gauge")).toEqual(NET_A);
  expect(releaseFocus(null, "gauge")).toBeNull();
});

test("isFocusedBy / anyFocusedBy isolate owners", () => {
  expect(isFocusedBy(GAUGE_A, "gauge", "CPU")).toBe(true);
  expect(isFocusedBy(GAUGE_A, "network", "CPU")).toBe(false);
  expect(isFocusedBy(GAUGE_A, "gauge", "RAM")).toBe(false);
  expect(isFocusedBy(null, "gauge", "CPU")).toBe(false);
  expect(anyFocusedBy(GAUGE_B, "gauge")).toBe(true);
  expect(anyFocusedBy(NET_A, "gauge")).toBe(false);
  expect(anyFocusedBy(null, "gauge")).toBe(false);
});

test("helpers tolerate the legacy shape lacking new fields (cast)", () => {
  const legacy = { label: "X", detail: "y", position: [0, 0, 0] } as VizFocus;
  expect(isFocusedBy(legacy, "gauge", "X")).toBe(false);
  expect(anyFocusedBy(legacy, "gauge")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test --project=unit tests/unit/focus.spec.ts`
Expected: FAIL — `Cannot find module '@/lib/visualization/focus'` (and `types.ts` has no owner/key/native yet → tsc would also complain, but playwright transpiles loosely; the module-not-found failure is the RED signal).

- [ ] **Step 3: Change the `VizFocus` type**

In `src/lib/visualization/types.ts` replace the old interface:

```ts
/**
 * The single selection spine. `native: true` means the owning visualization
 * renders its own focus treatment — the shared reticle (FocusMarker) and DOM
 * card (FocusPanel) skip those and only the HUD `FOCUS ·` lane reads it.
 * `native: false` is the legacy generic drill-down (reticle at `position`).
 */
export interface VizFocus {
  /** Which visualization drew this selection: "globe" | "gauge" | "network" | "bar" | "drilldown". */
  owner: string;
  /** Stable element id within that owner (collision rule: unique per owner only). */
  key: string;
  label: string;
  detail: string;
  native: boolean;
  /** Legacy reticle anchor only — native owners never set it. */
  position?: [number, number, number];
}
```

- [ ] **Step 4: Implement the pure helpers**

Create `src/lib/visualization/focus.ts`:

```ts
import type { VizFocus } from "./types";

/** A selection owned by a viz that renders its own focus (no shared chrome). */
export function makeNativeFocus(
  owner: string,
  key: string,
  label: string,
  detail: string,
): VizFocus {
  return { owner, key, label, detail, native: true, position: undefined };
}

/** The legacy generic drill-down focus: shared reticle + FocusPanel draw it. */
export function makeDrilldownFocus(
  label: string,
  detail: string,
  position: [number, number, number],
): VizFocus {
  return { owner: "drilldown", key: label, label, detail, native: false, position };
}

/** Click semantics: re-picking the same element releases it, else it replaces. */
export function toggleFocus(current: VizFocus | null, next: VizFocus): VizFocus | null {
  if (current && current.owner === next.owner && current.key === next.key) return null;
  return next;
}

/** ESC / click-miss: clear only this owner's selection, never steal another's. */
export function releaseFocus(current: VizFocus | null, owner: string): VizFocus | null {
  if (current && current.owner === owner) return null;
  return current;
}

export function isFocusedBy(focus: VizFocus | null, owner: string, key: string): boolean {
  return !!focus && focus.owner === owner && focus.key === key;
}

export function anyFocusedBy(focus: VizFocus | null, owner: string): boolean {
  return !!focus && focus.owner === owner;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx playwright test --project=unit tests/unit/focus.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/visualization/types.ts src/lib/visualization/focus.ts tests/unit/focus.spec.ts
git commit -m "feat(focus): owner/key/native selection spine + pure focus helpers"
```

---

### Task 2: Store-shape test + legacy path on the spine + chrome short-circuits

**Files:**
- Modify: `tests/unit/store.spec.ts:121-133` (focus tests)
- Modify: `src/components/friday/visualization/FridayVisualization.tsx` (`nextFocus` ~line 65, `FocusMarker` ~line 180)
- Modify: `src/components/friday/hud/FocusPanel.tsx`
- Modify: `src/lib/store.ts:123-124` (doc-comment only, keep `focus: null` + `setFocus` unchanged)

**Interfaces:**
- Consumes: Task 1 (`makeDrilldownFocus`, `VizFocus` fields).
- Produces: `nextFocus(current: VizFocus | null, tag: VizTag, position: [number,number,number]): VizFocus | null` — same signature, now returning the rich shape with `owner:"drilldown"`; legacy behavior preserved for line/timeline/radar/sankey.

- [ ] **Step 1: Update store focus tests to the new shape (verify they still pass)**

In `tests/unit/store.spec.ts` replace the two focus tests:

```ts
test("focus can be set and cleared", () => {
  api.getState().setFocus(makeDrilldownFocus("CPU", "73%", [1, 2, 0]));
  expect(api.getState().focus?.label).toBe("CPU");
  expect(api.getState().focus?.owner).toBe("drilldown");
  api.getState().setFocus(null);
  expect(api.getState().focus).toBeNull();
});

test("reset clears any active focus", () => {
  api.getState().setFocus(makeNativeFocus("gauge", "RAM", "RAM", "61%"));
  api.getState().reset();
  expect(api.getState().focus).toBeNull();
});
```

Add import: `import { makeDrilldownFocus, makeNativeFocus } from "@/lib/visualization/focus";`

- [ ] **Step 2: Run to verify**

Run: `npx playwright test --project=unit tests/unit/store.spec.ts`
Expected: PASS (the store itself needs no code change — it already stores an opaque `VizFocus`).

- [ ] **Step 3: Route the legacy DrillDown through `makeDrilldownFocus`**

In `FridayVisualization.tsx` change `nextFocus`'s body only (signature identical):

```ts
import { makeDrilldownFocus } from "@/lib/visualization/focus";

export function nextFocus(
  current: VizFocus | null,
  tag: VizTag,
  position: [number, number, number],
): VizFocus | null {
  const next = makeDrilldownFocus(tag.label, tag.detail, position);
  return current?.label === tag.label ? null : next;
}
```

- [ ] **Step 4: `FocusMarker` and `FocusPanel` skip native selections**

`FridayVisualization.tsx` in `FocusMarker` — replace the globe check:

```ts
  if (!focus) return null;
  // Native selections render their own focus in-scene; no shared reticle.
  if (focus.native) return null;
```

`FocusPanel.tsx` — two changes:

```tsx
  if (!focus || focus.native) return null;
```

and make ESC owner-scoped (legacy is the only non-native owner):

```ts
      if (e.key === "Escape") setFocus(releaseFocus(focus, "drilldown"));
```

with `import { releaseFocus } from "@/lib/visualization/focus";`.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx playwright test --project=unit`
Expected: 0 type errors; full unit suite passes. Note `tests/unit/vizFocus.spec.ts` (legacy `nextFocus` tests) asserts `{...CPU, position}`-style equality — its fixtures/cases may need the `owner/key/native` fields added: update its expected objects to include `owner: "drilldown", key: <same label>, native: false, position: <same>` (behavior unchanged — release-on-same-label, replace-on-different).

Run: `npx playwright test --project=unit tests/unit/vizFocus.spec.ts` — iterate until green.

- [ ] **Step 6: Commit**

```bash
git add src/components/friday/visualization/FridayVisualization.tsx src/components/friday/hud/FocusPanel.tsx src/lib/store.ts tests/unit/store.spec.ts tests/unit/vizFocus.spec.ts
git commit -m "feat(focus): legacy drill-down on the spine; chrome skips native selections"
```

---

### Task 3: `useFocusRelease` shared hook

**Files:**
- Create: `src/components/friday/visualization/useFocusRelease.ts`

**Interfaces:**
- Consumes: Task 1 `releaseFocus`; store `focus`/`setFocus`.
- Produces: `useFocusRelease(owner: string): void` — registers a window `keydown` listener that clears the focus only when `focus.owner === owner`. Used by Tasks 4–6.

- [ ] **Step 1: Implement**

```ts
"use client";

import { useEffect } from "react";
import { useFridayStore } from "@/lib/store";
import { releaseFocus } from "@/lib/visualization/focus";

/**
 * ESC releases THIS visualization's selection only — a network node's ESC
 * must never clear the gauge's, and vice versa (one spine, owner-scoped).
 */
export function useFocusRelease(owner: string) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = useFridayStore.getState();
      s.setFocus(releaseFocus(s.focus, owner));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [owner]);
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/friday/visualization/useFocusRelease.ts`
Expected: 0 errors. (No unit test — it's a 6-line listener over pure logic tested in Task 1; node env has no `window`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/friday/visualization/useFocusRelease.ts
git commit -m "feat(focus): owner-scoped ESC release hook"
```

---

### Task 4: Globe migrates onto the spine (behavior-preserving)

**Files:**
- Modify: `src/components/friday/visualization/globe/geo.ts:270-282` (`globeFocusFor`), delete `isGlobeTag` (~258-268)
- Modify: `src/components/friday/visualization/globe/GlobeVisualization.tsx` (focus reads)
- Modify: `src/components/friday/visualization/FridayVisualization.tsx` (`isGlobeTag` import/use → owner check)
- Modify: `src/components/friday/visualization/globe/GlobeMarkers.tsx` (drop `globe: true` tag field)
- Modify: `tests/unit/globeFocus.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: globe focus = `makeNativeFocus("globe", markerLabel, …)`; `selectedLabel` still `string | null` for markers/routes.

- [ ] **Step 1: Update the failing tests first**

In `tests/unit/globeFocus.spec.ts` replace the `globeFocusFor` test with:

```ts
test("globeFocusFor builds a native spine focus", () => {
  const f = globeFocusFor({ id: "HAN", lat: 21.03, lon: 105.85, label: "HAN" }, 0);
  expect(f.owner).toBe("globe");
  expect(f.key).toBe("HAN");
  expect(f.label).toBe("HAN");
  expect(f.detail).toContain("EDGE REGION");
  expect(f.native).toBe(true);
  expect(f.position).toBeUndefined();
});
```

Delete the `isGlobeTag` tests (the flag it read is gone). Keep `computeGlobeFocusAngles` tests.

- [ ] **Step 2: Run to verify RED**

Run: `npx playwright test --project=unit tests/unit/globeFocus.spec.ts`
Expected: FAIL (old `globeFocusFor` returns `{label, detail, position, globe:true}`).

- [ ] **Step 3: Change `globeFocusFor`, remove `isGlobeTag`**

`geo.ts`:

```ts
import { makeNativeFocus } from "@/lib/visualization/focus";
import type { VizFocus } from "@/lib/store";

/** Globe-marker selection: native (own in-scene highlight); camera flies separately. */
export function globeFocusFor(point: GeoPoint, index: number): VizFocus {
  return makeNativeFocus("globe", markerLabel(point, index), markerLabel(point, index), markerDetail(point));
}
```

Delete `GlobeTag` + `isGlobeTag`. `GlobeVisualization.tsx:handleFocusMarker` drops the `worldPos` arg:

```ts
const handleFocusMarker = useCallback(
  (p: GeoPoint, index: number) => {
    focusOn({ lat: p.lat, lon: p.lon });
    useFridayStore.getState().setFocus(globeFocusFor(p, index));
  },
  [focusOn],
);
```

`GlobeMarkers.tsx`: `onFocusMarker` prop type `(point: GeoPoint, index: number) => void`; the hit mesh no longer needs `[worldPos…]` at call sites (the guard math stays; keep `userData` WITHOUT the `globe` flag: `{ label, detail }`), and keep `e.stopPropagation()` (it still prevents the wrapper DrillDown).

`FridayVisualization.tsx`: `selectedLabel` in globe viz = `isFocusedBy(focus, "globe", label)`-compatible — in `GlobeVisualization.tsx`:

```ts
const focus = useFridayStore((s) => s.focus);
const selectedLabel = focus && focus.owner === "globe" ? focus.key : null;
```

and `getFocusTarget` matches `focus.key` instead of `focus.label`.

In `FridayVisualization.tsx` the DrillDown globe guard becomes owner-based (globe markers stopPropagation anyway — belt & braces):

```ts
if (focus && focus.owner === "globe" && focus.key === hit.tag.label) return; // globe owns it
```

(remove the `isGlobeTag` import; the simpler equivalent `if (hit.tag.label === undefined) return;`-style is NOT acceptable — keep the owner check above, reading `focus` in the DrillDown scope where it's already subscribed).

- [ ] **Step 4: Verify**

Run: `npx playwright test --project=unit tests/unit/globeFocus.spec.ts tests/unit/globeGeo.spec.ts && npx tsc --noEmit`
Expected: PASS / 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/friday/visualization/globe/ src/components/friday/visualization/FridayVisualization.tsx tests/unit/globeFocus.spec.ts
git commit -m "refactor(globe): selection rides the focus spine (owner globe, native)"
```

---

### Task 5: Gauge selection on the spine + click-to-select

**Files:**
- Modify: `src/components/friday/visualization/vizRadial.tsx` (MetricNode + RadialGauge)

**Interfaces:**
- Consumes: Tasks 1 & 3 (`makeNativeFocus`, `toggleFocus`, `isFocusedBy`, `anyFocusedBy`, `useFocusRelease`).
- Produces: gauge owner `"gauge"`, key = `metric.label.toUpperCase()`; visual language unchanged (`gaugeVisual` still the pure mapping).

- [ ] **Step 1: Wire the spine into `RadialGauge`**

```ts
import { anyFocusedBy, isFocusedBy, makeNativeFocus, releaseFocus, toggleFocus } from "@/lib/visualization/focus";
import { useFocusRelease } from "./useFocusRelease";
// `useRef, useState` are already imported from react; extend the fiber import:
// import { useFrame, type ThreeEvent } from "@react-three/fiber";

export function RadialGauge({ metrics = [], color }: VizProps) {
  const focus = useFridayStore((s) => s.focus);
  const setFocus = useFridayStore((s) => s.setFocus);
  useFocusRelease("gauge");
  // 6px drag-vs-click gate (the camera orbits even when the gauges don't).
  const downAt = useRef<[number, number] | null>(null);

  const handleSelect = (m: MetricDatum, e: { nativeEvent: MouseEvent }) => {
    if (downAt.current) {
      const dx = e.nativeEvent.clientX - downAt.current[0];
      const dy = e.nativeEvent.clientY - downAt.current[1];
      downAt.current = null;
      if (Math.hypot(dx, dy) > 6) return;
    }
    const key = m.label.toUpperCase();
    setFocus(
      toggleFocus(
        useFridayStore.getState().focus,
        makeNativeFocus("gauge", key, key, `${Math.round(m.value)}${m.unit ?? ""}`),
      ),
    );
  };

  return (
    <group
      onPointerDown={(e) => { downAt.current = [e.nativeEvent.clientX, e.nativeEvent.clientY]; }}
      onPointerMissed={() => {
        const s = useFridayStore.getState();
        s.setFocus(releaseFocus(s.focus, "gauge"));
      }}
    >
      {metrics.map((m, i) => (
        <MetricNode
          key={m.label}
          index={i}
          count={metrics.length}
          metric={m}
          color={color}
          selected={isFocusedBy(focus, "gauge", m.label.toUpperCase())}
          anySelected={anyFocusedBy(focus, "gauge")}
          onSelect={(e) => handleSelect(m, e)}
        />
      ))}
    </group>
  );
}
```

- [ ] **Step 2: MetricNode owns its events**

Change props: replace `anySelected` usage as-is, add `onSelect: (e: ThreeEvent<MouseEvent>) => void`; remove the `userData.viz`/`noHoverLabel` block (DrillDown no longer handles gauges — stopPropagation makes it moot, keep it):

```tsx
              <mesh
                visible={false}
                onPointerOver={() => { setHovered(true); document.body.style.cursor = "pointer"; }}
                onPointerOut={() => { setHovered(false); document.body.style.cursor = "auto"; }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onSelect(e); }}
              >
                <circleGeometry args={[0.58, 20]} />
              </mesh>
```

Keep every existing visual (`gaugeVisual`, emphasis, tint, dim). Add the detail line while selected (in-scene readout replacing the DOM card):

```tsx
{selected && (
  <TechLabel position={[0, -0.84, 0]} size={0.055} color={color} opacity={0.85}>
    {`${Math.round(metric.value)}${metric.unit ?? ""}`}
  </TechLabel>
)}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/friday/visualization/vizRadial.tsx && npx playwright test --project=unit tests/unit/vizGauges.spec.ts`
Expected: 0 errors, tests pass. Manual check later in Task 7.

- [ ] **Step 4: Commit**

```bash
git add src/components/friday/visualization/vizRadial.tsx
git commit -m "feat(gauge): native click-to-select on the focus spine (no drill-down chrome)"
```

---

### Task 6: Network + bar native focus

**Files:**
- Modify: `src/components/friday/visualization/vizSpatial.tsx`
- Modify: `src/components/friday/visualization/vizCharts.tsx` (`BarChart3D`)

**Interfaces:**
- Consumes: Tasks 1 & 3.
- Produces: network owner `"network"` (key `node.id`), bar owner `"bar"` (key `"${si}-${i}"`).

**6a — Network (whole task in one cycle):**

Imports to extend in `vizSpatial.tsx`: `useState` (react), `type ThreeEvent` (fiber), `useFridayStore` (store), focus helpers + `useFocusRelease`.

- [ ] **Step 1: Restructure `Network3D`**

Add at top of component:

```ts
const focus = useFridayStore((s) => s.focus);
const setFocus = useFridayStore((s) => s.setFocus);
useFocusRelease("network");
const [hoveredId, setHoveredId] = useState<string | null>(null);
const downAt = useRef<[number, number] | null>(null);
const degrees = useMemo(() => {
  const d = new Array(data.length).fill(0);
  for (const [a, b] of edges) { if (a >= 0 && b >= 0 && a < d.length && b < d.length) { d[a]++; d[b]++; } }
  return d;
}, [data, edges]);
const selectedId = focus && focus.owner === "network" ? focus.key : null;
const anySelected = anyFocusedBy(focus, "network");
```

- [ ] **Step 2: Node visuals react; edges highlight incident to selection**

For each node group render a `NetworkNode` (extract ~lines 67-92 into a local component) with props `{ p, node, i, color, accent, selected, dimmed, onSelect, onHover, onOut, downAt }`:
- `dimmed = anySelected && !selected` → octahedron `opacity={dimmed ? 0.2 : 0.9}`, ring `opacity={dimmed ? 0.08 : 0.35}`;
- `selected || hovered` → octahedron `color="#eafcff"`, ring `scale 1.35` + spin `rotation.z += delta * 1.2` in `useFrame`;
- node hit-mesh: `onPointerOver={() => onHover(node.id)}`, `onPointerOut={() => onHover(null)}`, `onPointerDown={(e)=>e.stopPropagation()}`, `onClick={(e)=>{e.stopPropagation(); onSelect(node, i, e);}}` with the 6px gate;
- `onSelect` in `Network3D`: `setFocus(toggleFocus(useFridayStore.getState().focus, makeNativeFocus("network", node.id, (node.label ?? node.id).toUpperCase(), `${degrees[i]} LINK${degrees[i] === 1 ? "" : "S"}`)))`;
- selected node's detail line under the label:

```tsx
{selected && (
  <TechLabel position={[0, -0.46, 0]} color="#eafcff" size={0.06} opacity={0.9}>
    {`${degrees[i]} LINK${degrees[i] === 1 ? "" : "S"}`}
  </TechLabel>
)}
```
- edges: `const touches = selectedId !== null && (data[a]?.id === selectedId || data[b]?.id === selectedId);`
  `opacity={selectedId === null ? 0.45 : touches ? 0.9 : 0.12}`, `color={touches && selectedId ? accent : color}`;
- root group: `onPointerMissed={() => setFocus(releaseFocus(useFridayStore.getState().focus, "network"))}`.

**6b — Bar:**

Imports to extend in `vizCharts.tsx`: `useState` (react), `Color` (three), `type ThreeEvent` (fiber), `useFridayStore`, focus helpers + `useFocusRelease`.

- [ ] **Step 3: Instanced color + lift, no grow-race**

In `BarChart3D` add:

```ts
const focus = useFridayStore((s) => s.focus);
const setFocus = useFridayStore((s) => s.setFocus);
useFocusRelease("bar");
const [hovered, setHovered] = useState<{ si: number; i: number } | null>(null);
const downAt = useRef<[number, number] | null>(null);
const selected = useMemo(() => {
  if (!focus || focus.owner !== "bar") return null;
  const [si, i] = focus.key.split("-").map(Number);
  return { si: si ?? 0, i: i ?? 0 };
}, [focus]);
const touched = useRef(true); // forces a final color/lift pass after grow
```

- [ ] **Step 4: Frame pass** — extend the existing `useFrame` (the guard `if (grown.current >= 1) return;` becomes):

```ts
const animating = grown.current < 1;
if (!animating && !touched.current) return;
```

and at the end of the per-instance loop replace `dummy.scale`/`position` inputs and add color:

```ts
const isSel = si === selected?.si && i === selected?.i;
const isHov = si === hovered?.si && i === hovered?.i;
const anySel = selected !== null;
const lift = isSel ? 0.06 : 0;
dummy.position.set(x, BAR_BASE + h / 2 + lift, z);
// ...existing rotation/scale...
mesh.setMatrixAt(i, dummy.matrix);
const col = tmpColor;
if (isSel || isHov) col.set(0.92, 0.99, 1);
else if (anySel) col.copy(tmpBase).multiplyScalar(0.28);
else col.copy(tmpBase);
mesh.setColorAt(i, col);
```

with module consts `const tmpColor = new Color(); const tmpBase = new Color();` — set `tmpBase` once per series (`tmpBase.set(si === 0 ? color : accent)`), and after the loop: `if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;`. Set `touched.current = false` when `!animating`, `true` on any selection/hover change (effects on `selected`/`hovered`/`series`). `useLayoutEffect` on `[series]` still rewinds `grown` and now also `touched.current = true`.

- [ ] **Step 5: Events** — on each `instancedMesh` (R3F gives `e.instanceId`):

```tsx
onPointerDown={(e) => { e.stopPropagation(); downAt.current = [e.nativeEvent.clientX, e.nativeEvent.clientY]; }}
onPointerOver={(e) => { e.stopPropagation(); setHovered({ si, i: e.instanceId ?? 0 }); document.body.style.cursor = "pointer"; }}
onPointerOut={() => { setHovered(null); document.body.style.cursor = "auto"; }}
onClick={(e) => {
  e.stopPropagation();
  if (downAt.current && Math.hypot(e.nativeEvent.clientX - downAt.current[0], e.nativeEvent.clientY - downAt.current[1]) > 6) { downAt.current = null; return; }
  const i = e.instanceId ?? 0;
  const key = `${si}-${i}`;
  setFocus(toggleFocus(useFridayStore.getState().focus,
    makeNativeFocus("bar", key, `${s.label.toUpperCase()} · ${i + 1}`, String(s.points[i] ?? 0))));
}}
```

Delete `userData={{ vizBar … }}` (dead once DrillDown no longer sees bars). Root group: `onPointerMissed={() => setFocus(releaseFocus(useFridayStore.getState().focus, "bar"))}`. Selected bar's value `TechLabel`: brighter color/opacity when `selected?.si === si && selected?.i === i`.

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit && npx eslint src/components/friday/visualization/vizSpatial.tsx src/components/friday/visualization/vizCharts.tsx`
Expected: 0 errors (React-Compiler: all scratch colors are module-level or refs; never assign properties onto hook-returned objects in-frame).

```bash
git add src/components/friday/visualization/vizSpatial.tsx src/components/friday/visualization/vizCharts.tsx
git commit -m "feat(viz): native focus for network (neighbor highlight+dim) and bar (per-instance select/lift)"
```

---

### Task 7: Full verification

- [ ] **Step 1:** `npx tsc --noEmit` → 0 errors
- [ ] **Step 2:** `npx eslint` → 0 errors (pre-existing SceneIsland warning only)
- [ ] **Step 3:** `npx playwright test --project=unit` → all green
- [ ] **Step 4:** Manual `npm run dev` checklist: gauge click selects (scale+tint+dim), re-click/ESC/empty-click releases, NO reticle/Connector/FocusPanel for gauge; network click brightens node + incident edges, dims rest, shows `N LINKS`; bar click brightens + lifts the instance, dims others; bar/line/radar/timeline/sankey still show the legacy reticle + card (regression check for non-migrated); HUD `FOCUS ·` updates for all; globe unchanged.
- [ ] **Step 5:** Report results honestly (esp. what manual steps confirmed vs not).
