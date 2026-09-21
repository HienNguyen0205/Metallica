/**
 * The operator's own device, measured by the browser with no permission
 * prompt, for the orchestrator's `get_client_metrics` tool. Its
 * `get_system_metrics` reads the server it runs on — this is the only way
 * "how is my laptop doing" gets the laptop's numbers.
 *
 * Sent with every /query; the backend holds it for that turn only and the
 * model sees it only if it calls the tool. Nothing here is persisted.
 */

import { useFridayStore } from "@/lib/store";
import { HISTORY_INTERVAL_S, history, type Sample } from "@/lib/deviceHistory";

/** Wire shape — mirrors backend/friday/api/schemas.py ClientContext. */
export interface ClientContext {
  cpu_cores?: number;
  device_memory_gb?: number;
  cpu_pressure?: PressureState;
  battery?: { level_pct: number; charging?: boolean };
  storage?: { usage_mb: number; quota_mb: number };
  network?: { effective_type?: string; downlink_mbps?: number; rtt_ms?: number };
  js_heap_mb?: number;
  gpu?: { vendor?: string; architecture?: string };
  platform?: string;
  timezone?: string;
  /** Minutes east of UTC now — the clock tool builds the operator's time from it. */
  utc_offset_min?: number;
  languages?: string[];
  screen?: { width: number; height: number; dpr: number };
  /** Only when the operator turned location on; ~1 km (2 decimals). */
  location?: { lat: number; lon: number };
  history?: { interval_s: number; samples: Sample[] };
}

type PressureState = "nominal" | "fair" | "serious" | "critical";

/** What the browser APIs hand back, in their own units. */
export interface RawReadings {
  cores?: number;
  deviceMemory?: number;
  pressure?: string;
  battery?: { level: number; charging: boolean };
  storage?: { usage: number; quota: number };
  connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  heapBytes?: number;
  gpu?: { vendor?: string; architecture?: string };
  platform?: string;
  timezone?: string;
  /** Date#getTimezoneOffset(): minutes WEST of UTC. */
  tzOffsetMin?: number;
  languages?: readonly string[];
  screen?: { width: number; height: number; dpr: number };
  location?: { lat: number; lon: number };
  history?: { intervalS: number; samples: readonly Sample[] };
}

const PRESSURE = new Set(["nominal", "fair", "serious", "critical"]);
const NET_TYPES = new Set(["slow-2g", "2g", "3g", "4g"]);
/** Must match the backend's max_length bounds. */
const MAX_STR = 40;

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const str = (v: unknown, max = MAX_STR): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;

/** Drop keys whose value is undefined so the payload carries only readings. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Raw readings → wire shape. Anything the orchestrator would reject is left
 * out here rather than sent: the backend drops a whole invalid context, so one
 * odd value would otherwise cost every other reading.
 */
export function buildClientContext(r: RawReadings): ClientContext {
  const level = num(r.battery?.level, 0, 1);
  const usage = num(r.storage?.usage, 0, 1e15);
  const quota = num(r.storage?.quota, 1, 1e15);
  const net = r.connection
    ? compact({
        effective_type: NET_TYPES.has(r.connection.effectiveType ?? "") ? r.connection.effectiveType : undefined,
        downlink_mbps: num(r.connection.downlink, 0, 100_000),
        rtt_ms: num(r.connection.rtt, 0, 600_000),
      })
    : undefined;
  const gpu = r.gpu ? compact({ vendor: str(r.gpu.vendor), architecture: str(r.gpu.architecture) }) : undefined;
  const width = num(r.screen?.width, 1, 20_000);
  const height = num(r.screen?.height, 1, 20_000);
  const dpr = num(r.screen?.dpr, 0.01, 10);
  const heap = num(r.heapBytes, 0, 1e12);
  const lat = num(r.location?.lat, -90, 90);
  const lon = num(r.location?.lon, -180, 180);
  const langs = r.languages?.filter((l) => typeof l === "string" && l.length > 0).map((l) => l.slice(0, MAX_STR));

  return compact({
    cpu_cores: num(r.cores, 1, 1024),
    device_memory_gb: num(r.deviceMemory, 0.01, 4096),
    cpu_pressure: PRESSURE.has(r.pressure ?? "") ? (r.pressure as PressureState) : undefined,
    battery: level !== undefined ? compact({ level_pct: Math.round(level * 100), charging: r.battery?.charging }) : undefined,
    storage:
      usage !== undefined && quota !== undefined
        ? { usage_mb: round1(usage / 1e6), quota_mb: round1(quota / 1e6) }
        : undefined,
    network: net && Object.keys(net).length ? net : undefined,
    js_heap_mb: heap !== undefined ? round1(heap / 1e6) : undefined,
    gpu: gpu && Object.keys(gpu).length ? gpu : undefined,
    platform: str(r.platform),
    timezone: str(r.timezone, 64),
    utc_offset_min: num(r.tzOffsetMin, -840, 840) !== undefined ? -r.tzOffsetMin! || 0 : undefined,
    languages: langs?.length ? langs.slice(0, 5) : undefined,
    screen: width && height && dpr ? { width, height, dpr } : undefined,
    // Coarsened here as well as on arrival: a finer fix never leaves the tab.
    location: lat !== undefined && lon !== undefined ? { lat: round2(lat), lon: round2(lon) } : undefined,
    history: historyOnWire(r.history),
  });
}

/** Bounds mirror backend ClientSample; a bad sample or reading is dropped. */
const SAMPLE_BOUNDS: Record<Exclude<keyof Sample, "t">, [number, number]> = {
  pressure: [0, 3],
  battery_pct: [0, 100],
  rtt_ms: [0, 600_000],
  downlink_mbps: [0, 100_000],
  heap_mb: [0, 1e6],
  fps: [0, 1000],
};

function historyOnWire(h: RawReadings["history"]): ClientContext["history"] {
  const interval = num(h?.intervalS, 1, 600);
  if (!h || interval === undefined) return undefined;
  const samples = h.samples.flatMap((s) => {
    const t = num(s.t, 0, 1e11);
    if (t === undefined) return [];
    const out: Sample = { t };
    for (const [key, [lo, hi]] of Object.entries(SAMPLE_BOUNDS) as [keyof typeof SAMPLE_BOUNDS, [number, number]][]) {
      const v = num(s[key], lo, hi);
      if (v !== undefined) out[key] = v;
    }
    return [out];
  });
  return samples.length ? { interval_s: interval, samples: samples.slice(-60) } : undefined;
}

// --- collection (browser only) ---------------------------------------------

/**
 * Snapshot for a /query. The readings are already current in the store —
 * startDeviceMonitor keeps them so from the browser's own events — so this
 * awaits nothing and cannot delay the question.
 */
export async function collectClientContext(): Promise<ClientContext | undefined> {
  if (typeof navigator === "undefined" || typeof window === "undefined") return undefined;
  const { device, location } = useFridayStore.getState();
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return buildClientContext({
    ...device,
    cores: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    heapBytes: heap?.usedJSHeapSize,
    platform: nav.userAgentData?.platform,
    // Offset read now, not from the snapshot: it moves at DST boundaries.
    tzOffsetMin: new Date().getTimezoneOffset(),
    location: location ?? undefined,
    history: { intervalS: HISTORY_INTERVAL_S, samples: history },
  });
}
