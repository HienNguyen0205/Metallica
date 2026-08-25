import { test, expect } from "@playwright/test";
import { AA_SMALL, gotoScene, readFlow, recordFlow, textContrast } from "./helpers";

/**
 * Composition, HUD legibility and the response flow.
 * Encodes the acceptance criteria from the FRIDAY redesign spec:
 * spatial composition (no dashboard), telemetry typography, reactive AI
 * states, and visualization-before-text response ordering.
 */

test.beforeEach(async ({ page }) => {
  await gotoScene(page);
});

// ---------- §11 full-viewport spatial composition ----------

test("canvas fills the entire viewport", async ({ page }) => {
  const box = await page.locator("canvas").boundingBox();
  const vp = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(vp.width - 2);
  expect(box!.height).toBeGreaterThanOrEqual(vp.height - 2);
});

test("page never scrolls — the scene owns the viewport", async ({ page }) => {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(1);
  expect(overflow.y).toBeLessThanOrEqual(1);
});

// ---------- §1 no dashboard feel ----------

test("no dashboard chrome: no nav/sidebar/cards", async ({ page }) => {
  const counts = await page.evaluate(() => ({
    nav: document.querySelectorAll("nav, aside, [class*='sidebar']").length,
    cards: document.querySelectorAll("[class*='rounded-xl'], [class*='card'], table").length,
  }));
  expect(counts.nav).toBe(0);
  expect(counts.cards).toBe(0);
});

// ---------- §5 legible telemetry typography ----------

test("all HUD text meets WCAG AA against the dark background", async ({ page }) => {
  const checks: Array<[string, string | { selector: string; text: string }]> = [
    ["brand", { selector: "span", text: "METALLICA" }],
    ["subtitle", { selector: "span", text: "HOLOGRAPHIC INTERFACE" }],
    ["state label", "[data-testid='hud-state']"],
    ["edge telemetry", { selector: "span", text: "UPLINK · STABLE" }],
    ["edge right", { selector: "span", text: "CORE · SYNCED" }],
    ["audio toggle", { selector: "button", text: "AUDIO ·" }],
    ["state rail (inactive)", "#state-rail button:nth-child(4)"],
    ["viz rail (inactive)", "#viz-rail button:nth-child(4)"],
    ["input", "input"],
  ];

  for (const [name, locator] of checks) {
    const ratio = await textContrast(page, locator);
    console.log(`[contrast] ${name}: ${ratio.toFixed(2)}:1 (min ${AA_SMALL})`);
    expect(ratio, `${name} contrast`).toBeGreaterThanOrEqual(AA_SMALL);
  }
});

// ---------- §7 every AI state is reachable and reflected in the HUD ----------

test("all ten states update the HUD label", async ({ page }) => {
  for (const state of [
    "listening",
    "thinking",
    "searching",
    "processing",
    "tool execution",
    "visualizing",
    "speaking",
    "warning",
    "error",
    "idle",
  ]) {
    await page.click(`#state-rail button:has-text("${state.toUpperCase()}")`);
    const pattern = new RegExp(state.toUpperCase().replace(" ", "\\s+"));
    await expect(page.getByTestId("hud-state")).toHaveText(pattern, { timeout: 3000 });
  }
});

// ---------- §9/§10 response ordering: hologram first, text second ----------

test("query flow walks the state machine and shows the hologram before the text", async ({
  page,
}) => {
  // Recorded inside the page: polling over CDP is too slow to catch an 800ms
  // state on a software-GL runner, and would make this test flaky by design.
  await recordFlow(page);

  await page.fill("input[placeholder='ASK FRIDAY']", "system health");
  await page.keyboard.press("Enter");

  const hud = page.getByTestId("hud-state");
  // leave idle first — otherwise "back to idle" matches before the flow starts
  await expect(hud).not.toHaveText("IDLE", { timeout: 10_000 });
  await expect(hud).toHaveText("IDLE", { timeout: 20_000 });

  const log = await readFlow(page);
  const states = log.map((e) => e.state);
  console.log(`[flow] ${states.join(" → ")}`);

  // §17 the pipeline passes through analysis, visualization, then speech
  const order = ["THINKING", "SEARCHING", "TOOL EXECUTION", "VISUALIZING", "SPEAKING"];
  let cursor = -1;
  for (const required of order) {
    const at = states.indexOf(required, cursor + 1);
    expect(at, `${required} missing or out of order in ${states.join(" → ")}`).toBeGreaterThan(
      cursor,
    );
    cursor = at;
  }

  // §9/§10 the answer text must not appear before the visualization exists
  const firstAnswer = log.findIndex((e) => e.answer.length > 0);
  const firstViz = states.indexOf("VISUALIZING");
  expect(firstAnswer, "no answer was ever shown").toBeGreaterThan(-1);
  expect(firstAnswer, "answer appeared before the hologram").toBeGreaterThan(firstViz);
  console.log(`[flow] answer: "${log[firstAnswer].answer}"`);
});

// ---------- §19 responsive ----------

for (const [label, width, height] of [
  ["1366x768", 1366, 768],
  ["1920x1080", 1920, 1080],
  ["2560x1440", 2560, 1440],
] as const) {
  test(`desktop ${label}: canvas fills viewport, no overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(800);
    const box = await page.locator("canvas").boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(width - 2);
    expect(box!.height).toBeGreaterThanOrEqual(height - 2);
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowX).toBeLessThanOrEqual(1);
  });
}

test("mobile falls back to a simplified scene", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await page.waitForSelector("canvas");
  await page.waitForTimeout(2000);

  // the core still renders
  const box = await page.locator("canvas").boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(373);

  // §19 dense desktop-only HUD is hidden rather than crammed in
  await expect(page.locator("#state-rail")).toBeHidden();
  await expect(page.locator("#viz-rail")).toBeHidden();
  await expect(page.getByText("UPLINK · STABLE")).toBeHidden();

  // the essentials stay
  await expect(page.getByTestId("hud-state")).toBeVisible();
  await expect(page.locator("input")).toBeVisible();

  const overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowX).toBeLessThanOrEqual(1);
});

// ---------- accessibility basics ----------

test("interactive controls are labelled and reachable", async ({ page }) => {
  await expect(page.getByLabel("Toggle microphone")).toBeVisible();
  const input = page.locator("input[placeholder='ASK FRIDAY']");
  await input.focus();
  await expect(input).toBeFocused();
});
