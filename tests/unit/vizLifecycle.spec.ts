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
  api.getState().settleVisualization(0);
  expect(api.getState().visualizations[0].lifecycle).toBe("active");
});
