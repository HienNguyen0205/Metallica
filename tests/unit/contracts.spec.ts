// STEP 1 (P0.1) — canonical contract parity: shared schemas <-> producers/consumers.
// events.v1.json conformance itself lives in eventContract.spec.ts; this spec
// locks the four NEW canonical schemas and the FE/BE visualization drift fix
// (sankey_flow). No validator dep by policy: assertions below mirror
// the JSON schemas field by field; any schema change must update them.
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { parseFridayEvent, STEP_KINDS, STEP_STATUSES } from "@/lib/agent/events";

function load(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const events = load("contracts/events.v1.json");
const viz = load("contracts/visualization/visualization.v1.json");
const run = load("contracts/run/run.v1.json");
const tool = load("contracts/tool/tool.v1.json");
const errorSchema = load("contracts/error/error.v1.json");

test("events schema covers the full producer event universe incl. step", () => {
  expect(events.required).toEqual(expect.arrayContaining(["version", "event", "payload"]));
  expect(events.properties.version.const).toBe(1);
  for (const kind of ["state", "tool", "confirm", "denied", "preview", "viz", "answer", "done", "error", "memory", "step"]) {
    expect(events.properties.event.enum).toContain(kind);
  }
});

test("visualization schema type universe matches the FE parser", () => {
  const types: string[] = viz.properties.type.enum;
  for (const t of ["radial_gauge", "radar", "waveform", "network", "line_3d", "bar_3d", "globe", "timeline", "sankey_flow"]) {
    expect(types).toContain(t);
  }
  // tolerant reader: only `type` is required
  expect(viz.required).toEqual(["type"]);
});

test("parser accepts every schema visualization type and rejects unknown ones", () => {
  for (const t of viz.properties.type.enum as string[]) {
    expect(parseFridayEvent({ event: "viz", data: JSON.stringify({ type: t }) })).toMatchObject({ type: "viz" });
  }
  expect(parseFridayEvent({ event: "viz", data: JSON.stringify({ type: "death_star" }) })).toBeNull();
});

test("run status enum matches the step/agent status universe", () => {
  expect(run.required).toEqual(expect.arrayContaining(["run_id", "status"]));
  expect(run.definitions.RunStatus.enum).toEqual(expect.arrayContaining([...STEP_STATUSES]));
  expect([...STEP_STATUSES].sort()).toEqual([...run.definitions.RunStatus.enum].sort());
  expect(STEP_KINDS).toEqual(expect.arrayContaining(["plan", "tool", "answer"]));
  // first-class run fields (P1.1) are all documented contract properties
  for (const key of ["turn_id", "goal", "plan", "evidence", "final_answer", "error", "budget", "current_step_id"]) {
    expect(Object.keys(run.properties)).toContain(key);
  }
});

test("tool schema risk enum matches the parser and declares a policy decision", () => {
  expect(tool.required).toEqual(expect.arrayContaining(["tool", "risk"]));
  expect(tool.properties.risk.enum).toEqual(["low", "medium", "high"]);
  expect(tool.definitions.PolicyDecision.required).toEqual(expect.arrayContaining(["tool", "decision"]));
  expect(tool.definitions.PolicyDecision.properties.decision.enum).toEqual(["allow", "deny", "ask_human", "step_up"]);
  // producer-negative: parser still rejects undeclared risk levels
  expect(parseFridayEvent({ event: "tool", data: JSON.stringify({ tool: "x", risk: "critical" }) })).toBeNull();
});

test("error schema requires only a message", () => {
  expect(errorSchema.required).toEqual(["message"]);
  expect(parseFridayEvent({ event: "error", data: JSON.stringify({}) })).toMatchObject({ type: "error" });
});
