import { test, expect } from "@playwright/test";
import { HISTORY_MAX, pushSample, takeSample } from "@/lib/deviceHistory";
import { buildClientContext } from "@/lib/clientContext";

test("a sample takes what the device state and telemetry currently hold", () => {
  const s = takeSample(
    { online: true, pressure: "serious", battery: { level: 0.456, charging: false }, connection: { rtt: 150, downlink: 1.5 } },
    { fps: 59.6, heapMB: 38.44 },
    1_790_000_000_500,
  );
  expect(s).toEqual({ t: 1_790_000_000, pressure: 2, battery_pct: 46, rtt_ms: 150, downlink_mbps: 1.5, heap_mb: 38.4, fps: 60 });
});

test("readings the browser does not have are left out, not zeroed", () => {
  // telemetry reports 0 before its first window: that is "no reading", not 0 fps
  expect(takeSample({ online: true }, { fps: 0, heapMB: 0 }, 1000)).toEqual({ t: 1 });
});

test("the ring keeps the newest HISTORY_MAX samples", () => {
  const buf: { t: number }[] = [];
  for (let i = 0; i < HISTORY_MAX + 5; i++) pushSample(buf, { t: i });
  expect(buf).toHaveLength(HISTORY_MAX);
  expect(buf[0]!.t).toBe(5);
  expect(buf.at(-1)!.t).toBe(HISTORY_MAX + 4);
});

test("history goes on the wire with its interval, junk samples dropped", () => {
  const ctx = buildClientContext({
    history: { intervalS: 10, samples: [{ t: 1, rtt_ms: 150 }, { t: 2, fps: Number.NaN }, { t: Number.NaN }] },
  });
  expect(ctx.history).toEqual({ interval_s: 10, samples: [{ t: 1, rtt_ms: 150 }, { t: 2 }] });
  expect(buildClientContext({ history: { intervalS: 10, samples: [] } }).history).toBeUndefined();
});
