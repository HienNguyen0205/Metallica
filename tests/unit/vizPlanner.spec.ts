import { test, expect } from "@playwright/test";
import { planVisualization, sampleSpec, summarize } from "@/lib/vizPlanner";
import type { VisualizationType } from "@/lib/store";

/**
 * §16 — the planner is the only place that maps meaning to a hologram, and
 * rule ordering has bitten twice ("network topology" swallowed by the traffic
 * rule, "per service" swallowed by a bare /service/). This table locks it.
 */

const ALL_TYPES: VisualizationType[] = [
  "radial_gauge",
  "health_core",
  "radar",
  "waveform",
  "network",
  "line_3d",
  "bar_3d",
  "particle_flow",
  "globe",
  "timeline",
  "heatmap_3d",
  "funnel_3d",
  "sankey_flow",
];

const CASES: Array<[string, VisualizationType]> = [
  // topology beats traffic — the regression that shipped once
  ["show me the network topology", "network"],
  ["what does the service graph look like", "network"],
  ["are there broken dependencies", "network"],
  ["how is network traffic", "particle_flow"],
  ["current throughput", "particle_flow"],
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
  ["how is system health", "health_core"],
  ["overall integrity", "health_core"],
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
  expect(planVisualization("System Health").type).toBe("health_core");
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
  expect(sampleSpec("health_core").data?.metrics?.length).toBeGreaterThan(0);
  expect(sampleSpec("network").data?.nodes?.length).toBeGreaterThan(0);
  expect(sampleSpec("line_3d").data?.series?.length).toBeGreaterThan(0);
  expect(sampleSpec("bar_3d").data?.series?.[0].points.length).toBeGreaterThan(0);
  expect(sampleSpec("heatmap_3d").data?.series?.length).toBeGreaterThan(0);
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

test('plans "signup flow conversion" → funnel_3d', () => {
  expect(planVisualization("signup flow conversion").type).toBe("funnel_3d");
});

test('plans "show me the funnel drop-off" → funnel_3d', () => {
  expect(planVisualization("show me the funnel drop-off").type).toBe("funnel_3d");
});

test('plans "flow between ads and pay" → sankey_flow', () => {
  expect(planVisualization("flow between ads and pay").type).toBe("sankey_flow");
});

test('plans "sankey of budget flow" → sankey_flow', () => {
  expect(planVisualization("sankey of budget flow").type).toBe("sankey_flow");
});

test("funnel sample has metrics, sankey sample has nodes+links", () => {
  expect(sampleSpec("funnel_3d").data?.metrics?.length).toBeGreaterThan(0);
  expect(sampleSpec("sankey_flow").data?.nodes?.length).toBeGreaterThan(0);
});

test("new summaries are distinct", () => {
  const a = summarize(sampleSpec("funnel_3d"));
  const b = summarize(sampleSpec("sankey_flow"));
  expect(a.trim().length).toBeGreaterThan(0);
  expect(b.trim().length).toBeGreaterThan(0);
  expect(a).not.toBe(b);
});
