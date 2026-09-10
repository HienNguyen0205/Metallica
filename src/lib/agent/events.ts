import type { VisualizationSpec, VisualizationType } from "@/lib/visualization/types";
import type { FridayState } from "@/lib/agent/stateMachine";

export type { FridayState };

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "idle",
  "listening",
  "thinking",
  "searching",
  "processing",
  "tool_execution",
  "visualizing",
  "speaking",
  "warning",
  "error",
]);

const KNOWN_RISKS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

const KNOWN_VIZ: ReadonlySet<string> = new Set([
  "radial_gauge",
  "health_core",
  "radar",
  "waveform",
  "network",
  "line_3d",
  "bar_3d",
  "particle_flow",
  "globe",
  "timeline",
  "heatmap_3d",
]);

/**
 * Canonical discriminated union — single source of truth for BE→FE events.
 * No other parser shape may exist elsewhere.
 */
export type FridayEvent =
  | { type: "state"; state: FridayState }
  | { type: "tool"; tool: string; risk: "low" | "medium" | "high" }
  | { type: "confirm"; id: string; tool: string; risk: "low" | "medium" | "high"; input: Record<string, unknown> }
  | { type: "denied"; tool: string }
  | { type: "viz"; spec: VisualizationSpec }
  | { type: "preview"; spec: VisualizationSpec }
  | { type: "answer"; text: string }
  | { type: "error"; message: string }
  | { type: "memory"; id: number; fact: string; provenance: "user" | "tool" }
  | { type: "done" };

export interface RawFrame {
  event: string;
  data: string;
}

/**
 * Converts a raw SSE frame (event + data string) into a typed FridayEvent.
 * Returns null for unknown event types or malformed payloads.
 */
export function parseFridayEvent(raw: RawFrame): FridayEvent | null {
  const { event, data } = raw;
  if (event === "done") return { type: "done" };

  let payload: Record<string, unknown>;
  try {
    payload = data ? (JSON.parse(data) as Record<string, unknown>) : {};
  } catch {
    return { type: "error", message: "malformed event payload" };
  }

  switch (event) {
    case "state": {
      const s = payload.state;
      if (typeof s !== "string" || !KNOWN_STATES.has(s)) return null;
      return { type: "state", state: s as FridayState };
    }
    case "tool": {
      const tool = String(payload.tool ?? "");
      const risk = String(payload.risk ?? "low");
      if (!tool || !KNOWN_RISKS.has(risk)) return null;
      return { type: "tool", tool, risk: risk as "low" | "medium" | "high" };
    }
    case "confirm": {
      const id = String(payload.id ?? "");
      const tool = String(payload.tool ?? "");
      const risk = String(payload.risk ?? "high");
      const input =
        payload.input && typeof payload.input === "object"
          ? (payload.input as Record<string, unknown>)
          : {};
      if (!id || !tool || !KNOWN_RISKS.has(risk)) return null;
      return { type: "confirm", id, tool, risk: risk as "low" | "medium" | "high", input };
    }
    case "denied": {
      const tool = String(payload.tool ?? "");
      if (!tool) return null;
      return { type: "denied", tool };
    }
    case "viz":
    case "preview": {
      // payload IS the VisualizationSpec already (BE sends it flat).
      // `preview` is the early materialize (§18): same shape, rendered
      // non-interactive. Normalize the kind here so a raw `preview` frame
      // never drops silently when the backend streams it unwrapped.
      const spec = payload as unknown as VisualizationSpec;
      if (!spec.type || !KNOWN_VIZ.has(spec.type as string)) return null;
      const normalized = { ...spec, type: spec.type as VisualizationType };
      if (event === "preview") {
        return {
          type: "preview",
          spec: { ...normalized, interaction: "none" as const, animation: normalized.animation ?? "materialize" as const },
        };
      }
      return { type: "viz", spec: normalized };
    }
    case "answer": {
      const text = String(payload.text ?? "");
      return { type: "answer", text };
    }
    case "error": {
      const message = String(payload.message ?? payload.text ?? "unknown error");
      return { type: "error", message };
    }
    case "memory": {
      if (typeof payload.fact !== "string") return null;
      const id = Number(payload.id);
      if (!Number.isFinite(id)) return null;
      return {
        type: "memory",
        id,
        fact: payload.fact,
        provenance: payload.provenance === "tool" ? "tool" : "user",
      };
    }
    default:
      return null;
  }
}

/** Type guards */
export function isStateEvent(e: FridayEvent): e is Extract<FridayEvent, { type: "state" }> {
  return e.type === "state";
}

/**
 * P0.1 event envelope — backward-compatible SSE consumer.
 *
 * Today's backend emits flat frames (`event: state / data: {"state": ...}`).
 * `unwrapEnvelope` passes those through byte-identically while also accepting
 * future `{version:1, event, payload, ...}` envelopes (see
 * docs/CLAUDE_IMPROVEMENT_PLAN.md §3). Rejected envelopes are dropped by the
 * caller with a warn log; they never reach `parseFridayEvent`.
 */
export interface EnvelopeMeta {
  version: 1;
  runId: string | null;
  sessionId: string | null;
  turnId: string | null;
  sequence: number | null;
  timestamp: string | null;
}

export type UnwrapResult =
  | { kind: "flat"; event: string; data: string }
  | { kind: "enveloped"; event: string; data: string; meta: EnvelopeMeta }
  | { kind: "rejected"; reason: string };

export function unwrapEnvelope(frameEvent: string, rawData: string): UnwrapResult {
  let parsed: unknown;
  try {
    parsed = rawData ? JSON.parse(rawData) : {};
  } catch {
    return { kind: "flat", event: frameEvent, data: rawData };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "flat", event: frameEvent, data: rawData };
  }
  const obj = parsed as Record<string, unknown>;
  if (!("version" in obj)) return { kind: "flat", event: frameEvent, data: rawData };
  if (obj.version !== 1) return { kind: "rejected", reason: "unsupported-envelope-version" };
  if (typeof obj.event !== "string" || obj.event !== frameEvent) {
    return { kind: "rejected", reason: "envelope-event-mismatch" };
  }
  if (typeof obj.payload !== "object" || obj.payload === null || Array.isArray(obj.payload)) {
    return { kind: "rejected", reason: "envelope-bad-payload" };
  }
  let sequence: number | null = null;
  if ("sequence" in obj && obj.sequence !== undefined && obj.sequence !== null) {
    if (typeof obj.sequence !== "number" || !Number.isInteger(obj.sequence) || obj.sequence < 1) {
      return { kind: "rejected", reason: "envelope-bad-sequence" };
    }
    sequence = obj.sequence;
  }
  const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
  for (const k of ["run_id", "session_id", "turn_id", "timestamp"] as const) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null && (typeof obj[k] !== "string" || obj[k] === "")) return { kind: "rejected", reason: "envelope-bad-field" };
  }
  return {
    kind: "enveloped",
    event: obj.event,
    data: JSON.stringify(obj.payload),
    meta: {
      version: 1,
      runId: strOrNull(obj.run_id),
      sessionId: strOrNull(obj.session_id),
      turnId: strOrNull(obj.turn_id),
      sequence,
      timestamp: strOrNull(obj.timestamp),
    },
  };
}
