"use client";

import { useEffect, useRef } from "react";
import { useFridayStore, type FridayState } from "@/lib/store";
import { playStateCue } from "@/lib/uiSound";

/** §18 — cue sounds fire from state changes, muted until the user allows it. */
export function AudioCues() {
  const state = useFridayStore((s) => s.state);
  const audioEnabled = useFridayStore((s) => s.audioEnabled);
  const unlocked = useRef(false);
  const previous = useRef<FridayState>(state);

  useEffect(() => {
    const unlock = () => {
      unlocked.current = true;
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    if (state !== previous.current) {
      previous.current = state;
      if (audioEnabled && unlocked.current) playStateCue(state);
    }
  }, [state, audioEnabled]);

  return null;
}
