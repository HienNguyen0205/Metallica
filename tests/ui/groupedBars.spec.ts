import { test, expect, type Page } from "@playwright/test";
import { gotoScene } from "./helpers";
import { GROUPED_BAR_FLOW, startStubOrchestrator } from "./stubOrchestrator";

type Vec3 = [number, number, number];

/** Same pinhole math as drilldown.spec.ts, parameterized by camera distance. */
function projectFrom(p: Vec3, eyeZ: number, w = 1440, h = 900): [number, number] {
  const EYE: Vec3 = [0, 0.15, eyeZ];
  const TAN_HALF_FOV = Math.tan((45 * Math.PI) / 180 / 2);
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

  const f = norm([-EYE[0], -EYE[1], -EYE[2]]);
  const right = norm(cross(f, [0, 1, 0]));
  const up = cross(right, f);
  const v = sub(p, EYE);
  const cx = dot(v, right);
  const cy = dot(v, up);
  const cz = dot(v, f);
  const ndcX = cx / cz / TAN_HALF_FOV / (w / h);
  const ndcY = cy / cz / TAN_HALF_FOV;
  return [((ndcX + 1) / 2) * w, (1 - (ndcY + 1) / 2) * h];
}

async function focusText(page: Page): Promise<string> {
  return (await page.textContent("[data-testid='hud-focus']")) ?? "";
}

async function runGroupedFlow(page: Page) {
  const stub = await startStubOrchestrator(GROUPED_BAR_FLOW);
  try {
    await page.reload();
    await page.waitForSelector("canvas");
    await page.locator("input").click();
    await page.locator("input").pressSequentially("compare requests", { delay: 15, timeout: 60_000 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("hud-state")).toHaveText("IDLE", { timeout: 30_000 });
    // entrance + grow animations settle; the camera keeps drifting slowly
    await page.waitForTimeout(2500);
  } finally {
    await stub.close();
  }
}

test("a bar in the second series is pickable with its own tag", async ({ page }) => {
  // Reduced motion pins the rig at x=0, y=0.15 — no drift, swing or pointer
  // parallax — leaving only the dolly easing between distances. The old
  // drift-hunt sweep needed ~70 clicks to maybe catch the moving bar and
  // outran the 120s budget on a 2fps software renderer.
  test.slow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoScene(page);
  await runGroupedFlow(page);

  // Tallest P95 bar (category 1, value 44): category 1 sits dead center on
  // the arc, offset +0.11 along the tangent for the second series, vertical
  // center from the shared 0..58 scale. The projected point slides only a few
  // px across the whole dolly range, so a tight grid covers every z the rig
  // might still be easing through (visualizing 7.7 down to idle 6.8). Each
  // click costs seconds on software GL, so candidates fan out from the most
  // likely spot — dead center at the current dolly — rather than sweeping
  // corner to corner.
  const target: Vec3 = [0.11, -0.17, 1.1];
  const candidates: [number, number][] = [];
  for (const eyeZ of [7.7, 6.8]) {
    const [cx, cy] = projectFrom(target, eyeZ);
    for (let r = 0; r <= 12; r += 6) {
      for (let dy = -10; dy <= 10; dy += 10) {
        if (r === 0) candidates.push([cx, cy + dy]);
        else candidates.push([cx + r, cy + dy], [cx - r, cy + dy]);
      }
    }
  }

  const t0 = Date.now();
  let locked = "";
  let clicks = 0;
  for (const [x, y] of candidates) {
    await page.mouse.click(x, y);
    clicks++;
    await page.waitForTimeout(200);
    const text = await focusText(page);
    if (/FOCUS · P95/.test(text)) {
      locked = text;
      break;
    }
  }
  console.log(`[pick] ${clicks} clicks, locked="${locked}", sweep=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  expect(locked, "no click reached a P95 bar").toMatch(/FOCUS · P95/);
});
