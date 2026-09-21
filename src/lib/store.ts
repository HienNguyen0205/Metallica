import { create } from "zustand";
import { canTransition, reportIllegal } from "@/lib/agent/stateMachine";
import type { FridayState } from "@/lib/agent/stateMachine";
// reportIllegal intentionally NOT used by endTurn: landing idle from a
// mid-pipeline state (e.g. thinking → idle on missing `done`) is the normal
// interrupted-turn path, not a bug worth warning about in dev/test.
import type { SupportedLang } from "@/lib/audioBus";
import type { CurrentStep } from "@/lib/agent/events";
import type { DeviceState } from "@/lib/deviceMonitor";
import type {
  GeoPoint,
  GlobeRoute,
  MetricDatum,
  NodeDatum,
  SeriesDatum,
  TimelineEvent,
  VisualizationEntry,
  VisualizationSpec,
  VisualizationType,
  VizData,
  VizFocus,
  VizLifecycle,
} from "@/lib/visualization/types";
import {
  INITIAL_MAP_VIEW,
  closeMapState,
  mapViewAfterSpec,
  openMapState,
  settleMapState,
  type MapViewState,
  type OpenMapRequest,
} from "@/lib/mapView";

export type { FridayState };
export type { CurrentStep };
export type {
  GeoPoint,
  GlobeRoute,
  MetricDatum,
  NodeDatum,
  SeriesDatum,
  TimelineEvent,
  VisualizationEntry,
  VisualizationSpec,
  VisualizationType,
  VizData,
  VizFocus,
  VizLifecycle,
};

/** localStorage key for the recognition language. Single source — do not duplicate. */
export const FRIDAY_LANG_KEY = "friday.lang";

/**
 * SSR-stable seed for the recognition language. Deliberately a constant, NOT
 * `resolveLang(navigator, localStorage)`: the store is created while the page
 * renders, and reading `localStorage` there gave the server (no storage) and
 * the first client render (a stored `vi-VN`) different values — a hydration
 * mismatch that regenerated the whole tree. A stored choice is applied *after*
 * mount by InputBar's hydration effect, so server and first client render agree.
 */
export const INITIAL_LANG: SupportedLang = "en-US";

/** §13 — active tool instrumentation (secondary to core, not a card). */
export interface ToolActivity {
  tool: string;
  risk: "low" | "medium" | "high";
}

/** §18 — live vs offline demo distinguishability. */
export type LiveMode = "connecting" | "live" | "offline" | "idle";

/**
 * §11 — a high-risk tool call waiting on the operator. Deliberately not a
 * FridayState: approval is a question about one tool, not a mode the whole
 * hologram is in, and the agent stays in TOOL EXECUTION while it waits.
 */
export interface PendingConfirm {
  id: string;
  tool: string;
  risk: "low" | "medium" | "high";
  input: Record<string, unknown>;
}

/** Location sharing — off until the operator turns it on. */
export type LocationStatus = "off" | "pending" | "on" | "denied" | "unavailable";

/** Actual rendering backend reported by the created renderer. */
export type RenderBackend = "webgl2" | "webgpu";

/** Render quality preference — auto follows hardware + reduced-motion. */
export type RenderQuality = "auto" | "high" | "low";

/**
 * A fact FRIDAY chose to remember on its own. `provenance: "tool"` means it
 * came from a page the model searched, not the operator's own words — the
 * HUD must mark that distinctly since nothing else gates the write.
 */
export interface MemoryNote {
  id: number;
  fact: string;
  provenance: "user" | "tool";
}

export interface FridayStore {
  state: FridayState;
  /** Guarded move along the machine; ignores illegal edges but reports them in dev. */
  transition: (next: FridayState) => void;
  /** Unguarded — used by the state rail for previewing looks. */
  setState: (state: FridayState) => void;
  /**
   * End-of-turn landing. A turn must reach idle from wherever the stream left
   * off — the orchestrator can die mid-pipeline, or end after `done` without
   * ever announcing `speaking`, and most pipeline states have no `idle` edge.
   * Unlike `transition` this cannot be ignored (a stuck machine freezes the
   * input bar until reload), and unlike `reset` it keeps the turn's output —
   * the answer and scene the user is reading — on screen.
   */
  endTurn: () => void;
  answer: string | null;
  setAnswer: (answer: string | null) => void;
  /**
   * §13/§8 — the visualization scene, and the only record of it.
   *
   * A `visualization` field used to sit alongside this holding "the latest
   * spec", re-derived by hand in four separate setters. It was never anything
   * but `visualizations.at(-1)?.spec`, and two fields that must agree are two
   * fields that can disagree. Consumers that want the latest read it here.
   */
  visualizations: VisualizationEntry[];
  addVisualization: (viz: VisualizationSpec, opts?: { preview?: boolean }) => void;
  setVisualizations: (vizs: VisualizationSpec[]) => void;
  clearVisualizations: () => void;
  /** Flip a materializing entry to active once its entrance finishes (by stable id). */
  settleVisualization: (id: number) => void;
  focus: VizFocus | null;
  setFocus: (focus: VizFocus | null) => void;
  pendingConfirm: PendingConfirm | null;
  setPendingConfirm: (pending: PendingConfirm | null) => void;
  /** §11/§2 — live tool instrumentation */
  toolActivity: ToolActivity | null;
  setToolActivity: (activity: ToolActivity | null) => void;
  deniedTool: string | null;
  setDeniedTool: (tool: string | null) => void;
  /** §18 — live vs offline indicator */
  liveMode: LiveMode;
  setLiveMode: (mode: LiveMode) => void;
  sessionError: string | null;
  setSessionError: (msg: string | null) => void;
  renderBackend: RenderBackend;
  setRenderBackend: (backend: RenderBackend) => void;
  quality: RenderQuality;
  setQuality: (quality: RenderQuality) => void;
  /**
   * Global "freeze the motion" toggle (Space on the globe). Pauses the planet's
   * auto-rotation AND the terminator's slow sun cycle together, so pausing
   * reads as stopping the world, not just the spin. A display preference, so it
   * survives `reset` like `quality`/`lang`.
   */
  motionPaused: boolean;
  toggleMotion: () => void;
  /**
   * Camera ownership (§60/§16 of the globe docs). The cinematic CameraRig owns
   * the camera for normal visualizations; an active GLOBE takes over for
   * geographic navigation (orbit distance/tilt/focus dolly). Ref-counted so
   * two globes on stage cannot hand the camera back early.
   */
  globeCameraHolders: number;
  acquireGlobeCamera: () => void;
  releaseGlobeCamera: () => void;
  /** Street map mode (spec §3). Intent only — the globe and the map layer animate from it. */
  mapView: MapViewState;
  openMap: (req: OpenMapRequest) => void;
  closeMap: (center?: { lat: number; lon: number }) => void;
  settleMap: () => void;
  /** Speech-recognition language. Hydrated from localStorage in the initializer, survives reset. */
  lang: SupportedLang;
  setLang: (lang: SupportedLang) => void;
  audioEnabled: boolean;
  toggleAudio: () => void;
  /**
   * The operator's shared location at full precision, with the browser's
   * accuracy radius (m). In memory only — never written to storage — and
   * null unless they turned it on.
   */
  location: { lat: number; lon: number; accuracy?: number } | null;
  locationStatus: LocationStatus;
  setLocation: (location: { lat: number; lon: number; accuracy?: number } | null, status: LocationStatus) => void;
  /** Live device readings, kept current by startDeviceMonitor's event listeners. */
  device: DeviceState;
  setDevice: (patch: Partial<DeviceState>) => void;
  /** Facts FRIDAY just learned, newest first; HUD shows only the latest. */
  memories: MemoryNote[];
  addMemory: (note: MemoryNote) => void;
  clearMemories: () => void;
  /** P0.2 — the step the agent is executing right now (from `step` events). */
  currentStep: CurrentStep | null;
  setCurrentStep: (step: CurrentStep | null) => void;
  reset: () => void;
}

let nextVisualizationId = 1;

export const useFridayStore = create<FridayStore>((set, get) => ({
  state: "idle",
  transition: (next) => {
    const from = get().state;
    if (from === next) return;
    if (canTransition(from, next)) set({ state: next });
    else reportIllegal(from, next, "transition");
  },
  setState: (state) => set({ state }),
  endTurn: () => {
    if (get().state === "idle") return;
    // Deliberately unguarded and silent — see the doc above. The direct set
    // is the safety net for streams that died mid-pipeline; reporting it as
    // illegal spams dev/test logs on every interrupted turn (thinking → idle
    // has no edge by design). Use `transition` when the edge must be legal.
    set({ state: "idle" });
  },
  answer: null,
  setAnswer: (answer) => set({ answer }),
  visualizations: [],
  addVisualization: (spec, opts) =>
    set((s) => {
      // Previews are transient: a new entry — preview or real — replaces
      // earlier previews instead of appending after them. Preview → viz used
      // to cost two of the three slots and evict a real visualization.
      const base = s.visualizations.filter((e) => !e.preview);
      return {
        visualizations: [
          ...base.map((e) => ({ ...e, lifecycle: "active" as const })),
          {
            id: nextVisualizationId++,
            spec,
            lifecycle: "materializing" as const,
            preview: !!opts?.preview,
          },
        ].slice(-3),
        mapView: mapViewAfterSpec(s.mapView, spec),
      };
    }),
  settleVisualization: (id) =>
    set((s) => ({
      visualizations: s.visualizations.map((e) =>
        e.id === id ? { ...e, lifecycle: "active" as const } : e,
      ),
    })),
  setVisualizations: (vizs) =>
    set((s) => {
      const last = vizs.at(-1);
      return {
        // Capped like addVisualization — one bulk set must not mount unbounded
        // CanvasTextures/Line2/labels (load-bearing on low-end GPUs).
        visualizations: vizs.slice(-3).map((spec) => ({
          id: nextVisualizationId++,
          spec,
          lifecycle: "materializing" as const,
        })),
        mapView: last ? mapViewAfterSpec(s.mapView, last) : s.mapView,
      };
    }),
  clearVisualizations: () => set({ visualizations: [] }),
  focus: null,
  setFocus: (focus) => set({ focus }),
  pendingConfirm: null,
  setPendingConfirm: (pendingConfirm) => set({ pendingConfirm }),
  toolActivity: null,
  setToolActivity: (toolActivity) => set({ toolActivity }),
  deniedTool: null,
  setDeniedTool: (deniedTool) => set({ deniedTool }),
  liveMode: "idle",
  setLiveMode: (liveMode) => set({ liveMode }),
  sessionError: null,
  setSessionError: (sessionError) => set({ sessionError }),
  renderBackend: "webgl2",
  setRenderBackend: (renderBackend) => set({ renderBackend }),
  quality: "auto",
  setQuality: (quality) => set({ quality }),
  motionPaused: false,
  toggleMotion: () => set((s) => ({ motionPaused: !s.motionPaused })),
  globeCameraHolders: 0,
  acquireGlobeCamera: () => set((s) => ({ globeCameraHolders: s.globeCameraHolders + 1 })),
  releaseGlobeCamera: () =>
    set((s) => ({ globeCameraHolders: Math.max(0, s.globeCameraHolders - 1) })),
  mapView: INITIAL_MAP_VIEW,
  openMap: (req) => set((s) => ({ mapView: openMapState(s.mapView, req) })),
  closeMap: (center) => set((s) => ({ mapView: closeMapState(s.mapView, center) })),
  settleMap: () => set((s) => ({ mapView: settleMapState(s.mapView) })),
  lang: INITIAL_LANG,
  setLang: (lang) => {
    try {
      localStorage.setItem(FRIDAY_LANG_KEY, lang);
    } catch {
      /* private mode — preference just doesn't survive */
    }
    set({ lang });
  },
  audioEnabled: true,
  toggleAudio: () => set({ audioEnabled: !get().audioEnabled }),
  location: null,
  locationStatus: "off",
  setLocation: (location, locationStatus) => set({ location, locationStatus }),
  device: { online: true },
  setDevice: (patch) => set((s) => ({ device: { ...s.device, ...patch } })),
  memories: [],
  addMemory: (note) =>
    // HUD shows one line, not a log — keep the 3 most recent so the operator
    // sees what FRIDAY just learned without pushing everything else off screen.
    set((s) => ({ memories: [note, ...s.memories].slice(0, 3) })),
  // Cleared at the start of each turn, alongside deniedTool. Without this, a
  // fact learned once would display forever — across later turns and idle —
  // and an always-on alert stops being an alert.
  clearMemories: () => set({ memories: [] }),
  currentStep: null,
  setCurrentStep: (currentStep) => set({ currentStep }),
  /**
   * Back to idle, scene cleared. Deliberately preserves user/hardware prefs:
   * renderBackend, quality, lang, audioEnabled survive — everything else resets.
   */
  reset: () =>
    set({
      state: "idle",
      answer: null,
      visualizations: [],
      mapView: INITIAL_MAP_VIEW,
      focus: null,
      pendingConfirm: null,
      toolActivity: null,
      deniedTool: null,
      liveMode: "idle",
      sessionError: null,
      memories: [],
      currentStep: null,
      globeCameraHolders: 0,
    }),
}));
