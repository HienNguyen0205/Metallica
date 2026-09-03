"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useFridayStore } from "@/lib/store";
import { runQuery } from "@/lib/agentStream";
import { canListen, startListening, stopSpeaking } from "@/lib/voice";
import { attachMic, detachMic, resolveLang } from "@/lib/audioBus";

const LANG_KEY = "friday.lang";

export default function InputBar() {
  const [value, setValue] = useState("");
  const state = useFridayStore((s) => s.state);
  const listening = state === "listening";
  const busy = state !== "idle" && !listening;
  const lang = useFridayStore((s) => s.lang);
  const setLang = useFridayStore((s) => s.setLang);
  // the live recogniser, kept out of state — stopping it is not a render
  const stopRef = useRef<(() => void) | null>(null);
  /**
   * The turn in flight. `runQuery` has always accepted a signal and handled
   * abort; nothing ever passed one, so a hung orchestrator left the input and
   * the mic both disabled with no way out but a reload.
   */
  const turnRef = useRef<AbortController | null>(null);

  // A browser capability, not state: it never changes, but it must be read on
  // the client only — the server has no `window`, and the button must not
  // announce itself as a microphone before we know there is one.
  const micReady = useSyncExternalStore(
    useCallback(() => () => {}, []),
    canListen,
    () => false,
  );

  const ask = (query: string, voice: boolean) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setValue("");
    turnRef.current?.abort();
    const turn = new AbortController();
    turnRef.current = turn;
    void runQuery(useFridayStore.getState(), trimmed, { voice, signal: turn.signal });
  };

  /**
   * `runQuery` returns silently on abort — deliberately, since an aborted turn
   * has no outcome to report — which leaves the machine wherever it stopped.
   * Cancelling is the one move that has to land from any state, and most states
   * have no legal edge back to idle, so this resets rather than transitions.
   */
  const cancel = () => {
    if (!turnRef.current) return;
    turnRef.current.abort();
    turnRef.current = null;
    stopSpeaking();
    useFridayStore.getState().reset();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The input is disabled mid-turn, so its own onKeyDown never fires here.
      if (e.key === "Escape") cancel();
    };
    // Smart default, not detection: stored choice wins, then the browser
    // locale (navigator.language), so most operators never touch the toggle.
    // True auto-detect needs hosted STT — the browser engine takes one lang.
    try {
      const stored = localStorage.getItem(LANG_KEY);
      const next = resolveLang(navigator.language, stored);
      if (next !== useFridayStore.getState().lang) useFridayStore.getState().setLang(next);
    } catch {
      /* private mode — en-US default stands */
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stopRef.current?.();
      turnRef.current?.abort();
      detachMic();
    };
  }, []);

  const toggleMic = () => {
    if (stopRef.current) {
      stopRef.current();
      stopRef.current = null;
      detachMic();
      return;
    }
    // barge-in: talking over FRIDAY should stop it, not queue behind it
    stopSpeaking();

    useFridayStore.getState().setState("listening");
    let started = false;

    // Mic into the shared bus for the waveform ring. Fire-and-forget: a
    // denial just leaves the ring on its synthesised motion.
    attachMic().catch((err) => console.warn("[friday] microphone bus:", err));

    stopRef.current = startListening({
      lang,
      onInterim: setValue,
      onFinal: (text) => {
        started = true;
        stopRef.current = null;
        detachMic();
        // `listening → thinking` is a legal edge, so the turn starts straight
        // from here; routing through idle would flicker the whole rig back out.
        ask(text, true);
      },
      onEnd: (error) => {
        stopRef.current = null;
        detachMic();
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
        <button
          onClick={() => setLang(lang === "vi-VN" ? "en-US" : "vi-VN")}
          disabled={busy}
          aria-label="Toggle recognition language"
          className="shrink-0 font-mono text-[9px] tracking-[0.2em] text-cyan-300/50 transition-colors hover:text-cyan-200 disabled:opacity-30"
        >
          {lang === "vi-VN" ? "VI" : "EN"}
        </button>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && ask(value, false)}
          disabled={busy}
          // Stays empty mid-turn: `disabled:opacity-30` below would render any
          // hint here at roughly a fifth of the contrast the rest of the HUD
          // holds. The cancel affordance is announced from `LiveIndicator`,
          // which is already on screen for the whole turn and already legible.
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
