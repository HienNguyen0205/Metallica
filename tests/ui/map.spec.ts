import { test, expect, type Page } from "@playwright/test";
import { gotoLitScene } from "./helpers";

/**
 * Street map (spec 2026-09-21). api.maptiler.com is stubbed: a background-only
 * style is enough for real MapLibre to load in Chromium without the network.
 */
const STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#0b1620" } }],
};

export async function stubMapTiler(page: Page, geocode: unknown = { features: [] }) {
  await page.route("https://api.maptiler.com/maps/**", (r) => r.fulfill({ json: STYLE }));
  await page.route("https://api.maptiler.com/geocoding/**", (r) => r.fulfill({ json: geocode }));
}

const layer = (page: Page) => page.getByTestId("map-layer");

test("an agent map spec opens the map; Esc hands back to the globe", async ({ page }) => {
  await stubMapTiler(page);
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  await expect(page.locator("html")).toHaveAttribute("data-map", "on");
  await page.keyboard.press("Escape");
  await expect(layer(page)).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator("html")).toHaveAttribute("data-map", "off");
});

test("zooming the globe past its limit hands off to the map", async ({ page }) => {
  await stubMapTiler(page);
  await gotoLitScene(page);
  await page.click(`#viz-rail button:has-text("GLOBE")`);
  await page.waitForTimeout(2000);
  const size = page.viewportSize()!;
  await page.mouse.move(size.width / 2, size.height / 2);
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(40);
  }
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 15_000 });
  await page.getByRole("button", { name: "Quay lại địa cầu" }).click();
  await expect(layer(page)).toHaveCount(0, { timeout: 5_000 });
});

test("reduced motion shortens the handoff to a quick fade", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubMapTiler(page);
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  expect(await layer(page).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.15s");
});
