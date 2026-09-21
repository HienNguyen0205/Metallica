import { test, expect } from "@playwright/test";
import { deviceAlerts } from "@/lib/deviceMonitor";

test("a healthy device raises nothing", () => {
  const a = deviceAlerts({ online: true, pressure: "nominal", battery: { level: 0.9, charging: false }, connection: { effectiveType: "4g" } });
  expect(a).toEqual({ pressureHigh: false, lowPower: false, constrained: false, offline: false, strained: false });
});

test("serious or critical CPU pressure is high", () => {
  expect(deviceAlerts({ online: true, pressure: "serious" }).pressureHigh).toBe(true);
  expect(deviceAlerts({ online: true, pressure: "critical" }).strained).toBe(true);
  expect(deviceAlerts({ online: true, pressure: "fair" }).pressureHigh).toBe(false);
});

test("low power means under 20% and not charging", () => {
  expect(deviceAlerts({ online: true, battery: { level: 0.15, charging: false } }).lowPower).toBe(true);
  expect(deviceAlerts({ online: true, battery: { level: 0.15, charging: true } }).lowPower).toBe(false);
  expect(deviceAlerts({ online: true, battery: { level: 0.2, charging: false } }).lowPower).toBe(false);
});

test("save-data or a 2g link is constrained; offline is its own alert", () => {
  expect(deviceAlerts({ online: true, connection: { saveData: true } }).constrained).toBe(true);
  expect(deviceAlerts({ online: true, connection: { effectiveType: "slow-2g" } }).constrained).toBe(true);
  const off = deviceAlerts({ online: false });
  expect(off.offline).toBe(true);
  // Offline says nothing about the GPU: it must not lower render quality.
  expect(off.strained).toBe(false);
});
