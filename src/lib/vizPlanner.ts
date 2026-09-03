import type { VisualizationSpec, VisualizationType } from "@/lib/store";

interface Rule {
  match: RegExp;
  build: () => VisualizationSpec;
}

/**
 * §16 — rules-based visualization planner. Semantics decide the hologram, so
 * no page or component ever names a visualization component directly.
 * An LLM planner can later be layered in front of these rules; the output
 * contract (VisualizationSpec) stays the same.
 */
// Order matters: the most specific rule wins, so "network topology" reaches
// the graph rule instead of being swallowed by the traffic rule.
const RULES: Rule[] = [
  {
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
    match: /traffic|throughput|bandwidth|packet|network flow|data flow|\bflow\b|\bnetwork\b/i,
    build: () => ({
      type: "particle_flow",
      title: "NETWORK FLOW",
      animation: "materialize",
      data: { rate: 820 },
    }),
  },
  {
    // before globe: "heatmap" contains the substring "map"
    match: /heatmap|hotspot|density|correlation/i,
    build: () => ({
      type: "heatmap_3d",
      title: "DENSITY HEATMAP",
      animation: "materialize",
      data: {
        series: [
          { label: "A", points: [34, 58, 22, 71, 47, 63, 39] },
          { label: "B", points: [12, 44, 66, 28, 81, 52, 37] },
          { label: "C", points: [61, 25, 48, 73, 33, 57, 69] },
        ],
      },
    }),
  },
  {
    match: /where|region|location|global|map|globe|country|latency by/i,
    build: () => ({ type: "globe", title: "GLOBAL EDGE MAP", animation: "materialize" }),
  },
  {
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
    match: /compare|breakdown|per |by service|distribution/i,
    build: () => ({
      type: "bar_3d",
      title: "DISTRIBUTION",
      animation: "materialize",
      data: { series: [{ label: "REQ", points: [34, 58, 22, 71, 47, 63, 39] }] },
    }),
  },
  {
    match: /event|log|timeline|incident|history of/i,
    build: () => ({ type: "timeline", title: "EVENT SEQUENCE", animation: "materialize" }),
  },
  {
    match: /scan|search|find|look for|detect|threat/i,
    build: () => ({
      type: "radar",
      title: "SCAN SWEEP",
      animation: "materialize",
      data: { metrics: [{ label: "N", value: 40 }, { label: "E", value: 72 }, { label: "S", value: 55 }] },
    }),
  },
  {
    match: /health|status|overall|integrity/i,
    build: () => ({
      type: "health_core",
      title: "SYSTEM INTEGRITY",
      animation: "pulse",
      data: { metrics: [{ label: "HEALTH", value: 87, unit: "%" }] },
    }),
  },
  {
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

export function planVisualization(query: string): VisualizationSpec {
  return RULES.find((r) => r.match.test(query))?.build() ?? DEFAULT_SPEC;
}

/** One canonical sample spec per type — used by the dev viz rail. */
const SAMPLES: Record<VisualizationType, () => VisualizationSpec> = {
  radial_gauge: () => DEFAULT_SPEC,
  health_core: () => RULES[8].build(),
  radar: () => RULES[7].build(),
  waveform: () => RULES[9].build(),
  line_3d: () => RULES[4].build(),
  bar_3d: () => RULES[5].build(),
  timeline: () => RULES[6].build(),
  network: () => RULES[0].build(),
  globe: () => RULES[3].build(),
  particle_flow: () => RULES[1].build(),
  heatmap_3d: () => RULES[2].build(),
};

export function sampleSpec(type: VisualizationType): VisualizationSpec {
  return SAMPLES[type]();
}

/** Short spoken-style answer to accompany the hologram (§10 — secondary). */
export function summarize(spec: VisualizationSpec): string {
  switch (spec.type) {
    case "particle_flow":
      return "Network throughput steady at 820 megabits.";
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
    case "health_core":
      return "System integrity at 87 percent.";
    case "waveform":
      return "Audio channel open.";
    case "heatmap_3d":
      return "Hotspots concentrated in two zones.";
    default:
      return "System performance is normal. Disk usage is trending high.";
  }
}
