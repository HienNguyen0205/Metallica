import { test, expect } from "@playwright/test";
import { gotoLitScene, regionStats, shot } from "./helpers";

/**
 * The core must yield the center stage while a centered visualization owns
 * it. Recede-to-0.4 alone leaves the emissive ball glowing through the viz —
 * measured tiny-center luma 196 with globe active, identical to idle — so the
 * core now docks to the screen corner until the stage is free again.
 */

const TINY = { x0: 0.49, y0: 0.478, x1: 0.51, y1: 0.522 };
// docked core at the screen corner (responsive dock target)
const DOCK = { x0: 0.1, y0: 0.67, x1: 0.22, y1: 0.81 };

test.beforeEach(async ({ page }) => {
  await gotoLitScene(page);
});

test("idle core sits at the exact center", async ({ page }) => {
  const idle = await shot(page);
  const idleTiny = regionStats(
    idle,
    idle.width * TINY.x0,
    idle.height * TINY.y0,
    idle.width * TINY.x1,
    idle.height * TINY.y1,
  );
  console.log(`[home] tiny=${idleTiny.meanLuma.toFixed(1)}`);
  expect(idleTiny.meanLuma).toBeGreaterThan(150);
});

test("docked core clears the center when a viz owns the stage", async ({ page }) => {
  await page.click(`#viz-rail button:has-text("GLOBE")`);
  // materialize entrance + dock ease need room to settle
  await page.waitForTimeout(3500);
  const img = await shot(page);
  const tiny = regionStats(
    img,
    img.width * TINY.x0,
    img.height * TINY.y0,
    img.width * TINY.x1,
    img.height * TINY.y1,
  );
  const dock = regionStats(
    img,
    img.width * DOCK.x0,
    img.height * DOCK.y0,
    img.width * DOCK.x1,
    img.height * DOCK.y1,
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
  // …because it moved to the screen corner…
  expect(dock.cyanRatio).toBeGreaterThan(0.02);
  // …while the visualization itself still paints the center
  expect(center.meanLuma).toBeGreaterThan(12);
});
