import { test, expect } from "@playwright/test";
import { diffRatio, glRenderer, gotoScene, isSoftwareGL, regionStats, shot } from "./helpers";

/**
 * The hologram itself: does WebGL actually paint a lit, cyan, animated core,
 * does every visualization type materialize, and does the render loop survive
 * every state without losing the GL context or logging errors.
 */

test.beforeEach(async ({ page }) => {
  await gotoScene(page);
});

// ---------- §2/§13 the core actually renders and glows ----------

test("hologram renders: bright core + cyan hologram pixels", async ({ page }) => {
  const img = await shot(page);
  const center = regionStats(
    img,
    img.width * 0.38,
    img.height * 0.32,
    img.width * 0.62,
    img.height * 0.68,
  );
  const whole = regionStats(img, 0, 0, img.width, img.height);

  console.log(
    `[metrics] center luma=${center.meanLuma.toFixed(1)} cyan=${(center.cyanRatio * 100).toFixed(2)}% whole cyan=${(whole.cyanRatio * 100).toFixed(2)}%`,
  );

  expect(center.meanLuma).toBeGreaterThan(12); // core is visibly lit, not a black screen
  expect(whole.cyanRatio).toBeGreaterThan(0.005); // cyan hologram language is present
});

test("composition is centre-weighted, not edge-to-edge dashboard fill", async ({ page }) => {
  const img = await shot(page);
  const center = regionStats(
    img,
    img.width * 0.35,
    img.height * 0.3,
    img.width * 0.65,
    img.height * 0.7,
  );
  const corners = [
    regionStats(img, 0, 0, img.width * 0.18, img.height * 0.18),
    regionStats(img, img.width * 0.82, img.height * 0.82, img.width, img.height),
  ];
  const cornerLuma = (corners[0].meanLuma + corners[1].meanLuma) / 2;
  console.log(`[composition] center=${center.meanLuma.toFixed(1)} corners=${cornerLuma.toFixed(1)}`);
  // §3 negative space: the core dominates, the corners stay quiet
  expect(center.meanLuma).toBeGreaterThan(cornerLuma * 2);
});

// ---------- §8 the scene is never static ----------

test("the hologram is alive while idle", async ({ page }) => {
  const a = await shot(page);
  await page.waitForTimeout(700);
  const b = await shot(page);
  const d = diffRatio(a, b);
  console.log(`[idle motion] ${(d * 100).toFixed(2)}% pixels changed in 700ms`);
  expect(d).toBeGreaterThan(0.001);
});

// ---------- §16 every visualization materializes distinctly ----------

test("every viz type renders something different from idle", async ({ page }) => {
  // ten full-screen screenshots on software GL are slow; give it headroom
  test.slow();
  const baseline = await shot(page);
  const types = [
    "RADIAL GAUGE",
    "HEALTH CORE",
    "RADAR",
    "WAVEFORM",
    "LINE 3D",
    "BAR 3D",
    "TIMELINE",
    "NETWORK",
    "GLOBE",
    "PARTICLE FLOW",
  ];
  for (const label of types) {
    await page.click(`#viz-rail button:has-text("${label}")`);
    await page.waitForTimeout(900);
    const img = await shot(page);
    const d = diffRatio(img, baseline);
    console.log(`[viz] ${label}: ${(d * 100).toFixed(2)}% pixels differ from idle`);
    expect(d, `${label} must change the scene`).toBeGreaterThan(0.01);
  }
});

// ---------- shader / GL health across the whole state machine ----------

test("no console errors and no WebGL context loss across all states", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  const states = [
    "LISTENING",
    "THINKING",
    "SEARCHING",
    "PROCESSING",
    "TOOL EXECUTION",
    "VISUALIZING",
    "SPEAKING",
    "WARNING",
    "ERROR",
    "IDLE",
  ];
  for (const s of states) {
    await page.click(`#state-rail button:has-text("${s}")`);
    await page.waitForTimeout(250);
  }

  const gl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const ctx = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    return { present: !!ctx, lost: ctx ? ctx.isContextLost() : true, error: ctx ? ctx.getError() : -1 };
  });

  expect(gl.present, "WebGL context missing").toBe(true);
  expect(gl.lost, "WebGL context was lost").toBe(false);
  expect(gl.error, "WebGL reported an error").toBe(0);

  // HMR websocket noise only exists in dev; the suite runs a production build
  const real = errors.filter((e) => !/favicon|WebSocket/i.test(e));
  expect(real, `console errors: ${real.join(" | ")}`).toHaveLength(0);
});

test("every viz type mounts and unmounts cleanly", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const buttons = page.locator("#viz-rail button");
  const n = await buttons.count();
  expect(n).toBe(10);

  for (let i = 0; i < n; i++) {
    await buttons.nth(i).click();
    await page.waitForTimeout(200);
  }
  // back to idle tears the last visualization down
  await page.click(`#state-rail button:has-text("IDLE")`);
  await page.waitForTimeout(400);

  const lost = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const ctx = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    return ctx ? ctx.isContextLost() : true;
  });
  expect(lost).toBe(false);
  expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
});

// ---------- §20 the render loop is alive ----------

test("render loop runs at interactive fps", async ({ page }) => {
  const renderer = await glRenderer(page);

  const frames = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let n = 0;
        const start = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - start >= 2000) resolve(n);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  const fps = frames / 2;
  console.log(`[perf] renderer=${renderer} fps=${fps.toFixed(1)} frames=${frames}`);

  if (isSoftwareGL(renderer)) {
    // Software GL (headless CI) cannot show real GPU performance —
    // assert only that the loop keeps producing frames.
    console.warn(`[perf] software renderer (${renderer}); asserting liveness only`);
    expect(frames, "render loop stalled").toBeGreaterThanOrEqual(3);
  } else {
    expect(fps).toBeGreaterThan(24);
  }
});
