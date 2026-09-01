import { test, expect, type Page } from "@playwright/test";
import { gotoScene } from "./helpers";

/**
 * §5 interaction:"drill_down" — clicking a holographic element locks a focus
 * reticle onto it, reports it in the edge telemetry, and a second click on
 * the same element releases it.
 */

type Vec3 = [number, number, number];

const EYE: Vec3 = [0, 0.15, 6.8];
const TAN_HALF_FOV = Math.tan((45 * Math.PI) / 180 / 2);

function project(p: Vec3, w = 1440, h = 900): Vec3 {
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
  return [(ndcX + 1) / 2 * w, (1 - (ndcY + 1) / 2) * h, 0];
}

/** Screen-space candidates for the four orbiting metric nodes (radial_gauge). */
function gaugeNodePoints(): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * 2.95;
    const z = Math.sin(angle) * 2.95 * 0.55;
    const y = Math.sin(i * 1.7) * 0.35;
    out.push(project([x, y, z]));
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

  // the reticle adds new bright geometry around the selected node
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
 * decision itself is a pure function now — `nextFocus` — and it is checked
 * exhaustively and deterministically in tests/unit/vizFocus.spec.ts. What the
 * two tests here still cover is the part only a browser can: that a real click
 * reaches the handler at all, and that focus is dropped when the scene changes.
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
