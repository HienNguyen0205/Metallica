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

/** §17/§19 — allowed edges. Keep explicit, not "any -> any". */
export const TRANSITIONS: Record<FridayState, FridayState[]> = {
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

export interface IllegalTransition {
  from: FridayState;
  to: FridayState;
  event?: string;
}

type Handler = (info: IllegalTransition) => void;

let illegalHandler: Handler | null = null;

export function onIllegalTransition(handler: Handler | null): void {
  illegalHandler = handler;
}

export function canTransition(from: FridayState, to: FridayState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function reportIllegal(from: FridayState, to: FridayState, event?: string): void {
  if (process.env.NODE_ENV !== "production") {
    // Always warn visibly in dev; handler is additional
    console.warn(`[friday] illegal transition ${from} → ${to}${event ? ` (${event})` : ""}`);
  }
  illegalHandler?.({ from, to, event });
}

/** Guarded transition — returns true if applied. */
export function guardedTransition(
  current: FridayState,
  next: FridayState,
  apply: (s: FridayState) => void,
  event?: string,
): boolean {
  if (current === next) return true;
  if (canTransition(current, next)) {
    apply(next);
    return true;
  }
  reportIllegal(current, next, event);
  return false;
}
