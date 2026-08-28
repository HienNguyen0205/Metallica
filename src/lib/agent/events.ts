import type { VisualizationSpec } from "@/lib/store";
import type { FridayState } from "@/lib/agent/stateMachine";

export type { FridayState };

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
      const s = payload.state as string | undefined;
      if (!s) return null;
      return { type: "state", state: s as FridayState };
    }
    case "tool": {
      const tool = String(payload.tool ?? "");
      const risk = (payload.risk as string) ?? "low";
      if (!tool) return null;
      return { type: "tool", tool, risk: risk as "low" | "medium" | "high" };
    }
    case "confirm": {
      const id = String(payload.id ?? "");
      const tool = String(payload.tool ?? "");
      const risk = (payload.risk as string) ?? "high";
      const input = (payload.input as Record<string, unknown>) ?? {};
      if (!id || !tool) return null;
      return { type: "confirm", id, tool, risk: risk as "low" | "medium" | "high", input };
    }
    case "denied": {
      const tool = String(payload.tool ?? "");
      if (!tool) return null;
      return { type: "denied", tool };
    }
    case "viz": {
      // payload IS the VisualizationSpec already (BE sends it flat)
      const spec = payload as unknown as VisualizationSpec;
      if (!spec.type) return null;
      return { type: "viz", spec };
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
      return {
        type: "memory",
        id: Number(payload.id),
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
