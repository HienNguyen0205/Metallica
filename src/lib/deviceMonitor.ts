/**
 * Live device readings, kept current by the browser's own events rather than
 * a timer: Compute Pressure, battery, network and language all announce their
 * changes. Only storage has no event, so it alone is polled — once a minute,
 * and only while the tab is visible. Returning to the tab refreshes what can
 * drift unseen (timezone after travel, a stale location fix).
 *
 * The readings land in the store (`device`): the HUD and render quality react
 * to them (deviceAlerts), and each /query sends a snapshot (clientContext).
 */
import { useFridayStore } from "@/lib/store";
import type { RawReadings } from "@/lib/clientContext";
import { refreshIfStale } from "@/lib/geolocation";

export type DeviceState = Pick<
  RawReadings,
  "pressure" | "battery" | "connection" | "storage" | "gpu" | "timezone" | "tzOffsetMin" | "languages" | "screen"
> & { online: boolean };

export interface DeviceAlerts {
  /** Compute Pressure serious or critical. */
  pressureHigh: boolean;
  /** Under 20% and discharging. */
  lowPower: boolean;
  /** Save-Data on, or a 2g-class link. */
  constrained: boolean;
  offline: boolean;
  /** Any reason to spend less on rendering. Offline is not one: it says nothing about the GPU. */
  strained: boolean;
}

export function deviceAlerts(d: DeviceState): DeviceAlerts {
  const pressureHigh = d.pressure === "serious" || d.pressure === "critical";
  const lowPower = !!d.battery && d.battery.level < 0.2 && !d.battery.charging;
  const constrained =
    !!d.connection?.saveData || d.connection?.effectiveType === "2g" || d.connection?.effectiveType === "slow-2g";
  return {
    pressureHigh,
    lowPower,
    constrained,
    offline: !d.online,
    strained: pressureHigh || lowPower || constrained,
  };
}

/** Storage has no change event; the one reading on a timer. */
const STORAGE_POLL_MS = 60_000;
/** A location fix older than this is refreshed when the tab comes back. */
const LOCATION_MAX_AGE_MS = 15 * 60_000;

type Nav = Navigator & {
  deviceMemory?: number;
  connection?: EventTarget & { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  getBattery?: () => Promise<EventTarget & { level: number; charging: boolean }>;
  gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string } } | null> };
};

let stopActive: (() => void) | null = null;

/** Idempotent; returns the stop function. Browser only. */
export function startDeviceMonitor(): () => void {
  if (stopActive) return stopActive;
  if (typeof window === "undefined") return () => {};
  const nav = navigator as Nav;
  const set = (patch: Partial<DeviceState>) => useFridayStore.getState().setDevice(patch);
  const cleanups: Array<() => void> = [];
  const on = (target: EventTarget | undefined | null, type: string, fn: () => void) => {
    if (!target) return;
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  // --- event-driven -------------------------------------------------------
  const readConnection = () => {
    const c = nav.connection;
    set({
      online: navigator.onLine,
      connection: c ? { effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt, saveData: c.saveData } : undefined,
    });
  };
  readConnection();
  on(window, "online", readConnection);
  on(window, "offline", readConnection);
  on(nav.connection, "change", readConnection);

  const readLocale = () =>
    set({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzOffsetMin: new Date().getTimezoneOffset(),
      languages: [...navigator.languages],
    });
  readLocale();
  on(window, "languagechange", readLocale);

  const readScreen = () => set({ screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio } });
  readScreen();
  on(window, "resize", readScreen);

  let alive = true;
  nav
    .getBattery?.()
    .then((b) => {
      if (!alive) return;
      const read = () => set({ battery: { level: b.level, charging: b.charging } });
      read();
      on(b, "levelchange", read);
      on(b, "chargingchange", read);
    })
    .catch(() => {});

  if ("PressureObserver" in window) {
    try {
      type Rec = { state: string };
      const Observer = (window as unknown as {
        PressureObserver: new (cb: (records: Rec[]) => void) => {
          observe(source: string, opts?: object): Promise<void>;
          disconnect(): void;
        };
      }).PressureObserver;
      const observer = new Observer((records) => set({ pressure: records.at(-1)?.state }));
      observer.observe("cpu", { sampleInterval: 2000 }).catch(() => {});
      cleanups.push(() => observer.disconnect());
    } catch {
      // Blocked by Permissions-Policy or unsupported — no pressure reading.
    }
  }

  // Adapter info never changes: once per page.
  nav.gpu
    ?.requestAdapter()
    .then((a) => alive && a?.info && set({ gpu: { vendor: a.info.vendor, architecture: a.info.architecture } }))
    .catch(() => {});

  // --- polled / on return --------------------------------------------------
  const readStorage = () => {
    if (document.hidden) return;
    navigator.storage
      ?.estimate?.()
      .then((s) => alive && set({ storage: { usage: s.usage ?? 0, quota: s.quota ?? 0 } }))
      .catch(() => {});
  };
  readStorage();
  const timer = setInterval(readStorage, STORAGE_POLL_MS);
  cleanups.push(() => clearInterval(timer));

  on(document, "visibilitychange", () => {
    if (document.hidden) return;
    readLocale(); // travelled while away
    readStorage();
    refreshIfStale(LOCATION_MAX_AGE_MS);
  });

  stopActive = () => {
    alive = false;
    cleanups.forEach((fn) => fn());
    stopActive = null;
  };
  return stopActive;
}
