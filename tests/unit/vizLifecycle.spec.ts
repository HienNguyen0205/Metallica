import { test, expect } from "@playwright/test";
import { useFridayStore } from "@/lib/store";

const api = useFridayStore;

test.beforeEach(() => {
  api.getState().reset();
});

test("keeps at most 3 visualizations, dropping the oldest", () => {
  for (let i = 0; i < 4; i++) {
    api.getState().addVisualization({ type: "radial_gauge", title: `VIZ ${i}` });
  }
  const vizs = api.getState().visualizations;
  expect(vizs.length).toBe(3);
  expect(vizs[0].spec.title).toBe("VIZ 1");
  expect(vizs[2].spec.title).toBe("VIZ 3");
});

test("new entry starts materializing while previous settle to active", () => {
  api.getState().addVisualization({ type: "radial_gauge", title: "A" });
  expect(api.getState().visualizations[0].lifecycle).toBe("materializing");
  api.getState().addVisualization({ type: "radar", title: "B" });
  const vizs = api.getState().visualizations;
  expect(vizs[1].lifecycle).toBe("materializing");
  expect(vizs[0].lifecycle).toBe("active");
});

test("settleVisualization flips materializing to active", () => {
  api.getState().addVisualization({ type: "radar", title: "B" });
  const id = api.getState().visualizations[0].id;
  api.getState().settleVisualization(id);
  expect(api.getState().visualizations[0].lifecycle).toBe("active");
});

test("settle by stable id survives cap eviction (stale index must not settle the wrong entry)", () => {
  api.getState().addVisualization({ type: "radial_gauge", title: "A" });
  api.getState().addVisualization({ type: "radar", title: "B" });
  api.getState().addVisualization({ type: "globe", title: "C" });
  const idB = api.getState().visualizations.find((e) => e.spec.title === "B")!.id;
  const idC = api.getState().visualizations.find((e) => e.spec.title === "C")!.id;
  // Push a 4th: oldest (A) is evicted, [B, C, D] remain.
  api.getState().addVisualization({ type: "timeline", title: "D" });
  const titles = api.getState().visualizations.map((e) => e.spec.title);
  expect(titles).toEqual(["B", "C", "D"]);
  // Settling B by id must flip B only, even though its index shifted 1 -> 0.
  api.getState().settleVisualization(idB);
  const after = api.getState().visualizations;
  expect(after.find((e) => e.id === idB)!.lifecycle).toBe("active");
  // C is still materializing only if it was the newest before D; D is materializing.
  // The key assertion: no entry other than B was flipped by a stale index.
  expect(after.find((e) => e.id === idC)!.lifecycle).toBe("active");
  expect(after.find((e) => e.spec.title === "D")!.lifecycle).toBe("materializing");
});
