import { test, expect, type Page } from "@playwright/test";
import { gotoScene } from "./helpers";

/**
 * §5 per-viz native focus — clicking a holographic element selects it
 * (rendered by the viz itself), reports it in the edge telemetry, and a
 * second click on the same element releases it.
 */

import { fanPosition } from "@/components/friday/visualization/vizRadial";

type Vec3 = [number, number, number];

// The rig eases between the idle (6.8) and visualizing (7.7) dollies and never
// holds still — candidates are projected from both, like groupedBars.spec does.
const TAN_HALF_FOV = Math.tan((45 * Math.PI) / 180 / 2);

function project(p: Vec3, eye: Vec3, w = 1440, h = 900): Vec3 {
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

  const f = norm([-eye[0], -eye[1], -eye[2]]);
  const right = norm(cross(f, [0, 1, 0]));
  const up = cross(right, f);
  const v = sub(p, eye);

  const cx = dot(v, right);
  const cy = dot(v, up);
  const cz = dot(v, f);
  const ndcX = cx / cz / TAN_HALF_FOV / (w / h);
  const ndcY = cy / cz / TAN_HALF_FOV;
  return [(ndcX + 1) / 2 * w, (1 - (ndcY + 1) / 2) * h, 0];
}

/**
 * Screen-space candidates for the four fanned metric nodes (radial_gauge).
 * The world layout comes from the app's own `fanPosition` — the previous copy
 * of the retired orbit math silently rotted when the layout became a fan.
 */
function gaugeNodePoints(): Vec3[] {
  const out: Vec3[] = [];
  for (const eyeZ of [6.8, 7.7]) {
    const eye: Vec3 = [0, 0.15, eyeZ];
    for (let i = 0; i < 4; i++) out.push(project(fanPosition(i, 4), eye));
  }
  return out;
}

async function focusText(page: Page): Promise<string> {
  return (await page.textContent("[data-testid='hud-focus']")) ?? "";
}

const CLEARED = "FOCUS · --";

/**
 * Clicks candidate points until one locks focus, reporting which point worked
 * and what it locked.
 *
 * The points are computed from a *static* camera, but the scene never holds
 * still: every metric node bobs each frame and the camera rig drifts and
 * swings continuously. So a point is a good guess, not a guarantee, and which
 * one lands varies from run to run.
 */
async function lockFocus(page: Page): Promise<{ point: Vec3; locked: string } | null> {
  for (const point of gaugeNodePoints()) {
    await page.mouse.click(point[0], point[1]);
    await page.waitForTimeout(250);
    const text = await focusText(page);
    if (/FOCUS · (CPU|RAM|DISK|NET)/.test(text)) return { point, locked: text };
  }
  return null;
}

test.beforeEach(async ({ page }) => {
  await gotoScene(page);
});

test("clicking a metric node drills into it", async ({ page }) => {
  await page.click("#viz-rail button:has-text('RADIAL GAUGE')");
  await page.waitForTimeout(1200);

  expect(await focusText(page)).toBe(CLEARED);

  const hit = await lockFocus(page);
  expect(hit, `no metric node was hit; last focus: "${await focusText(page)}"`).not.toBeNull();

  // the native gauge selection enlarges + tints the picked node
  console.log(`[drilldown] locked focus: "${hit!.locked}"`);
});

/**
 * There is deliberately no end-to-end test for the release half of the toggle.
 *
 * Two were written and both were withdrawn. The first clicked one screen point
 * twice and demanded a release; the metric nodes bob every frame under a
 * drifting camera, so the second click could land on a neighbour, and it failed
 * about one run in nine on correct code — invisibly on CI, where `retries: 2`
 * swallowed it. The second added a three-click confirmation to rule that out,
 * and passed against a build with the release branch deleted: a click that
 * misses clears the focus through `onPointerMissed` exactly as a release does,
 * so "cleared, then locked again" proves a miss and a hit, not a toggle.
 *
 * A moving target reached by fixed coordinates cannot tell those apart. The
 * decision itself is a pure function — `toggleFocus` — and it is checked
 * exhaustively and deterministically in tests/unit/focus.spec.ts. What the
 * two tests here still cover is the part only a browser can: that a real click
 * reaches the viz's own pick handler at all, and that focus is dropped when
 * the scene changes.
 */
test("switching visualization clears a stale focus", async ({ page }) => {
  await page.click("#viz-rail button:has-text('RADIAL GAUGE')");
  await page.waitForTimeout(1200);

  let locked = false;
  for (const p of gaugeNodePoints()) {
    await page.mouse.click(p[0], p[1]);
    await page.waitForTimeout(250);
    if (/FOCUS · (CPU|RAM|DISK|NET)/.test(await focusText(page))) {
      locked = true;
      break;
    }
  }
  expect(locked).toBe(true);

  await page.click("#viz-rail button:has-text('NETWORK')");
  await page.waitForTimeout(600);
  expect(await focusText(page)).toBe("FOCUS · --");
});
