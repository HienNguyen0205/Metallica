"use client";

import { useState } from "react";
import { useFridayStore } from "@/lib/store";
import { runQuery } from "@/lib/demoQuery";

export default function InputBar() {
  const [value, setValue] = useState("");
  const state = useFridayStore((s) => s.state);
  const busy = state !== "idle" && state !== "listening";

  const submit = () => {
    const query = value.trim();
    if (!query || busy) return;
    setValue("");
    void runQuery(useFridayStore.getState(), query);
  };

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-10 flex flex-col items-center gap-2 px-8">
      <div className="flex w-full max-w-md items-center gap-3">
        <button
          onClick={() => useFridayStore.getState().setState(state === "listening" ? "idle" : "listening")}
          aria-label="Toggle microphone"
          className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${
            state === "listening"
              ? "bg-cyan-300 shadow-[0_0_10px_3px_rgba(56,232,255,0.6)]"
              : "bg-cyan-300/25 hover:bg-cyan-300/60"
          }`}
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={busy}
          placeholder={busy ? "" : "ASK FRIDAY"}
          className="flex-1 bg-transparent text-center font-mono text-[11px] uppercase tracking-[0.3em] text-cyan-100 placeholder:text-cyan-300/60 focus:outline-none disabled:opacity-30"
        />
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300/25" />
      </div>
      {/* a hairline, not an input box */}
      <div className="h-px w-full max-w-md bg-gradient-to-r from-transparent via-cyan-300/30 to-transparent" />
    </div>
  );
}
