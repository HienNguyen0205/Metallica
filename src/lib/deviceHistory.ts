/**
 * Ring buffer of device samples — what lets get_client_history answer "how
 * has my connection been" rather than only "how is it now". One sample every
 * HISTORY_INTERVAL_S while the tab is visible, the newest HISTORY_MAX kept
 * (~10 minutes). In memory only; sent with each question, never stored.
 */
import type { DeviceState } from "@/lib/deviceMonitor";

export const HISTORY_INTERVAL_S = 10;
/** Must match ClientHistory.samples max_length on the backend. */
export const HISTORY_MAX = 60;

/** Wire shape of one sample (backend ClientSample). */
export interface Sample {
  t: number;
  /** 0 nominal, 1 fair, 2 serious, 3 critical. */
  pressure?: number;
  battery_pct?: number;
  rtt_ms?: number;
  downlink_mbps?: number;
  heap_mb?: number;
  fps?: number;
}

const PRESSURE_LEVEL: Record<string, number> = { nominal: 0, fair: 1, serious: 2, critical: 3 };

/** Zero from telemetry means "no reading yet", not a measured zero. */
const positive = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export function takeSample(device: DeviceState, telemetry: { fps: number; heapMB: number }, nowMs: number): Sample {
  const s: Sample = { t: Math.floor(nowMs / 1000) };
  if (device.pressure && device.pressure in PRESSURE_LEVEL) s.pressure = PRESSURE_LEVEL[device.pressure];
  if (device.battery) s.battery_pct = Math.round(device.battery.level * 100);
  if (typeof device.connection?.rtt === "number") s.rtt_ms = device.connection.rtt;
  if (typeof device.connection?.downlink === "number") s.downlink_mbps = device.connection.downlink;
  const heap = positive(telemetry.heapMB);
  if (heap !== undefined) s.heap_mb = Math.round(heap * 10) / 10;
  const fps = positive(telemetry.fps);
  if (fps !== undefined) s.fps = Math.round(fps);
  return s;
}

export function pushSample<T>(buf: T[], sample: T, max = HISTORY_MAX): void {
  buf.push(sample);
  if (buf.length > max) buf.splice(0, buf.length - max);
}

/** The live buffer, filled by startDeviceMonitor. */
export const history: Sample[] = [];
