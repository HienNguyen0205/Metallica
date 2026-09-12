"use client";

import { useFridayStore, type FridayState } from "@/lib/store";
import { devRailsEnabled } from "./devRails";

const STATE_OPTIONS: FridayState[] = [
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
];

export function StateRail() {
  const state = useFridayStore((s) => s.state);
  const setState = useFridayStore((s) => s.setState);

  if (!devRailsEnabled()) return null;

  return (
    <div
      className="pointer-events-auto absolute right-8 top-28 hidden flex-col items-end gap-1.5 font-mono text-[10px] tracking-[0.16em] md:flex"
      id="state-rail"
    >
      {STATE_OPTIONS.map((s) => (
        <button
          key={s}
          onClick={() => setState(s)}
          className={`transition-colors ${
            state === s ? "text-cyan-200" : "text-cyan-300/75 hover:text-cyan-200"
          }`}
        >
          {state === s ? "▸ " : ""}
          {s.replace("_", " ").toUpperCase()}
        </button>
      ))}
    </div>
  );
}
