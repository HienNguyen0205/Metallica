import { test, expect } from "@playwright/test";
import { AA_SMALL, gotoScene, readFlow, recordFlow, textContrast } from "./helpers";
import {
  CONFIRM_FLOW,
  STREAMING_FLOW,
  TOOL_FLOW,
  startStubOrchestrator,
  type StubHandle,
} from "./stubOrchestrator";

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

/**
 * `boundingBox()` is a one-shot read, unlike every `expect(locator)` in this
 * file. Called before R3F has laid the canvas out it returns null — a race
 * against mount, not a layout bug — so poll it instead of sampling once.
 */
async function canvasBox(page: import("@playwright/test").Page) {
  return (await page.locator("canvas").boundingBox()) ?? { width: 0, height: 0 };
}

test("canvas fills the entire viewport", async ({ page }) => {
  const vp = page.viewportSize()!;
  await expect.poll(async () => (await canvasBox(page)).width).toBeGreaterThanOrEqual(vp.width - 2);
  await expect
    .poll(async () => (await canvasBox(page)).height)
    .toBeGreaterThanOrEqual(vp.height - 2);
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
    // live values, so match the stable label prefix only
    ["edge telemetry", { selector: "span", text: "UPLINK" }],
    ["edge right", { selector: "span", text: "SECURITY" }],
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
  // Against a stub orchestrator, so this exercises the real SSE path in
  // agentStream.ts rather than its offline fallback.
  const stub = await startStubOrchestrator(TOOL_FLOW);
  try {
    await page.reload();
    await page.waitForSelector("canvas");

    // Recorded inside the page: polling over CDP is too slow to catch a
    // sub-second state on a software-GL runner, and would be flaky by design.
    await recordFlow(page);

    await page.locator("input").click();
    // pressSequentially, not fill(): fill() sets the value without the keystroke
    // events React's controlled input needs, so submit() reads an empty string
    // and silently does nothing.
    await page.locator("input").pressSequentially("system health", { delay: 15 });
    await page.keyboard.press("Enter");

    const hud = page.getByTestId("hud-state");
    // leave idle first — otherwise "back to idle" matches before the flow starts
    await expect(hud).not.toHaveText("IDLE", { timeout: 15_000 });
    await expect(hud).toHaveText("IDLE", { timeout: 25_000 });

    const log = await readFlow(page);
    const states = log.map((e) => e.state);
    console.log(`[flow] ${states.join(" → ")}`);

    // §17/§9 — the orchestrator's own sequence: plan, run a tool, digest the
    // result, materialize the hologram, then speak.
    const order = ["THINKING", "TOOL EXECUTION", "PROCESSING", "VISUALIZING", "SPEAKING"];
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

    // Pin the answer to the stub's wording. Without this the test passes just
    // as happily against the offline fallback, so a stub that failed to bind
    // would quietly downgrade what is being tested instead of failing.
    expect(log[firstAnswer].answer, "answer did not come from the orchestrator").toContain(
      "73 percent",
    );
    console.log(`[flow] answer: "${log[firstAnswer].answer}"`);
  } finally {
    await stub.close();
  }
});

test("the offline fallback still answers when the orchestrator is down", async ({ page }) => {
  // Nothing is listening on :8000 here — the point is that a missing backend
  // degrades to the local rules planner instead of hanging in THINKING.
  await recordFlow(page);

  await page.locator("input").click();
  await page.locator("input").pressSequentially("system health", { delay: 15 });
  await page.keyboard.press("Enter");

  const hud = page.getByTestId("hud-state");
  await expect(hud).not.toHaveText("IDLE", { timeout: 15_000 });
  await expect(hud).toHaveText("IDLE", { timeout: 30_000 });

  const log = await readFlow(page);
  expect(
    log.findIndex((e) => e.answer.length > 0),
    "fallback produced no answer",
  ).toBeGreaterThan(-1);
});

test("§18 the hologram builds up as tool results arrive", async ({ page }) => {
  const stub = await startStubOrchestrator(STREAMING_FLOW);
  try {
    await page.reload();
    await page.waitForSelector("canvas");
    // Recorded in-page: the flow moves faster than any external poll can
    // sample, so asserting on a transient state with toHaveText only races.
    await recordFlow(page);

    await page.locator("input").click();
    await page.locator("input").pressSequentially("check the system", { delay: 15 });
    await page.keyboard.press("Enter");

    const hud = page.getByTestId("hud-state");
    await expect(hud).not.toHaveText("IDLE", { timeout: 15_000 });
    await expect(hud).toHaveText("IDLE", { timeout: 30_000 });

    const states = (await readFlow(page)).map((e) => e.state);
    console.log(`[§18] ${states.join(" → ")}`);

    // The bug this guards: a preview that announced VISUALIZING stranded the
    // HUD there for the rest of the turn, because the store has no
    // visualizing -> tool_execution edge and drops illegal moves silently.
    //
    // The tell is ordering against PROCESSING, not against TOOL EXECUTION.
    // Once the HUD is stranded, TOOL EXECUTION simply never reappears, so any
    // "last tool before first viz" check passes in both the healthy and the
    // broken case. PROCESSING is only emitted after every tool has returned,
    // so a VISUALIZING ahead of it means a preview announced itself as one.
    expect(states, "HUD never reached TOOL EXECUTION").toContain("TOOL EXECUTION");
    const firstViz = states.indexOf("VISUALIZING");
    const firstProcessing = states.indexOf("PROCESSING");
    expect(firstViz, "never reached VISUALIZING").toBeGreaterThan(-1);
    expect(firstProcessing, "never reached PROCESSING").toBeGreaterThan(-1);
    expect(
      firstProcessing,
      "VISUALIZING appeared while tools were still running — a preview announced it",
    ).toBeLessThan(firstViz);

    // and the turn still completes rather than hanging mid-sequence
    expect(states.at(-1)).toBe("IDLE");
    expect(
      (await readFlow(page)).findIndex((e) => e.answer.length > 0),
      "no answer after the streamed sequence",
    ).toBeGreaterThan(-1);
  } finally {
    await stub.close();
  }
});

// ---------- §11 operator approval ----------

test.describe("high-risk tool approval", () => {
  let stub: StubHandle;

  test.beforeEach(async ({ page }) => {
    stub = await startStubOrchestrator(CONFIRM_FLOW);
    await page.reload();
    await page.waitForSelector("canvas");
  });

  test.afterEach(async () => {
    await stub.close();
  });

  const ask = async (page: import("@playwright/test").Page) => {
    await page.locator("input").click();
    await page.locator("input").pressSequentially("write a note", { delay: 15 });
    await page.keyboard.press("Enter");
  };

  test("names the tool and its arguments before anything runs", async ({ page }) => {
    await ask(page);

    const prompt = page.getByTestId("confirm-prompt");
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    // approving something described only as "a tool" is not consent
    await expect(page.getByTestId("confirm-tool")).toHaveText("write_note");
    await expect(prompt).toContainText("HIGH RISK");
    await expect(prompt).toContainText("log");

    // nothing was decided just by showing the prompt
    expect(stub.decisions).toHaveLength(0);
  });

  test("denying reports a refusal and does not run the tool", async ({ page }) => {
    await ask(page);
    await expect(page.getByTestId("confirm-prompt")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("confirm-deny").click();

    await expect(page.getByTestId("confirm-prompt")).toBeHidden();
    await expect.poll(() => stub.decisions).toHaveLength(1);
    expect(stub.decisions[0].approved).toBe(false);
  });

  test("approving releases the blocked call", async ({ page }) => {
    await ask(page);
    await expect(page.getByTestId("confirm-prompt")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("confirm-approve").click();

    await expect(page.getByTestId("confirm-prompt")).toBeHidden();
    await expect.poll(() => stub.decisions).toHaveLength(1);
    expect(stub.decisions[0].approved).toBe(true);
    await expect(page.locator("p.answer-rise")).toContainText("Note written", { timeout: 15_000 });
  });
});

// ---------- §19 responsive ----------

for (const [label, width, height] of [
  ["1366x768", 1366, 768],
  ["1920x1080", 1920, 1080],
  ["2560x1440", 2560, 1440],
] as const) {
  test(`desktop ${label}: canvas fills viewport, no overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await expect.poll(async () => (await canvasBox(page)).width).toBeGreaterThanOrEqual(width - 2);
    await expect.poll(async () => (await canvasBox(page)).height).toBeGreaterThanOrEqual(height - 2);
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
  await expect(page.getByText(/^UPLINK/)).toBeHidden();

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

// ---------- §12/§13 voice ----------

/**
 * Stands in for Chrome's `SpeechRecognition`, which Playwright cannot drive:
 * there is no way to feed real audio to the recogniser, and the browser under
 * test has no engine behind it. The stub exposes `__mic` so a test can fire the
 * transcript the real engine would have produced.
 *
 * Deliberately faithful about the details that broke the wiring in practice:
 * `onend` fires after `onresult`, and `abort()` fires `onend` without a result.
 */
async function stubMicrophone(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;

      start() {
        (window as unknown as { __mic?: unknown }).__mic = this;
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onerror?.({ error: "aborted" });
        this.onend?.();
      }
      say(transcript: string) {
        this.onresult?.({
          resultIndex: 0,
          results: { length: 1, 0: { 0: { transcript }, isFinal: true } },
        });
        this.onend?.();
      }
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
    // nothing here should ever actually talk during a test run
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
      speak: (u: { onend?: () => void }) => u.onend?.(),
      cancel: () => {},
    };
  });
}

test.describe("voice input", () => {
  let stub: StubHandle;

  test.beforeAll(async () => {
    stub = await startStubOrchestrator(TOOL_FLOW);
  });
  test.afterAll(async () => {
    await stub.close();
  });

  test.beforeEach(async ({ page }) => {
    await stubMicrophone(page);
    await gotoScene(page);
  });

  test("the microphone button opens a real recogniser and its transcript starts a turn", async ({
    page,
  }) => {
    const mic = page.getByRole("button", { name: "Toggle microphone" });
    await mic.click();

    // the HUD must reflect that it is listening, and a recogniser must exist —
    // the button used to do only the former, which is what made it a prop
    await expect(page.getByTestId("hud-state")).toHaveText("LISTENING");
    expect(await page.evaluate(() => !!(window as unknown as { __mic?: unknown }).__mic)).toBe(true);

    await page.evaluate(() =>
      (window as unknown as { __mic: { say: (t: string) => void } }).__mic.say("check the system"),
    );

    // a spoken phrase has to reach the orchestrator like a typed one
    await expect.poll(() => stub.queries, { timeout: 15_000 }).toContain("check the system");
    await expect(page.locator("p.answer-rise")).toBeVisible({ timeout: 15_000 });
  });

  test("aborting returns the interface to idle rather than stranding it", async ({ page }) => {
    const mic = page.getByRole("button", { name: "Toggle microphone" });
    await mic.click();
    await expect(page.getByTestId("hud-state")).toHaveText("LISTENING");

    await mic.click();
    await expect(page.getByTestId("hud-state")).toHaveText("IDLE");
  });
});
