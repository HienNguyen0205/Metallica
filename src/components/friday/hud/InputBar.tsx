"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useFridayStore } from "@/lib/store";
import { runQuery } from "@/lib/agentStream";
import { canListen, startListening, stopSpeaking } from "@/lib/voice";

export default function InputBar() {
  const [value, setValue] = useState("");
  const state = useFridayStore((s) => s.state);
  const listening = state === "listening";
  const busy = state !== "idle" && !listening;
  // the live recogniser, kept out of state — stopping it is not a render
  const stopRef = useRef<(() => void) | null>(null);

  // A browser capability, not state: it never changes, but it must be read on
  // the client only — the server has no `window`, and the button must not
  // announce itself as a microphone before we know there is one.
  const micReady = useSyncExternalStore(
    useCallback(() => () => {}, []),
    canListen,
    () => false,
  );

  useEffect(() => () => stopRef.current?.(), []);

  const ask = (query: string, voice: boolean) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setValue("");
    void runQuery(useFridayStore.getState(), trimmed, { voice });
  };

  const toggleMic = () => {
    if (stopRef.current) {
      stopRef.current();
      stopRef.current = null;
      return;
    }
    // barge-in: talking over FRIDAY should stop it, not queue behind it
    stopSpeaking();

    useFridayStore.getState().setState("listening");
    let started = false;

    stopRef.current = startListening({
      onInterim: setValue,
      onFinal: (text) => {
        started = true;
        stopRef.current = null;
        // `listening → thinking` is a legal edge, so the turn starts straight
        // from here; routing through idle would flicker the whole rig back out.
        ask(text, true);
      },
      onEnd: (error) => {
        stopRef.current = null;
        setValue("");
        if (error) console.warn("[friday] microphone:", error);
        // Tracked with a flag rather than by reading the state: `onend` follows
        // `onresult` within a few ms, well before the orchestrator's first
        // event moves the machine off `listening`, so a state check here would
        // still see LISTENING and blink the rig through IDLE on every phrase.
        if (!started) useFridayStore.getState().setState("idle");
      },
    });
  };

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-10 flex flex-col items-center gap-2 px-8">
      <div className="flex w-full max-w-md items-center gap-3">
        <button
          onClick={toggleMic}
          disabled={!micReady || busy}
          aria-label={micReady ? "Toggle microphone" : "Microphone unavailable in this browser"}
          aria-pressed={listening}
          className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all disabled:cursor-not-allowed ${
            listening
              ? "bg-cyan-300 shadow-[0_0_10px_3px_rgba(56,232,255,0.6)]"
              : micReady
                ? "bg-cyan-300/25 hover:bg-cyan-300/60"
                : "bg-cyan-300/10"
          }`}
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && ask(value, false)}
          disabled={busy}
          placeholder={busy ? "" : listening ? "LISTENING" : "ASK FRIDAY"}
          className="flex-1 bg-transparent text-center font-mono text-[11px] uppercase tracking-[0.3em] text-cyan-100 placeholder:text-cyan-300/60 focus:outline-none disabled:opacity-30"
        />
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300/25" />
      </div>
      {/* a hairline, not an input box */}
      <div className="h-px w-full max-w-md bg-gradient-to-r from-transparent via-cyan-300/30 to-transparent" />
    </div>
  );
}
