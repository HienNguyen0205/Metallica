import { test, expect } from "@playwright/test";
import { StreamGuard } from "@/lib/agent/streamGuard";
import type { EnvelopeMeta } from "@/lib/agent/events";

const meta = (over: Partial<EnvelopeMeta> = {}): EnvelopeMeta => ({
  version: 1, runId: "run_1", sessionId: "sess_1", turnId: "turn_1",
  sequence: 1, timestamp: null, ...over,
});

test("legacy frames always pass through", () => {
  expect(new StreamGuard().observe(null)).toBe("legacy");
});

test("in-order enveloped frames accepted", () => {
  const g = new StreamGuard();
  expect(g.observe(meta({ sequence: 1 }))).toBe("accept");
  expect(g.observe(meta({ sequence: 2 }))).toBe("accept");
  expect(g.lastSeenSequence).toBe(2);
});

test("duplicate sequence skipped", () => {
  const g = new StreamGuard();
  g.observe(meta({ sequence: 4 }));
  expect(g.observe(meta({ sequence: 4 }))).toBe("duplicate");
  expect(g.lastSeenSequence).toBe(4);
});

test("stale sequence skipped", () => {
  const g = new StreamGuard();
  g.observe(meta({ sequence: 5 }));
  expect(g.observe(meta({ sequence: 3 }))).toBe("stale");
  expect(g.lastSeenSequence).toBe(5);
});

test("gap accepted and counted", () => {
  const g = new StreamGuard();
  g.observe(meta({ sequence: 2 }));
  expect(g.observe(meta({ sequence: 6 }))).toBe("gap");
  expect(g.gapCount).toBe(1);
  expect(g.lastSeenSequence).toBe(6);
});

test("wrong run rejected without moving cursor", () => {
  const g = new StreamGuard();
  g.observe(meta({ sequence: 1, runId: "run_A" }));
  expect(g.observe(meta({ sequence: 2, runId: "run_B" }))).toBe("wrong-run");
  expect(g.lastSeenSequence).toBe(1);
  expect(g.observe(meta({ sequence: 2, runId: "run_A" }))).toBe("accept");
});

test("null-sequence redelivery with same content key is duplicate", () => {
  const g = new StreamGuard();
  expect(g.observe(meta({ sequence: null }), "same-content")).toBe("accept");
  expect(g.observe(meta({ sequence: null }), "same-content")).toBe("duplicate");
});

test("null-sequence with different content key is accepted", () => {
  const g = new StreamGuard();
  expect(g.observe(meta({ sequence: null }), "content-a")).toBe("accept");
  expect(g.observe(meta({ sequence: null }), "content-b")).toBe("accept");
});

test("sequenced frame resets null-sequence key", () => {
  const g = new StreamGuard();
  expect(g.observe(meta({ sequence: null }), "same-content")).toBe("accept");
  expect(g.observe(meta({ sequence: 1 }))).toBe("accept");
  expect(g.observe(meta({ sequence: null }), "same-content")).toBe("accept");
});

test("null runId never pins or rejects; null sequence accepts", () => {
  const g = new StreamGuard();
  expect(g.observe(meta({ sequence: null, runId: null }))).toBe("accept");
  expect(g.observe(meta({ sequence: 1, runId: "run_X" }))).toBe("accept");
  expect(g.observe(meta({ sequence: 2, runId: null }))).toBe("accept");
});
