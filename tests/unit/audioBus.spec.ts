import { test, expect } from "@playwright/test";
import {
  attachMic,
  binsToLevels,
  detachMic,
  isMicAttached,
  resolveLang,
  utteranceEnvelope,
} from "@/lib/audioBus";
import {
  speak,
  speakProgress,
  stopSpeaking,
  ttsLevels,
  __setTtsPlayerForTests,
} from "@/lib/voice";

function ttsFrames(payloads: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  for (const p of payloads) {
    const len = p.length;
    parts.push(len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff, ...p);
  }
  return new Uint8Array(parts);
}

function ttsBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

function validTtsResponse(): Response {
  const header = new TextEncoder().encode(
    JSON.stringify({ sampleRate: 24000, channels: 1, totalSamples: 4 }),
  );
  return new Response(ttsBody(ttsFrames([header, new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0])])), { status: 200 });
}

function mockSpeechSynthesis(spoken: string[]): void {
  const g = globalThis as unknown as Record<string, unknown>;
  class FakeUtterance {
    text: string;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
      queueMicrotask(() => this.onend?.());
    }
  }
  g["SpeechSynthesisUtterance"] = FakeUtterance;
  Object.defineProperty(globalThis, "window", {
    value: {
      speechSynthesis: {
        cancel: () => {},
        speak: (u: { text: string }) => { spoken.push(u.text); },
      },
    },
    configurable: true,
    writable: true,
  });
}

function unmockWindow(prevWindowDesc: PropertyDescriptor | undefined): void {
  if (prevWindowDesc) Object.defineProperty(globalThis, "window", prevWindowDesc);
  else delete (globalThis as unknown as Record<string, unknown>)["window"];
  delete (globalThis as unknown as Record<string, unknown>)["SpeechSynthesisUtterance"];
}

test("speak prefers TTS audio and reports sample progress", async () => {
  const calls: string[] = [];
  const fakePlayer = {
    play: async () => { calls.push("play"); },
    stop: () => { calls.push("stop"); },
    levels: () => [0.9],
    progress: () => 0.5,
    framesFlowed: 8,
    active: true,
  };
  __setTtsPlayerForTests(fakePlayer as never);
  const g = globalThis as unknown as Record<string, unknown>;
  const prevFetch = g["fetch"];
  g["fetch"] = async () => validTtsResponse();
  try {
    await speak("hello");
    expect(calls).toEqual(["play"]);
    expect(speakProgress()).toBe(0.5);
    expect(ttsLevels(4)).toEqual([0.9]);
  } finally {
    g["fetch"] = prevFetch;
    __setTtsPlayerForTests(null);
  }
});

test("phase-1 failure falls back to synthesis", async () => {
  const spoken: string[] = [];
  const prevWindowDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
  const failing = {
    play: async () => { throw new Error("boom"); },
    stop: () => {},
    levels: () => null,
    progress: () => null,
    framesFlowed: 0,
    active: false,
  };
  __setTtsPlayerForTests(failing as never);
  const g = globalThis as unknown as Record<string, unknown>;
  const prevFetch = g["fetch"];
  g["fetch"] = async () => { throw new TypeError("down"); };
  mockSpeechSynthesis(spoken);
  try {
    await speak("fallback me");
    expect(spoken).toEqual(["fallback me"]);
  } finally {
    g["fetch"] = prevFetch;
    unmockWindow(prevWindowDesc);
    __setTtsPlayerForTests(null);
  }
});

test("phase-2 failure stays quiet with no second voice", async () => {
  const spoken: string[] = [];
  const prevWindowDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
  const midFail = {
    framesFlowed: 0,
    play: async () => { midFail.framesFlowed = 512; throw new Error("mid"); },
    stop: () => {},
    levels: () => null,
    progress: () => null,
    active: false,
  };
  __setTtsPlayerForTests(midFail as never);
  const g = globalThis as unknown as Record<string, unknown>;
  const prevFetch = g["fetch"];
  g["fetch"] = async () => validTtsResponse();
  mockSpeechSynthesis(spoken);
  try {
    await speak("quiet me");
    expect(spoken).toEqual([]);
  } finally {
    g["fetch"] = prevFetch;
    unmockWindow(prevWindowDesc);
    __setTtsPlayerForTests(null);
  }
});

test("stopSpeaking stops the TTS player", () => {
  const calls: string[] = [];
  __setTtsPlayerForTests({
    play: async () => {},
    stop: () => { calls.push("stop"); },
    levels: () => null,
    progress: () => null,
    framesFlowed: 0,
    active: false,
  } as never);
  try {
    stopSpeaking();
    expect(calls).toEqual(["stop"]);
  } finally {
    __setTtsPlayerForTests(null);
  }
});

test("binsToLevels maps FFT bins to bar levels in 0..1", () => {
  const freq = new Uint8Array(128);
  expect(binsToLevels(freq, 96)).toHaveLength(96);
  expect(binsToLevels(freq, 96).every((v) => v === 0)).toBe(true);

  const full = new Uint8Array(128).fill(255);
  const levels = binsToLevels(full, 96);
  expect(levels.every((v) => v > 0.9 && v <= 1)).toBe(true);
});

test("a single hot bin surfaces near the expected bar", () => {
  const freq = new Uint8Array(128);
  freq[0] = 255;
  const levels = binsToLevels(freq, 96);
  expect(Math.max(...levels)).toBeGreaterThan(0.5);
  expect(levels.indexOf(Math.max(...levels))).toBeLessThan(8);
});

test("resolveLang prefers stored choice, then navigator, then en-US", () => {
  expect(resolveLang("en-US", "vi-VN")).toBe("vi-VN");
  expect(resolveLang("vi-VN", null)).toBe("vi-VN");
  expect(resolveLang("vi", null)).toBe("vi-VN");
  expect(resolveLang("en-US", null)).toBe("en-US");
  expect(resolveLang("fr-FR", null)).toBe("en-US");
  expect(resolveLang(undefined, null)).toBe("en-US");
});

test("mic lifecycle is safe where no capture exists", async () => {
  expect(isMicAttached()).toBe(false);
  await expect(attachMic()).rejects.toThrow(/unsupported/i);
  detachMic();
  expect(isMicAttached()).toBe(false);
});

test("binsToLevels handles empty input explicitly", () => {
  const levels = binsToLevels([] as unknown as ArrayLike<number>, 4);
  expect(levels).toHaveLength(4);
  expect(levels.every((v) => v === 0)).toBe(true);
});

test("detach during pending attach prevents orphan live stream", async () => {
  // Fake capture so attachMic reaches the awaiting branch even in node.
  const stops: string[] = [];
  const fakeStream = {
    getTracks: () => [{ stop: () => stops.push("stopped") }],
  };
  let resolveGum!: (s: unknown) => void;
  const gum = new Promise((resolve) => {
    resolveGum = resolve as (s: unknown) => void;
  });
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const prevWindowDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
  const fakeSource = { connect: () => {}, disconnect: () => {} };
  const fakeAnalyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    frequencyBinCount: 4,
    getByteFrequencyData: () => {},
  };
  const FakeCtor = function (this: unknown) {
    return {
      state: "running",
      resume: async () => {},
      createMediaStreamSource: () => fakeSource,
      createAnalyser: () => fakeAnalyser,
      suspend: async () => {},
    };
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: () => gum } },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { AudioContext: FakeCtor },
    configurable: true,
    writable: true,
  });
  try {
    detachMic();
    const pending = attachMic();
    // Detach while getUserMedia is still pending — late resolve must not publish.
    detachMic();
    resolveGum(fakeStream);
    await pending.catch(() => {});
    expect(isMicAttached()).toBe(false);
    expect(stops.length).toBeGreaterThan(0);
  } finally {
    if (prevNavigatorDesc) Object.defineProperty(globalThis, "navigator", prevNavigatorDesc);
    else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)["navigator"];
      } catch {
        /* ignore */
      }
    }
    if (prevWindowDesc) Object.defineProperty(globalThis, "window", prevWindowDesc);
    else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)["window"];
      } catch {
        /* ignore */
      }
    }
    detachMic();
  }
});

test("utterance envelope stays in range across the utterance", () => {
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const v = utteranceEnvelope(p);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  }
  expect(utteranceEnvelope(0.25)).toBeGreaterThan(utteranceEnvelope(0));
});

test("speak progress is null when nothing is spoken", () => {
  expect(speakProgress()).toBeNull();
});
