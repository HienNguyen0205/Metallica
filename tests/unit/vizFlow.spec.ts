import { test, expect } from "@playwright/test";
import { sampleSpec } from "@/lib/vizPlanner";
import { normalizeVisualization } from "@/lib/visualization/normalization";
import { columnOf } from "@/components/friday/visualization/vizFlow";

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
  // linear chain a->b->c->d plus b->d shortcut: depths 0,1,2,2
  void columnOf;
  const spec = sampleSpec("sankey_flow");
  expect(spec.data!.nodes!.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  expect(columnOf(spec.data!.nodes!, spec.data!.links!)).toEqual([0, 1, 2, 2]);
});
