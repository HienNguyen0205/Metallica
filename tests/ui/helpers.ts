import { expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";

/** Scene background — #02050a, matches --background in globals.css. */
export const BG = { r: 2, g: 5, b: 10 };

/** WCAG AA for text below 18.66px bold / 24px regular. All HUD text is small. */
export const AA_SMALL = 4.5;

// ---------- pixel helpers ----------

export async function shot(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.screenshot());
}

export function regionStats(img: PNG, x0: number, y0: number, x1: number, y1: number) {
  let luma = 0;
  let cyan = 0;
  let n = 0;
  for (let y = Math.floor(y0); y < Math.floor(y1); y++) {
    for (let x = Math.floor(x0); x < Math.floor(x1); x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // hologram cyan: green+blue dominant over red
      if (g > 90 && b > 90 && b > r * 1.35 && g > r * 1.35) cyan++;
      n++;
    }
  }
  return { meanLuma: luma / n, cyanRatio: cyan / n };
}

/** Fraction of pixels that differ perceptibly between two frames. */
export function diffRatio(a: PNG, b: PNG): number {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let changed = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n * 4; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > 8 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 8 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 8
    ) {
      changed++;
    }
  }
  return changed / n;
}

// ---------- contrast ----------

/**
 * True WCAG contrast of an element's text against the scene background.
 *
 * Tailwind v4 emits `oklab()` / `lab()` colours, so the computed `color`
 * string cannot be regex-parsed as rgb — doing that yields nonsense ratios.
 * Instead the browser itself resolves the colour: we paint it over the known
 * background on a 1x1 canvas and read back the composited sRGB pixel.
 */
export async function textContrast(
  page: Page,
  locator: string | { selector: string; text: string },
): Promise<number> {
  return page.evaluate(
    ({ locator, bg }) => {
      const el =
        typeof locator === "string"
          ? document.querySelector<HTMLElement>(locator)
          : Array.from(document.querySelectorAll<HTMLElement>(locator.selector)).find((n) =>
              n.textContent?.includes(locator.text),
            );
      if (!el) throw new Error(`element not found: ${JSON.stringify(locator)}`);

      // accumulated ancestor opacity, on top of any alpha in the colour itself
      let alpha = 1;
      let node: HTMLElement | null = el;
      while (node) {
        alpha *= parseFloat(getComputedStyle(node).opacity || "1");
        node = node.parentElement;
      }

      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = `rgb(${bg.r},${bg.g},${bg.b})`;
      ctx.fillRect(0, 0, 1, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = getComputedStyle(el).color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;

      const relLum = (cr: number, cg: number, cb: number) => {
        const f = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(cr) + 0.7152 * f(cg) + 0.0722 * f(cb);
      };

      const fg = relLum(r, g, b);
      const bgl = relLum(bg.r, bg.g, bg.b);
      return (Math.max(fg, bgl) + 0.05) / (Math.min(fg, bgl) + 0.05);
    },
    { locator, bg: BG },
  );
}

// ---------- app helpers ----------

/** DOM-level readiness. Cheap — use for tests that never read pixels. */
export async function gotoScene(page: Page) {
  // relative: the port lives in playwright.config.ts (baseURL)
  await page.goto("/");
  await page.waitForSelector("canvas");
  await page.waitForTimeout(1200);
}

/**
 * Waits until the core has actually painted, rather than for a fixed delay.
 * First paint is sub-second on a warm production build but many seconds on a
 * dev server under software GL, so any constant here is flaky or wasteful.
 * Only pixel tests should pay this cost.
 */
export async function waitForHologram(page: Page, timeoutMs = 25_000) {
  const vp = page.viewportSize()!;
  const clip = {
    x: Math.round(vp.width * 0.42),
    y: Math.round(vp.height * 0.38),
    width: Math.round(vp.width * 0.16),
    height: Math.round(vp.height * 0.24),
  };

  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    try {
      const img = PNG.sync.read(await page.screenshot({ clip }));
      last = regionStats(img, 0, 0, img.width, img.height).meanLuma;
      if (last > 20) return last;
    } catch {
      // the compositor can transiently refuse a capture under load; retry
    }
    await page.waitForTimeout(600);
  }
  throw new Error(`hologram never lit up (centre luma ${last.toFixed(1)} after ${timeoutMs}ms)`);
}

/** Full readiness: DOM up and the core actually emitting light. */
export async function gotoLitScene(page: Page) {
  await gotoScene(page);
  await waitForHologram(page);
  // let ring/particle motion and materialize animations settle
  await page.waitForTimeout(500);
}

export interface FlowEntry {
  t: number;
  state: string;
  answer: string;
}

declare global {
  interface Window {
    __flow?: FlowEntry[];
  }
}

/**
 * Installs an in-page MutationObserver that timestamps every change to the
 * state label and the answer line. Recording inside the page (rather than
 * polling over CDP) is the only way to reliably catch sub-second states when
 * the renderer is slow.
 */
export async function recordFlow(page: Page) {
  await page.evaluate(() => {
    const stateEl = document.querySelector("[data-testid='hud-state']");
    if (!stateEl) throw new Error("state label not found");
    window.__flow = [];

    const record = () => {
      const state = (stateEl.textContent ?? "").trim();
      const answer = (document.querySelector("p.answer-rise")?.textContent ?? "").trim();
      const last = window.__flow![window.__flow!.length - 1];
      if (!last || last.state !== state || !!last.answer !== !!answer) {
        window.__flow!.push({ t: performance.now(), state, answer });
      }
    };

    record();
    new MutationObserver(record).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

export async function readFlow(page: Page): Promise<FlowEntry[]> {
  return page.evaluate(() => window.__flow ?? []);
}

/** Reports the WebGL renderer string so tests can tell GPU from software GL. */
export async function glRenderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    if (!gl) return "none";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });
}

export function isSoftwareGL(renderer: string) {
  return /swiftshader|software|llvmpipe|angle \(google, vulkan/i.test(renderer);
}
