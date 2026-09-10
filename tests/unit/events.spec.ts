import { test, expect } from "@playwright/test";
import { parseFridayEvent, unwrapEnvelope } from "@/lib/agent/events";

test("rejects unknown state values instead of casting", () => {
  expect(parseFridayEvent({ event: "state", data: JSON.stringify({ state: "__proto__" }) })).toBeNull();
  expect(parseFridayEvent({ event: "state", data: JSON.stringify({ state: "flying" }) })).toBeNull();
  expect(parseFridayEvent({ event: "state", data: JSON.stringify({ state: "idle" }) })).toEqual({
    type: "state",
    state: "idle",
  });
});

test("rejects invalid risk values", () => {
  expect(
    parseFridayEvent({ event: "tool", data: JSON.stringify({ tool: "x", risk: "critical" }) }),
  ).toBeNull();
  expect(parseFridayEvent({ event: "tool", data: JSON.stringify({ tool: "x", risk: "low" }) })).toEqual({
    type: "tool",
    tool: "x",
    risk: "low",
  });
});

test("rejects non-finite memory ids", () => {
  expect(
    parseFridayEvent({ event: "memory", data: JSON.stringify({ fact: "hi" }) }),
  ).toBeNull();
  expect(
    parseFridayEvent({ event: "memory", data: JSON.stringify({ id: "abc", fact: "hi" }) }),
  ).toBeNull();
  const ok = parseFridayEvent({ event: "memory", data: JSON.stringify({ id: 7, fact: "hi" }) });
  expect(ok).toMatchObject({ type: "memory", id: 7 });
});

test("rejects unknown viz types and bad confirm payloads", () => {
  expect(parseFridayEvent({ event: "viz", data: JSON.stringify({ type: "death_star" }) })).toBeNull();
  expect(
    parseFridayEvent({ event: "confirm", data: JSON.stringify({ id: "1", tool: "x", risk: "nope" }) }),
  ).toBeNull();
});

test("preview parses as non-interactive viz instead of dropping", () => {
  const ev = parseFridayEvent({
    event: "preview",
    data: JSON.stringify({ type: "bar_3d", title: "EARLY" }),
  });
  expect(ev).toMatchObject({ type: "preview", spec: { type: "bar_3d", interaction: "none" } });
  expect(
    parseFridayEvent({ event: "preview", data: JSON.stringify({ type: "death_star" }) }),
  ).toBeNull();
});

function enveloped(innerEvent: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ version: 1, run_id: "run_1", session_id: "sess_1", turn_id: "turn_1", sequence: 3, timestamp: "2026-09-10T02:00:00Z", event: innerEvent, payload, ...extra });
}

test("enveloped state parses like flat", () => {
  const u = unwrapEnvelope("state", enveloped("state", { state: "thinking" }));
  expect(u.kind).toBe("enveloped");
  if (u.kind !== "enveloped") return;
  expect(u.meta).toMatchObject({ version: 1, runId: "run_1", sequence: 3 });
  expect(parseFridayEvent({ event: u.event, data: u.data })).toEqual({ type: "state", state: "thinking" });
});

test("enveloped viz parses like flat", () => {
  const u = unwrapEnvelope("viz", enveloped("viz", { type: "bar_3d", title: "X" }, { sequence: 7 }));
  expect(u.kind).toBe("enveloped");
  if (u.kind !== "enveloped") return;
  expect(u.meta.sequence).toBe(7);
  expect(parseFridayEvent({ event: u.event, data: u.data })).toMatchObject({ type: "viz" });
});

test("envelope mismatches and bad versions rejected", () => {
  expect(unwrapEnvelope("state", enveloped("tool", { state: "thinking" })).kind).toBe("rejected");
  expect(unwrapEnvelope("state", JSON.stringify({ version: 2, event: "state", payload: {} })).kind).toBe("rejected");
  expect(unwrapEnvelope("state", enveloped("state", { state: "thinking" }, { sequence: 0 })).kind).toBe("rejected");
  expect(unwrapEnvelope("state", enveloped("state", { state: "thinking" }, { sequence: 1.5 })).kind).toBe("rejected");
  expect(unwrapEnvelope("state", JSON.stringify({ version: 1, event: "state", payload: 42 })).kind).toBe("rejected");
  expect(unwrapEnvelope("state", JSON.stringify({ version: 1, event: "state", payload: {}, run_id: 7 })).kind).toBe("rejected");
});

test("envelope with empty-string id is rejected", () => {
  expect(unwrapEnvelope("state", enveloped("state", { state: "thinking" }, { run_id: "" })).kind).toBe("rejected");
});

test("flat frames pass through untouched (backward compat)", () => {
  const u = unwrapEnvelope("state", JSON.stringify({ state: "idle" }));
  expect(u).toEqual({ kind: "flat", event: "state", data: JSON.stringify({ state: "idle" }) });
  const garbage = unwrapEnvelope("answer", "not-json{{{");
  expect(garbage.kind).toBe("flat");
  expect(parseFridayEvent({ event: "answer", data: "not-json{{{" })).toEqual({ type: "error", message: "malformed event payload" });
});

test("envelope without sequence is accepted with null sequence", () => {
  const data = JSON.stringify({ version: 1, event: "done", payload: {} });
  const u = unwrapEnvelope("done", data);
  expect(u.kind).toBe("enveloped");
  if (u.kind !== "enveloped") return;
  expect(u.meta.sequence).toBeNull();
  expect(parseFridayEvent({ event: u.event, data: u.data })).toEqual({ type: "done" });
});
