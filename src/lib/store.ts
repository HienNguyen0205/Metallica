import { create } from "zustand";
import { canTransition, reportIllegal, TRANSITIONS } from "@/lib/agent/stateMachine";
import type { FridayState } from "@/lib/agent/stateMachine";

export type { FridayState };

/** §16 — visualization kinds the renderer can materialize. */
export type VisualizationType =
  | "radial_gauge"
  | "health_core"
  | "radar"
  | "waveform"
  | "network"
  | "line_3d"
  | "bar_3d"
  | "particle_flow"
  | "globe"
  | "timeline";

export interface MetricDatum {
  label: string;
  value: number;
  unit?: string;
}
export interface SeriesDatum {
  label: string;
  points: number[];
}
export interface NodeDatum {
  id: string;
  label?: string;
}
export interface GeoPoint {
  lat: number;
  lon: number;
  label?: string;
}
export interface TimelineEvent {
  label: string;
  at: number;
}

export interface VizData {
  metrics?: MetricDatum[];
  series?: SeriesDatum[];
  nodes?: NodeDatum[];
  links?: [number, number][];
  points?: GeoPoint[];
  events?: TimelineEvent[];
  rate?: number;
}

/** §16/§5 — renderer contract. Pages never pick a component, only a spec. */
export interface VisualizationSpec {
  type: VisualizationType;
  data?: VizData;
  animation?: "materialize" | "pulse" | "none";
  /** "none" disables picking; anything else allows click-to-inspect. */
  interaction?: "none" | "drill_down";
  theme?: { color?: string; accent?: string };
  position?: [number, number, number];
  scale?: number;
  title?: string;
}

/** A visualization element the user drilled into. */
export interface VizFocus {
  label: string;
  detail: string;
  position: [number, number, number];
}

export type VizLifecycle = "materializing" | "active" | "updating" | "settling";

export interface VisualizationEntry {
  spec: VisualizationSpec;
  lifecycle: VizLifecycle;
}

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

/** Actual rendering backend reported by the created renderer. */
export type RenderBackend = "webgl2" | "webgpu";

// Re-export canonical transition table for backwards compat (some tests may import via store)
export { TRANSITIONS };

export interface FridayStore {
  state: FridayState;
  /** Guarded move along the machine; ignores illegal edges but reports them in dev. */
  transition: (next: FridayState) => void;
  /** Unguarded — used by the state rail for previewing looks. */
  setState: (state: FridayState) => void;
  answer: string | null;
  setAnswer: (answer: string | null) => void;
  visualization: VisualizationSpec | null;
  setVisualization: (viz: VisualizationSpec | null) => void;
  /** §13/§8 — multi-viz scene; kept in sync with `visualization` for legacy tests. */
  visualizations: VisualizationEntry[];
  addVisualization: (viz: VisualizationSpec) => void;
  setVisualizations: (vizs: VisualizationSpec[]) => void;
  clearVisualizations: () => void;
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
  audioEnabled: boolean;
  toggleAudio: () => void;
  reset: () => void;
}

export const useFridayStore = create<FridayStore>((set, get) => ({
  state: "idle",
  transition: (next) => {
    const from = get().state;
    if (from === next) return;
    if (canTransition(from, next)) set({ state: next });
    else reportIllegal(from, next, "transition");
  },
  setState: (state) => set({ state }),
  answer: null,
  setAnswer: (answer) => set({ answer }),
  visualization: null,
  setVisualization: (visualization) => {
    if (!visualization) {
      set({ visualization: null, visualizations: [] });
      return;
    }
    set({
      visualization,
      visualizations: [{ spec: visualization, lifecycle: "materializing" as const }],
    });
  },
  visualizations: [],
  addVisualization: (spec) =>
    set((s) => {
      const entry: VisualizationEntry = { spec, lifecycle: "materializing" };
      const next = [...s.visualizations.map((e) => ({ ...e, lifecycle: "active" as const })), entry];
      // keep legacy single-viz pointer to latest for old consumers
      return { visualizations: next, visualization: spec };
    }),
  setVisualizations: (vizs) =>
    set({
      visualizations: vizs.map((spec) => ({ spec, lifecycle: "materializing" as const })),
      visualization: vizs.at(-1) ?? null,
    }),
  clearVisualizations: () => set({ visualizations: [], visualization: null }),
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
  audioEnabled: true,
  toggleAudio: () => set({ audioEnabled: !get().audioEnabled }),
  reset: () =>
    set({
      state: "idle",
      answer: null,
      visualization: null,
      visualizations: [],
      focus: null,
      pendingConfirm: null,
      toolActivity: null,
      deniedTool: null,
      liveMode: "idle",
      sessionError: null,
    }),
}));
