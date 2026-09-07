import { test, expect } from "@playwright/test";
import { parseFridayEvent } from "@/lib/agent/events";

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
