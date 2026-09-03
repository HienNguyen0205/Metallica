import { create } from "zustand";
import { canTransition, reportIllegal } from "@/lib/agent/stateMachine";
import type { FridayState } from "@/lib/agent/stateMachine";
import type { SupportedLang } from "@/lib/audioBus";

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
  | "timeline"
  | "heatmap_3d";

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
  addVisualization: (viz: VisualizationSpec) => void;
  setVisualizations: (vizs: VisualizationSpec[]) => void;
  clearVisualizations: () => void;
  /** Flip a materializing entry to active once its entrance finishes. */
  settleVisualization: (index: number) => void;
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
  /** Speech-recognition language. Persisted to localStorage, survives reset. */
  lang: SupportedLang;
  setLang: (lang: SupportedLang) => void;
  audioEnabled: boolean;
  toggleAudio: () => void;
  /** Facts FRIDAY just learned, newest first; HUD shows only the latest. */
  memories: MemoryNote[];
  addMemory: (note: MemoryNote) => void;
  clearMemories: () => void;
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
  visualizations: [],
  addVisualization: (spec) =>
    set((s) => ({
      visualizations: [
        ...s.visualizations.map((e) => ({ ...e, lifecycle: "active" as const })),
        { spec, lifecycle: "materializing" as const },
      ].slice(-3),
    })),
  settleVisualization: (index) =>
    set((s) => ({
      visualizations: s.visualizations.map((e, i) =>
        i === index ? { ...e, lifecycle: "active" as const } : e,
      ),
    })),
  setVisualizations: (vizs) =>
    set({ visualizations: vizs.map((spec) => ({ spec, lifecycle: "materializing" as const })) }),
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
  lang: "en-US",
  setLang: (lang) => {
    try {
      localStorage.setItem("friday.lang", lang);
    } catch {
      /* private mode — preference just doesn't survive */
    }
    set({ lang });
  },
  audioEnabled: true,
  toggleAudio: () => set({ audioEnabled: !get().audioEnabled }),
  memories: [],
  addMemory: (note) =>
    // HUD hiện một dòng, không phải nhật ký — giữ ba cái gần nhất là đủ để
    // thấy FRIDAY vừa học gì mà không đẩy mọi thứ khác ra khỏi màn hình.
    set((s) => ({ memories: [note, ...s.memories].slice(0, 3) })),
  // Dọn ở đầu mỗi lượt, cùng chỗ với deniedTool. Không có nó, một sự thật học
  // được một lần hiện mãi mãi - qua mọi lượt sau và cả lúc rảnh - và một cảnh
  // báo luôn bật thì không còn là cảnh báo.
  clearMemories: () => set({ memories: [] }),
  reset: () =>
    set({
      state: "idle",
      answer: null,
      visualizations: [],
      focus: null,
      pendingConfirm: null,
      toolActivity: null,
      deniedTool: null,
      liveMode: "idle",
      sessionError: null,
      memories: [],
    }),
}));
