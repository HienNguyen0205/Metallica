import { test, expect } from "@playwright/test";
import { planVisualization, sampleSpec, summarize } from "@/lib/vizPlanner";
import type { VisualizationType } from "@/lib/store";

/**
 * §16 — the planner is the only place that maps meaning to a hologram, and
 * rule ordering has bitten ("per service" swallowed by a bare /service/).
 * This table locks it.
 */

const ALL_TYPES: VisualizationType[] = [
  "radial_gauge",
  
  "radar",
  "waveform",
  "network",
  "line_3d",
  "bar_3d",
  "globe",
  "timeline",
  "sankey_flow",
];

const CASES: Array<[string, VisualizationType]> = [
  ["show me the network topology", "network"],
  ["what does the service graph look like", "network"],
  ["are there broken dependencies", "network"],
  // traffic/throughput lost their particle_flow rule: unmapped numbers fall
  // back to the multi-metric gauges rather than a bespoke flow renderer
  ["how is network traffic", "radial_gauge"],
  ["current throughput", "radial_gauge"],
  ["where are my users", "globe"],
  ["global latency by region", "globe"],
  ["cpu trend over the last hour", "line_3d"],
  ["show me the time series", "line_3d"],
  // "per service" is a distribution question, not a topology one
  ["compare requests per service", "bar_3d"],
  ["give me a breakdown", "bar_3d"],
  ["show the incident timeline", "timeline"],
  ["scan for threats", "radar"],
  ["search the perimeter", "radar"],
  ["how is system health", "radial_gauge"],
  ["overall integrity", "radial_gauge"],
  ["open the audio channel", "waveform"],
  // no rule matches → the default multi-metric view
  ["hello friday", "radial_gauge"],
  ["what is my disk usage", "radial_gauge"],
];

for (const [query, expected] of CASES) {
  test(`plans "${query}" → ${expected}`, () => {
    expect(planVisualization(query).type).toBe(expected);
  });
}

test("planner is case insensitive", () => {
  expect(planVisualization("NETWORK TOPOLOGY").type).toBe("network");
  expect(planVisualization("System Health").type).toBe("radial_gauge");
});

test("every spec carries a title and a known animation", () => {
  for (const [query] of CASES) {
    const spec = planVisualization(query);
    expect(spec.title, `${query} has no title`).toBeTruthy();
    expect(["materialize", "pulse", "none"]).toContain(spec.animation);
  }
});

test("every visualization type has renderable sample data", () => {
  for (const type of ALL_TYPES) {
    const spec = sampleSpec(type);
    expect(spec.type, `sampleSpec(${type}) returned the wrong type`).toBe(type);
    expect(spec.title).toBeTruthy();
  }
});

test("data-driven types ship non-empty data", () => {
  expect(sampleSpec("radial_gauge").data?.metrics?.length).toBeGreaterThan(0);
  expect(sampleSpec("network").data?.nodes?.length).toBeGreaterThan(0);
  expect(sampleSpec("line_3d").data?.series?.length).toBeGreaterThan(0);
  expect(sampleSpec("bar_3d").data?.series?.[0].points.length).toBeGreaterThan(0);
});

test("gauge values are percentages the ring can actually fill", () => {
  for (const m of sampleSpec("radial_gauge").data!.metrics!) {
    expect(m.value).toBeGreaterThanOrEqual(0);
    expect(m.value).toBeLessThanOrEqual(100);
  }
});

test("every type has a distinct spoken summary", () => {
  const summaries = ALL_TYPES.map((t) => summarize(sampleSpec(t)));
  for (const s of summaries) expect(s.trim().length).toBeGreaterThan(0);
  expect(new Set(summaries).size, "summaries must not be copy-paste").toBe(ALL_TYPES.length);
});

test('plans "flow between ads and pay" → sankey_flow', () => {
  expect(planVisualization("flow between ads and pay").type).toBe("sankey_flow");
});

test('plans "sankey of budget flow" → sankey_flow', () => {
  expect(planVisualization("sankey of budget flow").type).toBe("sankey_flow");
});

test("sankey sample has nodes+links", () => {
  expect(sampleSpec("sankey_flow").data?.nodes?.length).toBeGreaterThan(0);
});

test("sankey summary is non-empty", () => {
  const a = summarize(sampleSpec("sankey_flow"));
  const b = summarize(sampleSpec("bar_3d"));
  expect(a.trim().length).toBeGreaterThan(0);
  expect(a).not.toBe(b);
});
