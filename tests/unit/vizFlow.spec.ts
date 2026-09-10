import { test, expect } from "@playwright/test";
import { sampleSpec } from "@/lib/vizPlanner";
import { normalizeVisualization } from "@/lib/visualization/normalization";

test("funnel sample survives normalization with 4 stages", () => {
  const spec = normalizeVisualization(sampleSpec("funnel_3d"));
  expect(spec.data?.metrics?.length).toBe(4);
  for (const m of spec.data!.metrics!) {
    expect(m.value).toBeGreaterThanOrEqual(0);
    expect(m.value).toBeLessThanOrEqual(100);
  }
});

test("funnel conversion math: 62/100 = 62%", () => {
  const metrics = sampleSpec("funnel_3d").data!.metrics!;
  const pct = Math.round((metrics[1].value / metrics[0].value) * 100);
  expect(pct).toBe(62);
});
