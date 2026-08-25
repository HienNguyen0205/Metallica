import type { FridayState } from "@/lib/store";

/**
 * §7/§17 — single source of truth for how each state looks.
 * Core, rings, particles, HUD and waveform all read from here so a state
 * change moves the whole hologram coherently instead of per-component.
 */
export interface StateLook {
  color: string;
  accent: string;
  coreDistort: number;
  coreSpeed: number;
  glow: number;
  ringSpeed: number;
  /** multiplier on orbital particle motion */
  particleIntensity: number;
  /** 0..1 — how much the outer waveform ring reacts */
  waveform: number;
  /** metres of per-frame positional glitch */
  jitter: number;
  scanSpeed: number;
}

const CYAN = "#38e8ff";
const VIOLET = "#a78bfa";

export const STATE_LOOK: Record<FridayState, StateLook> = {
  idle: {
    color: CYAN, accent: "#0e7490",
    coreDistort: 0.18, coreSpeed: 0.9, glow: 0.85,
    ringSpeed: 0.05, particleIntensity: 0.35, waveform: 0.08, jitter: 0, scanSpeed: 0.35,
  },
  listening: {
    color: "#22d3ee", accent: CYAN,
    coreDistort: 0.28, coreSpeed: 2, glow: 1.25,
    ringSpeed: 0.16, particleIntensity: 0.7, waveform: 1, jitter: 0, scanSpeed: 0.7,
  },
  thinking: {
    color: "#7dd3fc", accent: VIOLET,
    coreDistort: 0.4, coreSpeed: 3.4, glow: 1.45,
    ringSpeed: 0.55, particleIntensity: 1.8, waveform: 0.2, jitter: 0, scanSpeed: 1.6,
  },
  searching: {
    color: CYAN, accent: "#67e8f9",
    coreDistort: 0.32, coreSpeed: 2.6, glow: 1.35,
    ringSpeed: 0.75, particleIntensity: 2.2, waveform: 0.15, jitter: 0, scanSpeed: 2.2,
  },
  processing: {
    color: VIOLET, accent: CYAN,
    coreDistort: 0.36, coreSpeed: 3, glow: 1.4,
    ringSpeed: 0.45, particleIntensity: 1.6, waveform: 0.2, jitter: 0, scanSpeed: 1.4,
  },
  tool_execution: {
    color: VIOLET, accent: "#c4b5fd",
    coreDistort: 0.42, coreSpeed: 3.2, glow: 1.5,
    ringSpeed: 0.65, particleIntensity: 2, waveform: 0.25, jitter: 0, scanSpeed: 1.8,
  },
  visualizing: {
    color: "#5eead4", accent: CYAN,
    coreDistort: 0.3, coreSpeed: 2.4, glow: 1.45,
    ringSpeed: 0.35, particleIntensity: 1.3, waveform: 0.3, jitter: 0, scanSpeed: 1.2,
  },
  speaking: {
    color: "#5eead4", accent: CYAN,
    coreDistort: 0.34, coreSpeed: 4.5, glow: 1.55,
    ringSpeed: 0.22, particleIntensity: 0.9, waveform: 1, jitter: 0, scanSpeed: 0.9,
  },
  warning: {
    color: "#fbbf24", accent: "#f59e0b",
    coreDistort: 0.34, coreSpeed: 6, glow: 1.7,
    ringSpeed: 0.9, particleIntensity: 1.2, waveform: 0.4, jitter: 0.008, scanSpeed: 2.6,
  },
  error: {
    color: "#f87171", accent: "#fb7185",
    coreDistort: 0.5, coreSpeed: 7.5, glow: 1.8,
    ringSpeed: 1.2, particleIntensity: 0.8, waveform: 0.5, jitter: 0.045, scanSpeed: 3.4,
  },
};
