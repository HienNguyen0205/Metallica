/**
 * The operator's own device, measured by the browser with no permission
 * prompt, for the orchestrator's `get_client_metrics` tool. Its
 * `get_system_metrics` reads the server it runs on — this is the only way
 * "how is my laptop doing" gets the laptop's numbers.
 *
 * Sent with every /query; the backend holds it for that turn only and the
 * model sees it only if it calls the tool. Nothing here is persisted.
 */

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
  languages?: string[];
  screen?: { width: number; height: number; dpr: number };
}

type PressureState = "nominal" | "fair" | "serious" | "critical";

/** What the browser APIs hand back, in their own units. */
export interface RawReadings {
  cores?: number;
  deviceMemory?: number;
  pressure?: string;
  battery?: { level: number; charging: boolean };
  storage?: { usage: number; quota: number };
  connection?: { effectiveType?: string; downlink?: number; rtt?: number };
  heapBytes?: number;
  gpu?: { vendor?: string; architecture?: string };
  platform?: string;
  timezone?: string;
  languages?: readonly string[];
  screen?: { width: number; height: number; dpr: number };
}

const PRESSURE = new Set(["nominal", "fair", "serious", "critical"]);
const NET_TYPES = new Set(["slow-2g", "2g", "3g", "4g"]);
/** Must match the backend's max_length bounds. */
const MAX_STR = 40;

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const round1 = (v: number) => Math.round(v * 10) / 10;
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
    languages: langs?.length ? langs.slice(0, 5) : undefined,
    screen: width && height && dpr ? { width, height, dpr } : undefined,
  });
}

// --- collection (browser only) ---------------------------------------------

/** Compute Pressure only reports changes, so the latest state is kept here. */
let pressure: string | undefined;
let pressureStarted = false;
/** Started once; later questions race the same promise, so a first-call
 *  timeout (adapter creation can take longer than the budget) is not final. */
let gpuInfo: Promise<RawReadings["gpu"] | undefined> | undefined;

function watchPressure() {
  if (pressureStarted || typeof window === "undefined" || !("PressureObserver" in window)) return;
  pressureStarted = true;
  try {
    type Rec = { state: string };
    const Observer = (window as unknown as {
      PressureObserver: new (cb: (records: Rec[]) => void) => { observe(source: string, opts?: object): Promise<void> };
    }).PressureObserver;
    const observer = new Observer((records) => {
      pressure = records.at(-1)?.state;
    });
    observer.observe("cpu", { sampleInterval: 2000 }).catch(() => {});
  } catch {
    // Unsupported or blocked by Permissions-Policy — simply no reading.
  }
}

/** Resolve within `ms` or give up — a slow API must not delay the question. */
function within<T>(p: Promise<T> | undefined, ms = 250): Promise<T | undefined> {
  if (!p) return Promise.resolve(undefined);
  return Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, ms))]);
}

type Nav = Navigator & {
  deviceMemory?: number;
  connection?: { effectiveType?: string; downlink?: number; rtt?: number };
  getBattery?: () => Promise<{ level: number; charging: boolean }>;
  gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string } } | null> };
  userAgentData?: { platform?: string };
};

export async function collectClientContext(): Promise<ClientContext | undefined> {
  if (typeof navigator === "undefined" || typeof window === "undefined") return undefined;
  watchPressure();
  const nav = navigator as Nav;
  try {
    gpuInfo ??= nav.gpu
      ?.requestAdapter()
      .then((a) => (a?.info ? { vendor: a.info.vendor, architecture: a.info.architecture } : undefined))
      .catch(() => undefined);
    const [battery, storage, gpu] = await Promise.all([
      within(nav.getBattery?.()),
      within(navigator.storage?.estimate?.()),
      within(gpuInfo),
    ]);
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return buildClientContext({
      cores: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory,
      pressure,
      battery: battery ? { level: battery.level, charging: battery.charging } : undefined,
      storage: storage ? { usage: storage.usage ?? 0, quota: storage.quota ?? 0 } : undefined,
      connection: nav.connection,
      heapBytes: heap?.usedJSHeapSize,
      gpu,
      platform: nav.userAgentData?.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      languages: navigator.languages,
      screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
    });
  } catch {
    return undefined;
  }
}
