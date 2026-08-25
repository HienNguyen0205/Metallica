import type { FridayState } from "@/lib/store";

/**
 * §18 — very subtle UI blips. Two short oscillators through a fast gain
 * envelope; no assets, no library, nothing louder than a soft tick.
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  // browsers start suspended until a gesture; resume is a no-op afterwards
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function blip(freq: number, duration: number, gainPeak: number, type: OscillatorType = "sine") {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  const now = ac.currentTime;

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.35, now + duration);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(gainPeak, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

const CUES: Partial<Record<FridayState, () => void>> = {
  listening: () => blip(660, 0.12, 0.035),
  thinking: () => blip(430, 0.1, 0.025),
  searching: () => blip(520, 0.16, 0.022, "triangle"),
  tool_execution: () => blip(360, 0.14, 0.028, "triangle"),
  visualizing: () => blip(780, 0.18, 0.03),
  speaking: () => blip(880, 0.1, 0.026),
  warning: () => {
    blip(300, 0.18, 0.045, "square");
    setTimeout(() => blip(240, 0.2, 0.04, "square"), 130);
  },
  error: () => {
    blip(180, 0.28, 0.05, "sawtooth");
    setTimeout(() => blip(120, 0.32, 0.045, "sawtooth"), 90);
  },
};

export function playStateCue(state: FridayState) {
  CUES[state]?.();
}
