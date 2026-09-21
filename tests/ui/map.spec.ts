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

const GEOCODE = {
  features: [
    { text: "Hồ Gươm", place_name: "Hồ Gươm, Hoàn Kiếm, Hà Nội", center: [105.8525, 21.0288], place_type: ["poi"] },
    { text: "Hồ Tây", place_name: "Hồ Tây, Tây Hồ, Hà Nội", center: [105.8194, 21.0583], place_type: ["poi"] },
  ],
};

test("search autocompletes, picks with the keyboard and opens the place card", async ({ page }) => {
  await stubMapTiler(page, GEOCODE);
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  const box = page.getByRole("combobox", { name: "Tìm kiếm địa điểm" });
  await box.click();
  await box.pressSequentially("hồ", { delay: 20 });
  await expect(page.getByRole("option")).toHaveCount(2);
  await box.press("ArrowDown");
  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(page.getByTestId("place-card")).toContainText("Hồ Tây");
  await expect(page.getByTestId("place-card")).toContainText("21.058300, 105.819400");
  // Esc inside an input only closes its list; leave the input so Esc reaches the map.
  await box.evaluate((el) => (el as HTMLElement).blur());
  await page.keyboard.press("Escape"); // closes the card, not the map
  await expect(page.getByTestId("place-card")).toHaveCount(0);
  await expect(layer(page)).toHaveAttribute("data-mode", "map");
});

test("right-click offers directions from/to and what's here", async ({ page }) => {
  await stubMapTiler(page, GEOCODE);
  await page.goto("/?viz=map");
  await expect(layer(page)).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  const size = page.viewportSize()!;
  await page.mouse.click(size.width / 2, size.height / 2, { button: "right" });
  const menu = page.getByRole("menu", { name: "Tùy chọn vị trí" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Đây là đâu?" }).click();
  await expect(page.getByTestId("place-card")).toContainText("Hồ Gươm"); // reverse geocode stub answers the first feature
});
