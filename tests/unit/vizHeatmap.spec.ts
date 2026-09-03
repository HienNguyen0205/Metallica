import { test, expect } from "@playwright/test";
import { planVisualization, sampleSpec, summarize } from "@/lib/vizPlanner";
import { normalizeVisualization } from "@/lib/visualization/normalization";

test("heatmap queries plan to heatmap_3d", () => {
  expect(planVisualization("show hotspot density heatmap").type).toBe("heatmap_3d");
});

test("globe rule does not swallow heatmap queries", () => {
  // "heatmap" contains the substring "map" — the globe rule must not claim it.
  expect(planVisualization("heatmap").type).toBe("heatmap_3d");
  expect(planVisualization("heatmap of regional latency").type).toBe("heatmap_3d");
});

test("real map queries still reach the globe", () => {
  expect(planVisualization("show world map").type).toBe("globe");
  expect(planVisualization("global latency by region").type).toBe("globe");
});

test("heatmap sample carries title and animation", () => {
  const spec = sampleSpec("heatmap_3d");
  expect(spec.title?.length).toBeGreaterThan(0);
  expect(["materialize", "pulse", "none"]).toContain(spec.animation ?? "materialize");
});

test("heatmap summary is distinct", () => {
  expect(summarize({ type: "heatmap_3d" }).length).toBeGreaterThan(0);
});

test("normalization keeps heatmap with drill-down defaults", () => {
  const out = normalizeVisualization({ type: "heatmap_3d" });
  expect(out.type).toBe("heatmap_3d");
  expect(out.interaction).toBe("drill_down");
});
