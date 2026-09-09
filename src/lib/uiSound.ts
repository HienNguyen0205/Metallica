import { useFridayStore, type FridayState } from "@/lib/store";
import { getSharedAudioContext } from "@/lib/audioBus";

/**
 * §18 — very subtle UI blips. Two short oscillators through a fast gain
 * envelope; no assets, no library, nothing louder than a soft tick.
 *
 * Runs on the shared audio bus context (one AudioContext per tab, not one per
 * module) — browsers cap concurrent contexts, and the mic/TTS paths already
 * own one.
 */
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const ac = getSharedAudioContext();
  if (!ac) return null;
  // browsers start suspended until a gesture; resume is a no-op afterwards
  if (ac.state === "suspended") void ac.resume();
  return ac;
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
  // Release nodes once the envelope ends — otherwise every blip leaks a
  // connected oscillator + gain pair for the life of the shared context.
  osc.onended = () => {
    try {
      osc.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      gain.disconnect();
    } catch {
      /* already disconnected */
    }
  };
}

function muted(): boolean {
  try {
    return !useFridayStore.getState().audioEnabled;
  } catch {
    return false;
  }
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
    // Re-checked at fire time: muting inside the 130 ms window must silence
    // the second half, not just the entry check in playStateCue.
    setTimeout(() => {
      if (!muted()) blip(240, 0.2, 0.04, "square");
    }, 130);
  },
  error: () => {
    blip(180, 0.28, 0.05, "sawtooth");
    setTimeout(() => {
      if (!muted()) blip(120, 0.32, 0.045, "sawtooth");
    }, 90);
  },
};

export function playStateCue(state: FridayState) {
  // Muted UI stays muted — AudioCues also checks, but direct callers must not
  // bypass the toggle. Store never imports uiSound so this cannot cycle.
  if (muted()) return;
  CUES[state]?.();
}
// No pagehide cleanup: the context is the shared audio-bus one (owned by
// audioBus, suspended by detachMic when idle), not a module-local context
// worth closing on navigation.
