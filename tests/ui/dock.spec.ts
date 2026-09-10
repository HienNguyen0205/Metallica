import { test, expect } from "@playwright/test";
import { gotoLitScene, regionStats, shot } from "./helpers";

/**
 * The core must yield the center stage while a centered visualization owns
 * it. Recede-to-0.4 alone leaves the emissive ball glowing through the viz —
 * measured tiny-center luma 196 with globe active, identical to idle — so the
 * core now docks lower-left until the stage is free again.
 */

test.beforeEach(async ({ page }) => {
  await gotoLitScene(page);
});

test("docked core clears the center when a viz owns the stage", async ({ page }) => {
  // idle baseline: the full core ball sits at the exact center
  const idle = await shot(page);
  const idleTiny = regionStats(
    idle,
    idle.width * 0.49,
    idle.height * 0.478,
    idle.width * 0.51,
    idle.height * 0.522,
  );
  expect(idleTiny.meanLuma).toBeGreaterThan(150);

  await page.click(`#viz-rail button:has-text("GLOBE")`);
  // materialize entrance + dock ease need room to settle
  await page.waitForTimeout(3500);
  const img = await shot(page);
  const tiny = regionStats(
    img,
    img.width * 0.49,
    img.height * 0.478,
    img.width * 0.51,
    img.height * 0.522,
  );
  const dock = regionStats(
    img,
    img.width * 0.125,
    img.height * 0.555,
    img.width * 0.25,
    img.height * 0.711,
  );
  const center = regionStats(
    img,
    img.width * 0.4,
    img.height * 0.37,
    img.width * 0.6,
    img.height * 0.63,
  );
  console.log(
    `[dock] tiny=${tiny.meanLuma.toFixed(1)} dockCyan=${(dock.cyanRatio * 100).toFixed(2)}% center=${center.meanLuma.toFixed(1)}`,
  );

  // the bright core ball is gone from the exact center…
  expect(tiny.meanLuma).toBeLessThan(100);
  // …because it moved lower-left…
  expect(dock.cyanRatio).toBeGreaterThan(0.02);
  // …while the visualization itself still paints the center
  expect(center.meanLuma).toBeGreaterThan(12);
});
