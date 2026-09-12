import type { VisualizationSpec, VisualizationType } from "@/lib/visualization/types";

interface Rule {
  type: VisualizationType;
  match: RegExp;
  build: () => VisualizationSpec;
}

/**
 * §16 — rules-based visualization planner. Semantics decide the hologram, so
 * no page or component ever names a visualization component directly.
 * An LLM planner can later be layered in front of these rules; the output
 * contract (VisualizationSpec) stays the same.
 */
// Order matters: the most specific rule wins.
const RULES: Rule[] = [
  {
    type: "sankey_flow",
    match: /sankey|flow between|from .* to .* through|energy flow|budget flow/i,
    build: () => ({
      type: "sankey_flow",
      title: "FLOW MAP",
      animation: "materialize",
      data: {
        nodes: [
          { id: "a", label: "ADS" },
          { id: "b", label: "SIGNUP" },
          { id: "c", label: "PAY" },
          { id: "d", label: "CHURN" },
        ],
        links: [[0, 1], [1, 2], [1, 3]],
      },
    }),
  },
  {
    type: "network",
    // deliberately not a bare /service/ — "requests per service" is a
    // distribution question, not a topology one
    match: /topology|depend|microservice|cluster|service map|service graph|call graph/i,
    build: () => ({
      type: "network",
      title: "SERVICE TOPOLOGY",
      animation: "materialize",
      data: {
        nodes: [
          { id: "gw", label: "GATEWAY" },
          { id: "api", label: "API" },
          { id: "db", label: "DB" },
          { id: "cache", label: "CACHE" },
          { id: "queue", label: "QUEUE" },
          { id: "auth", label: "AUTH" },
        ],
      },
    }),
  },
  {
    type: "globe",
    // "map" is word-boundaried so "heatmap" (now unmapped) cannot reach it.
    match: /where|region|location|global|\bmap\b|globe|country|latency by/i,
    build: () => ({
      type: "globe",
      title: "GLOBAL EDGE MAP",
      animation: "materialize",
      data: {
        points: [
          { lat: 50.1, lon: 8.7, label: "FRA" },
          { lat: 37.8, lon: -122.4, label: "SFO" },
          { lat: 35.7, lon: 139.7, label: "TYO" },
          { lat: -33.9, lon: 151.2, label: "SYD" },
        ],
      },
    }),
  },
  {
    type: "line_3d",
    match: /trend|history|over time|last hour|graph of|timeseries|time series/i,
    build: () => ({
      type: "line_3d",
      title: "LOAD TREND · 9H",
      animation: "materialize",
      data: {
        series: [
          { label: "CPU", points: [22, 38, 31, 55, 47, 68, 62, 79, 73] },
          { label: "REQ", points: [12, 20, 44, 39, 58, 51, 70, 66, 81] },
        ],
      },
    }),
  },
  {
    type: "bar_3d",
    match: /compare|breakdown|per |by service|distribution/i,
    build: () => ({
      type: "bar_3d",
      title: "DISTRIBUTION",
      animation: "materialize",
      data: { series: [{ label: "REQ", points: [34, 58, 22, 71, 47, 63, 39] }] },
    }),
  },
  {
    type: "timeline",
    match: /event|log|timeline|incident|history of/i,
    build: () => ({
      type: "timeline",
      title: "EVENT SEQUENCE",
      animation: "materialize",
      data: {
        events: [
          { label: "DEPLOY", at: 0 },
          { label: "ALERT", at: 1 },
          { label: "MITIGATED", at: 2 },
        ],
      },
    }),
  },
  {
    type: "radar",
    match: /scan|search|find|look for|detect|threat/i,
    build: () => ({
      type: "radar",
      title: "SCAN SWEEP",
      animation: "materialize",
      data: { metrics: [{ label: "N", value: 40 }, { label: "E", value: 72 }, { label: "S", value: 55 }] },
    }),
  },
  {
    type: "waveform",
    match: /voice|audio|sound|listen|speak/i,
    build: () => ({ type: "waveform", title: "AUDIO STREAM", animation: "materialize" }),
  },
];

/** Default: multiple metrics → orbiting radial gauges (§6). */
const DEFAULT_SPEC: VisualizationSpec = {
  type: "radial_gauge",
  title: "SERVER ANALYSIS",
  animation: "materialize",
  data: {
    metrics: [
      { label: "CPU", value: 73, unit: "%" },
      { label: "RAM", value: 61, unit: "%" },
      { label: "DISK", value: 82, unit: "%" },
      { label: "NET", value: 46, unit: "%" },
    ],
  },
};

function cloneSpec(spec: VisualizationSpec): VisualizationSpec {
  return {
    ...spec,
    data: spec.data
      ? {
          ...spec.data,
          metrics: spec.data.metrics?.map((m) => ({ ...m })),
          series: spec.data.series?.map((s) => ({ ...s, points: [...s.points] })),
          nodes: spec.data.nodes?.map((n) => ({ ...n })),
          links: spec.data.links?.map((l) => [...l] as [number, number]),
          points: spec.data.points?.map((p) => ({ ...p })),
          events: spec.data.events?.map((e) => ({ ...e })),
        }
      : undefined,
    theme: spec.theme ? { ...spec.theme } : undefined,
    position: spec.position ? [...spec.position] as [number, number, number] : undefined,
  };
}

export function planVisualization(query: string): VisualizationSpec {
  return cloneSpec(RULES.find((r) => r.match.test(query))?.build() ?? DEFAULT_SPEC);
}

/** One canonical sample spec per type — used by the dev viz rail. */
const RULE_BY_TYPE: Record<Exclude<VisualizationType, "radial_gauge">, Rule> = Object.fromEntries(
  RULES.map((r) => [r.type, r]),
) as Record<Exclude<VisualizationType, "radial_gauge">, Rule>;
const SAMPLES: Record<VisualizationType, () => VisualizationSpec> = {
  radial_gauge: () => DEFAULT_SPEC,
  radar: () => RULE_BY_TYPE.radar.build(),
  waveform: () => RULE_BY_TYPE.waveform.build(),
  line_3d: () => RULE_BY_TYPE.line_3d.build(),
  bar_3d: () => RULE_BY_TYPE.bar_3d.build(),
  timeline: () => RULE_BY_TYPE.timeline.build(),
  network: () => RULE_BY_TYPE.network.build(),
  globe: () => RULE_BY_TYPE.globe.build(),
  sankey_flow: () => RULE_BY_TYPE.sankey_flow.build(),
};

export function sampleSpec(type: VisualizationType): VisualizationSpec {
  return cloneSpec(SAMPLES[type]());
}

/** Short spoken-style answer to accompany the hologram (§10 — secondary). */
export function summarize(spec: VisualizationSpec): string {
  switch (spec.type) {
    case "network":
      return "Six services online. No broken dependencies.";
    case "globe":
      return "Four edge regions responding. Frankfurt is slowest.";
    case "line_3d":
      return "Load has climbed steadily over the last nine hours.";
    case "bar_3d":
      return "Traffic is concentrated on two services.";
    case "timeline":
      return "One alert logged since the last sync.";
    case "radar":
      return "Sweep complete. Three contacts, none hostile.";
    case "waveform":
      return "Audio channel open.";
    case "sankey_flow":
      return "Three flows live. The largest runs ads to signup.";
    default:
      return "System performance is normal. Disk usage is trending high.";
  }
}
