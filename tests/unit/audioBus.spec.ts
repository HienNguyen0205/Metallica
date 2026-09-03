import { test, expect } from "@playwright/test";
import {
  attachMic,
  binsToLevels,
  detachMic,
  isMicAttached,
  resolveLang,
  utteranceEnvelope,
} from "@/lib/audioBus";
import { speakProgress } from "@/lib/voice";

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
