# Roadmap src Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 P0 correctness bugs, apply 3 P1 structural refactors, and land P2 small fixes in `src/` without changing runtime behavior except where specified.

**Architecture:** TDD per fix (failing Playwright unit test first), back-compat re-exports for every moved module so existing imports keep working, then verify with `lint + typecheck + unit`.

**Tech Stack:** Next.js 16 (App Router), React 19, three.js r185 WebGPURenderer/TSL, Zustand 5, Tailwind 4, Playwright Test (unit + ui projects).

**Spec:** Code-review roadmap from prior turn (P0-1..P2, 16 items). This file is the executable version of it.

## Global Constraints

- Node >= 20; `npm run lint`, `npm run typecheck` (`next typegen && tsc --noEmit`), `npm run test:unit` must all pass.
- No new runtime dependencies.
- `VisualizationSpec` wire contract unchanged (backend emits it; `normalization.ts` stays the single choke point).
- `page.tsx` keeps all current `data-testid`s and HUD composition order.
- UI suite (`tests/ui`) is NOT re-run per task (19 min, needs GPU/prod build); unit + lint + typecheck are the per-task gates.

---

### Task 1: runLocal honors AbortSignal (P0-1)

**Files:**
- Modify: `src/lib/agentStream.ts` (abortable `wait`, `runLocal(store, query, voice, signal?)`, pass `signal` from `runQuery` fallback call)
- Test: `tests/unit/agentStream.spec.ts` (append new test, reuse existing `recorder()`)

**Interfaces:**
- Consumes: existing `FLOW_TIMING`, `FlowStore`, `recorder()` helper in spec file.
- Produces: `runLocal` abort semantics relied on by nothing else (private function); `wait(ms, signal?)` module-private.

- [ ] **Step 1: Write the failing test** — append to `tests/unit/agentStream.spec.ts`:

```ts
test("aborting during the offline fallback stops the local run early", async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const store = recorder();
  const controller = new AbortController();
  const started = Date.now();
  const p = runQuery(store as unknown as FridayStore, "cpu load trend", {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await p;
  const elapsed = Date.now() - started;
  expect(store.calls).not.toContain("setAnswer");
  // Full offline run takes FLOW_TIMING waits (~4.2s) + answerHold (3.6s);
  // an aborted run must return well before that.
  expect(elapsed).toBeLessThan(3000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --project=unit tests/unit/agentStream.spec.ts`
Expected: FAIL — `setAnswer` is called (run ignores abort) and/or elapsed > 3000ms.

- [ ] **Step 3: Write minimal implementation** — in `src/lib/agentStream.ts`:

```ts
function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
```

Change `runLocal(store, query, voice = false)` to `runLocal(store, query, voice = false, signal?: AbortSignal)`, pass `signal` to every `wait(...)`, and wrap body:

```ts
async function runLocal(store: FlowStore, query: string, voice = false, signal?: AbortSignal) {
  try {
    // ... existing body, each wait(ms) -> wait(ms, signal) ...
  } catch (err) {
    if ((err as Error).name === "AbortError" || signal?.aborted) return;
    throw err;
  }
}
```

Also add an abort check after `speak()` (voice path has no signal): `if (signal?.aborted) return;` before `store.endTurn()`. Update fallback call: `await runLocal(store, query, voice, signal);`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --project=unit tests/unit/agentStream.spec.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agentStream.ts tests/unit/agentStream.spec.ts
git commit -m "fix: abort offline fallback run when turn is cancelled"
```

---

### Task 2: Timeout for TtsPlayer.play drain loop (P0-2)

**Files:**
- Modify: `src/lib/ttsPlayer.ts` (`play(stream, opts)` gains `timeoutMs`, deadline checked in backpressure + drain loops)
- Test: `tests/unit/ttsPlayer.spec.ts` (append; reuse `fakeDeps`, `pcmChunk`, `gen` helpers)

**Interfaces:**
- Consumes: `TtsStream`, `TtsPlayerDeps`, existing spec helpers.
- Produces: `play(stream, { signal?, timeoutMs? })` — `timeoutMs` default `PLAY_TIMEOUT_MS = 30_000`; timeout rejects with `AbortError` DOMException so `voice.ts` phase rule (frames>0 quiet / zero frames synthesis fallback) applies unchanged.

- [ ] **Step 1: Write the failing test** — append to `tests/unit/ttsPlayer.spec.ts`:

```ts
test("play rejects when the worklet never drains (hung backend)", async () => {
  const listeners = new Map<string, Array<(e: { data: unknown }) => void>>();
  const port = {
    postMessage: () => {},
    addEventListener: (t: string, fn: (e: { data: unknown }) => void) => {
      listeners.set(t, [...(listeners.get(t) ?? []), fn]);
    },
    close: () => {},
  };
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 4,
    getByteFrequencyData: (arr: Uint8Array) => { arr.fill(0); },
    connect: () => {},
    disconnect: () => {},
  };
  const node = { port, connect: () => {}, disconnect: () => {} };
  const context = {
    state: "running",
    resume: async () => {},
    sampleRate: 24000,
    audioWorklet: { addModule: async () => {} },
    createAnalyser: () => analyser,
    destination: {},
  };
  const player = new TtsPlayer({
    createContext: () => context,
    createNode: () => node,
    workletUrl: "/fake.js",
  } as never);
  const stream: TtsStream = {
    header: { sampleRate: 24000, channels: 1, totalSamples: null },
    chunks: gen([pcmChunk([1, 2, 3, 4])]),
  };
  await expect(player.play(stream, { timeoutMs: 100 })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(player.active).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --project=unit tests/unit/ttsPlayer.spec.ts -g "never drains"`
Expected: FAIL — times out (test timeout 120s default; use `--timeout=15000` to fail fast) because drain loop never exits.

- [ ] **Step 3: Write minimal implementation** — in `src/lib/ttsPlayer.ts`:

```ts
/** Upper bound for one play() so a hung backend cannot freeze the turn. */
export const PLAY_TIMEOUT_MS = 30_000;
```

Change signature: `async play(stream: TtsStream, opts?: { signal?: AbortSignal; timeoutMs?: number })`. Inside:

```ts
const timeoutMs = opts?.timeoutMs ?? PLAY_TIMEOUT_MS;
const deadline = Date.now() + timeoutMs;
const checkTimeout = (): void => {
  if (Date.now() >= deadline) throw abortError();
};
```

Call `checkTimeout()` at the top of the `for await` chunk loop, inside the `while (pending > MAX_PENDING)` wait (before awaiting), and inside the drain `for (;;)` loop. In the `catch (err)` block, teardown on timeout already happens via `if (this.generation === my) this.teardown();` — no change needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --project=unit tests/unit/ttsPlayer.spec.ts`
Expected: PASS (all tests in file, including the new one in ~100ms).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ttsPlayer.ts tests/unit/ttsPlayer.spec.ts
git commit -m "fix: bound TtsPlayer.play with a timeout so hung TTS cannot freeze a turn"
```

---

### Task 3: Sanitize wire labels + harden TechLabel (P0-3)

**Files:**
- Modify: `src/lib/visualization/normalization.ts` (coerce `label`/`id`/`unit` to strings, drop rows with empty labels)
- Modify: `src/components/friday/primitives.tsx` (`TechLabel` + `useDecoded` coerce at runtime)
- Test: `tests/unit/vizNormalize.spec.ts` (append label-coercion tests)

**Interfaces:**
- Consumes: `VisualizationSpec`, `VizData` from `@/lib/store`.
- Produces: same `normalizeVisualization(spec)` signature, stricter output (all labels non-empty strings).

- [ ] **Step 1: Write the failing tests** — append to `tests/unit/vizNormalize.spec.ts`:

```ts
test("normalize coerces non-string labels so canvas labels cannot crash", () => {
  const out = normalizeVisualization({
    type: "radial_gauge",
    data: {
      metrics: [
        { label: 123 as unknown as string, value: 50 },
        { label: "", value: 10 },
      ],
    },
  });
  expect(out.data?.metrics?.map((m) => m.label)).toEqual(["123"]);
});

test("normalize coerces node ids and timeline/series labels", () => {
  const out = normalizeVisualization({
    type: "network",
    data: {
      nodes: [{ id: 7 as unknown as string }, { id: "b", label: null as unknown as string }],
      links: [[0, 1]],
    },
  });
  expect(out.data?.nodes?.map((n) => n.id)).toEqual(["7", "b"]);
  const tl = normalizeVisualization({
    type: "timeline",
    data: { events: [{ label: 42 as unknown as string, at: 0.5 }] },
  });
  expect(tl.data?.events?.[0]?.label).toBe("42");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --project=unit tests/unit/vizNormalize.spec.ts`
Expected: FAIL — labels pass through un-coerced (`123` stays number / `""` kept).

- [ ] **Step 3: Write minimal implementation** — in `normalization.ts` add:

```ts
function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
```

Apply: metrics → `flatMap` dropping entries with no label (label coerced, `unit` coerced via `typeof m?.unit === "string" ? m.unit : undefined`); series → coerce `s.label` (drop row if empty after coerce? keep row with `label: "?"`? — drop only when points empty as today; coerce label, fallback to `"SERIES"` when missing); nodes → coerce `id` (drop node with empty id) and `label`; points → coerce `label`; events → coerce `label` (drop event with empty label). Links filter runs after node drops (indices refer to sanitized array — filter as today against `out.nodes`).

In `primitives.tsx`: `TechLabel({ children, ... })` — first line `const raw = String(children ?? ""); const text = useDecoded(raw.toUpperCase(), decode);` and `useDecoded(text: string, ...)` keeps signature (callers pass string).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --project=unit tests/unit/vizNormalize.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visualization/normalization.ts src/components/friday/primitives.tsx tests/unit/vizNormalize.spec.ts
git commit -m "fix: coerce wire labels to strings so canvas labels cannot crash the scene"
```

---

### Task 4: page.tsx Server Component + client islands (P1-4)

**Files:**
- Modify: `src/app/page.tsx` (remove `"use client"`, keep composition; `Scene` stays `dynamic(ssr:false)`)
- Test: existing `tests/ui/*.spec.ts` cover composition via `data-testid`s — no new test; gate is `lint + typecheck + build`.

**Interfaces:**
- Consumes: all HUD components (each already `"use client"`).
- Produces: identical DOM/testids, server-rendered shell.

- [ ] **Step 1: Verify client-only hooks are not in page** — `page.tsx` has no hooks; all children are client components. No test to write (composition unchanged).

- [ ] **Step 2: Implement** — delete `"use client";` line from `src/app/page.tsx`. Nothing else changes (`dynamic()` without `ssr:false`... keep `{ ssr: false }` for Scene).

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: all green; build output contains route `/` prerendered/static (not `ƒ` dynamic due to client).

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "refactor: make home page a server component, scene stays client island"
```

---

### Task 5: Extract viz spec types from store (P1-5)

**Files:**
- Create: `src/lib/visualization/types.ts` (move `VisualizationType, MetricDatum, SeriesDatum, NodeDatum, GeoPoint, TimelineEvent, VizData, VisualizationSpec, VizFocus, VizLifecycle, VisualizationEntry` + `nextVisualizationId`? no — id counter stays in store)
- Modify: `src/lib/store.ts` (import + `export type { ... }` re-export for back-compat)
- Test: no behavior change; gate is `lint + typecheck + unit`.

**Interfaces:**
- Consumes: nothing new.
- Produces: `@/lib/visualization/types` canonical types; `@/lib/store` re-exports all (existing imports keep working).

- [ ] **Step 1: Create `src/lib/visualization/types.ts`** with the moved interfaces verbatim (copy from `store.ts:24-98`).

- [ ] **Step 2: Update `store.ts`** — replace moved declarations with `import type { ... } from "@/lib/visualization/types";` + `export type { ... } from "@/lib/visualization/types";`. Keep `nextVisualizationId` and all store logic untouched.

- [ ] **Step 3: Update direct importers (optional, keep minimal)** — leave all `@/lib/store` type imports as-is (re-export covers them). Only `normalization.ts`, `events.ts`, `vizPlanner.ts`, `layoutResolver.ts`, viz components may switch to the new path in a follow-up; NOT this task.

- [ ] **Step 4: Verify**

Run: `npm run lint && npm run typecheck && npx playwright test --project=unit`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visualization/types.ts src/lib/store.ts
git commit -m "refactor: extract visualization spec types to lib/visualization/types"
```

---

### Task 6: Split Hud.tsx (P1-6)

**Files:**
- Create: `src/components/friday/hud/TopHud.tsx`, `EdgeTelemetry.tsx`, `AnswerLine.tsx`, `StateRail.tsx`, `VizRail.tsx`, `FocusPanel.tsx`, `AudioCues.tsx`, `useHudDepth.ts` (move verbatim, fix imports)
- Modify: `src/components/friday/hud/Hud.tsx` (re-export all for back-compat)
- Test: existing UI specs import from `@/components/friday/hud/Hud` — re-exports keep them green.

**Interfaces:**
- Consumes: `@/lib/store`, `@/lib/telemetry`, `@/lib/stateLook`, `@/lib/vizPlanner`, `@/lib/uiSound` as today.
- Produces: same named exports from same `@/components/friday/hud/Hud` path.

`useHudDepth` improvement (part of the move into `useHudDepth.ts`): subscribe to reduced-motion instead of calling `matchMedia` every render, memoize style:

```ts
"use client";
import { useMemo, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { useTelemetry } from "@/lib/telemetry";
import { STATE_CAMERA } from "@/lib/stateLook";

function subscribeReducedMotion(cb: () => void): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function useHudDepth(strength = 14): CSSProperties {
  const t = useTelemetry();
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  return useMemo(() => {
    const near = STATE_CAMERA.thinking.distance;
    const far = STATE_CAMERA.visualizing.distance;
    const depth = Math.min(1, Math.max(0, (t.camera[2] - near) / (far - near)));
    if (reduced) return { opacity: 1 };
    return {
      transform: `translate3d(${(-t.camera[0] * strength).toFixed(2)}px, ${(-t.camera[1] * strength).toFixed(2)}px, 0)`,
      opacity: 0.96 + depth * 0.04,
      transition: "transform 280ms linear, opacity 280ms linear",
      willChange: "transform",
    };
  }, [t.camera, reduced, strength]);
}
```

- [ ] **Step 1-2: Move each component verbatim** into its file (TopHud+useClock, EdgeTelemetry, AnswerLine, VizRail+devRailsEnabled+VIZ_OPTIONS, FocusPanel, StateRail+STATE_OPTIONS, AudioCues). `Hud.tsx` becomes re-exports only.
- [ ] **Step 3: Verify** `npm run lint && npm run typecheck && npx playwright test --project=unit`
- [ ] **Step 4: Commit** `git commit -m "refactor: split Hud.tsx into per-component modules with re-exports"`

---

### Task 7: P2 small fixes batch

**Files:**
- `src/lib/telemetry.ts` — pause rAF when tab hidden (`visibilitychange`), export `stopTelemetry()` for tests.
- `src/lib/uiSound.ts` — reuse `getSharedAudioContext()` instead of module-local `ctx`.
- `src/components/friday/hud/ConfirmPrompt.tsx` — ESC attempts `decide(id, false)` fire-and-forget (backend unblocks now, not in 120s), still dismisses locally; log delivery failure.
- `src/app/globals.css` — `scan-sweep to translateY(100vh)` → `100dvh`.
- `src/lib/visualization/layoutResolver.ts` — remove unused `viewportWidth`/`hasCore` from `LayoutContext`; update `FridayVisualization.tsx` call site + `tests/unit/vizNormalize.spec.ts` `base` object.
- `README.md` project-structure section — add new files from Tasks 5-6.

- [ ] **Step 1: Implement each bullet** (each is independent; keep diffs minimal).
- [ ] **Step 2: Verify** `npm run lint && npm run typecheck && npx playwright test --project=unit`
- [ ] **Step 3: Commit** `git commit -m "fix: P2 batch — telemetry pause, shared audio ctx, confirm ESC delivery, dvh sweep, layout ctx cleanup"`
