import { test, expect } from "@playwright/test";
import { sampleSpec } from "@/lib/vizPlanner";
import { normalizeVisualization } from "@/lib/visualization/normalization";
import { columnOf } from "@/components/friday/visualization/vizFlow";

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
  const pct = metrics[0].value === 0 ? 0 : Math.round((metrics[1].value / metrics[0].value) * 100);
  expect(pct).toBe(62);
});

test("funnel step-to-step conversion: 44/62 = 71%, 27/44 = 61%", () => {
  const metrics = sampleSpec("funnel_3d").data!.metrics!;
  const prevPct = (i: number) =>
    metrics[i - 1].value === 0 ? 0 : Math.round((metrics[i].value / metrics[i - 1].value) * 100);
  expect(prevPct(1)).toBe(62);
  expect(prevPct(2)).toBe(71);
  expect(prevPct(3)).toBe(61);
});

test("sankey sample has in-range links", () => {
  const spec = normalizeVisualization(sampleSpec("sankey_flow"));
  const n = spec.data!.nodes!.length;
  expect(n).toBeGreaterThan(0);
  for (const [a, b] of spec.data!.links!) {
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(n);
    expect(b).toBeLessThan(n);
  }
});

test("sankey depth columns are deterministic", () => {
  // linear chain a→b→c→d plus b→d shortcut: depths 0,1,2,2
  void columnOf;
  const spec = sampleSpec("sankey_flow");
  expect(spec.data!.nodes!.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  expect(columnOf(spec.data!.nodes!, spec.data!.links!)).toEqual([0, 1, 2, 2]);
});
