import { create } from "zustand";

/** §17 — the state every holographic component subscribes to. */
export type FridayState =
  | "idle"
  | "listening"
  | "thinking"
  | "searching"
  | "processing"
  | "tool_execution"
  | "visualizing"
  | "speaking"
  | "warning"
  | "error";

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

/** §17 — the allowed edges of the machine. */
const TRANSITIONS: Record<FridayState, FridayState[]> = {
  idle: ["listening", "thinking", "warning", "error"],
  listening: ["thinking", "idle", "warning", "error"],
  thinking: ["searching", "tool_execution", "processing", "visualizing", "speaking", "warning", "error"],
  searching: ["processing", "tool_execution", "visualizing", "speaking", "warning", "error"],
  processing: ["visualizing", "tool_execution", "speaking", "warning", "error"],
  tool_execution: ["processing", "visualizing", "speaking", "warning", "error"],
  visualizing: ["speaking", "processing", "idle", "warning", "error"],
  speaking: ["idle", "listening", "warning", "error"],
  warning: ["idle", "speaking", "error"],
  error: ["idle"],
};

export interface FridayStore {
  state: FridayState;
  /** Guarded move along the machine; ignores illegal edges. */
  transition: (next: FridayState) => void;
  /** Unguarded — used by the state rail for previewing looks. */
  setState: (state: FridayState) => void;
  answer: string | null;
  setAnswer: (answer: string | null) => void;
  visualization: VisualizationSpec | null;
  setVisualization: (viz: VisualizationSpec | null) => void;
  focus: VizFocus | null;
  setFocus: (focus: VizFocus | null) => void;
  pendingConfirm: PendingConfirm | null;
  setPendingConfirm: (pending: PendingConfirm | null) => void;
  renderBackend: RenderBackend;
  setRenderBackend: (backend: RenderBackend) => void;
  audioEnabled: boolean;
  toggleAudio: () => void;
  reset: () => void;
}

export const useFridayStore = create<FridayStore>((set, get) => ({
  state: "idle",
  transition: (next) => {
    if (TRANSITIONS[get().state].includes(next)) set({ state: next });
  },
  setState: (state) => set({ state }),
  answer: null,
  setAnswer: (answer) => set({ answer }),
  visualization: null,
  setVisualization: (visualization) => set({ visualization }),
  focus: null,
  setFocus: (focus) => set({ focus }),
  pendingConfirm: null,
  setPendingConfirm: (pendingConfirm) => set({ pendingConfirm }),
  renderBackend: "webgl2",
  setRenderBackend: (renderBackend) => set({ renderBackend }),
  audioEnabled: true,
  toggleAudio: () => set({ audioEnabled: !get().audioEnabled }),
  reset: () =>
    set({ state: "idle", answer: null, visualization: null, focus: null, pendingConfirm: null }),
}));
