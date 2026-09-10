// Contract test: canonical schema <-> parser conformance, locked by fixtures.
// No validator dep by policy: fixtures below mirror contracts/events.v1.json
// examples; any schema change must update them (and vice versa).
// Per-event payload shapes are parser-validated (see events.spec.ts); schema
// definitions are documentary until the BE slice wires $refs.
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { parseFridayEvent, unwrapEnvelope } from "@/lib/agent/events";

const schema = JSON.parse(readFileSync("contracts/events.v1.json", "utf8"));

test("schema lists exactly the parser's event universe", () => {
  expect(schema.properties.event.enum).toEqual(
    expect.arrayContaining(["state", "tool", "confirm", "denied", "preview", "viz", "answer", "done", "error", "memory"]),
  );
  expect(schema.required).toEqual(expect.arrayContaining(["version", "event", "payload"]));
  expect(schema.properties.version.const).toBe(1);
});

const VALID = [
  ["state", { version: 1, run_id: "r", session_id: "s", turn_id: "t", sequence: 1, timestamp: "2026-09-10T02:00:00Z", event: "state", payload: { state: "thinking" } }],
  ["tool", { version: 1, event: "tool", payload: { tool: "get_system_metrics", risk: "low" } }],
  ["answer", { version: 1, sequence: 9, event: "answer", payload: { text: "hi" } }],
] as const;

for (const [frameEvent, body] of VALID) {
  test(`contract accepts valid enveloped ${frameEvent}`, () => {
    const u = unwrapEnvelope(frameEvent, JSON.stringify(body));
    expect(u.kind).toBe("enveloped");
    if (u.kind !== "enveloped") return;
    expect(parseFridayEvent({ event: u.event, data: u.data })).not.toBeNull();
  });
}

const INVALID: Array<[string, unknown]> = [
  ["state", { version: 2, event: "state", payload: { state: "thinking" } }],
  ["state", { version: 1, event: "tool", payload: { state: "thinking" } }],
  ["tool", { version: 1, event: "tool", payload: { tool: "", risk: "low" } }],
  ["answer", { version: 1, sequence: -1, event: "answer", payload: { text: "hi" } }],
  ["viz", { version: 1, event: "viz", payload: { type: "death_star" } }],
];

for (const [frameEvent, body] of INVALID) {
  test(`contract rejects invalid ${frameEvent} (${JSON.stringify(body).slice(0, 60)}…)`, () => {
    const u = unwrapEnvelope(frameEvent, JSON.stringify(body));
    if (u.kind === "rejected") return;
    if (u.kind === "flat") throw new Error("expected enveloped or rejected");
    expect(parseFridayEvent({ event: u.event, data: u.data })).toBeNull();
  });
}
