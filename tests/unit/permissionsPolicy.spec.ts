import { test, expect } from "@playwright/test";
import nextConfig from "../../next.config";

async function policy(): Promise<Map<string, string>> {
  const rules = (await nextConfig.headers!()) ?? [];
  const header = rules.flatMap((r) => r.headers).find((h) => h.key.toLowerCase() === "permissions-policy");
  expect(header, "Permissions-Policy header missing").toBeTruthy();
  return new Map(
    header!.value.split(",").map((d) => {
      const [name, allow] = d.trim().split("=");
      return [name!, allow!];
    }),
  );
}

test("features the app uses are allowed for this origin only", async () => {
  const p = await policy();
  // microphone: voice; geolocation: LOC; compute-pressure: get_client_metrics
  for (const feature of ["microphone", "geolocation", "compute-pressure"]) {
    expect(p.get(feature), feature).toBe("(self)");
  }
});

test("powerful features the app never uses are switched off", async () => {
  const p = await policy();
  for (const feature of ["camera", "usb", "serial", "bluetooth", "hid", "payment", "display-capture", "idle-detection"]) {
    expect(p.get(feature), feature).toBe("()");
  }
});
