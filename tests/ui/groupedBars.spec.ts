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
    await page.locator("input").pressSequentially("compare requests", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("hud-state")).toHaveText("IDLE", { timeout: 30_000 });
    // entrance + grow animations settle; the camera keeps drifting slowly
    await page.waitForTimeout(2500);
  } finally {
    await stub.close();
  }
}

test("a bar in the second series is pickable with its own tag", async ({ page }) => {
  await gotoScene(page);
  await runGroupedFlow(page);

  // Tallest P95 bar (category 1, value 44): category 1 sits dead center on
  // the arc, offset +0.11 along the tangent for the second series, vertical
  // center from the shared 0..58 scale. Both idle and visualizing camera
  // distances are tried — the rig eases between them and never holds still.
  const target: Vec3 = [0.11, -0.17, 1.1];
  const candidates: [number, number][] = [];
  for (const eyeZ of [6.8, 7.7]) {
    const [cx, cy] = projectFrom(target, eyeZ);
    for (let dx = -75; dx <= 75; dx += 25) {
      for (let dy = -30; dy <= 30; dy += 15) {
        candidates.push([cx + dx, cy + dy]);
      }
    }
  }

  let locked = "";
  for (const [x, y] of candidates) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(200);
    const text = await focusText(page);
    if (/FOCUS · P95/.test(text)) {
      locked = text;
      break;
    }
  }
  expect(locked, "no click reached a P95 bar").toMatch(/FOCUS · P95/);
});
