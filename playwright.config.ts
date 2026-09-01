import { defineConfig, devices } from "@playwright/test";

/**
 * Unit specs are pure logic and need no server — skip the production build
 * when the run only selects them. Parsed from argv so it works identically on
 * Windows and Linux (env-var prefixes in npm scripts do not).
 */
const selectedProjects = process.argv.flatMap((arg, i, argv) =>
  arg.startsWith("--project=")
    ? [arg.slice("--project=".length)]
    : arg === "--project"
      ? [argv[i + 1] ?? ""]
      : [],
);
const unitOnly = selectedProjects.length > 0 && selectedProjects.every((p) => p === "unit");

export default defineConfig({
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // pixel and timing assertions deserve a retry on shared CI hardware
  retries: process.env.CI ? 2 : 0,
  /**
   * One worker, and it is not a leftover conservative default — raising it is
   * measurably worse. Every test mounts a full WebGL scene, and on a machine
   * without a GPU adapter three.js runs on SwiftShader, which rasterises on the
   * CPU. Parallel scenes therefore do not divide the work, they contend for the
   * same cores.
   *
   * Measured on this suite, 8 cores: `workers: 1` → 19.0-19.6 min, all green.
   * `--workers=4` → 20.8 min and five failures, with hologram.spec going
   * 7.4 → 16.2 min and memoryRail 1.1 → 8.4 min.
   *
   * Note also that Playwright parallelises across *files*, never within one, so
   * `--workers=N` on a single spec changes nothing at all.
   *
   * Wall time on CI is cut by sharding across runners instead — see ci.yml.
   */
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["list"], ["html", { open: "never" }]],

  projects: [
    {
      name: "unit",
      testDir: "./tests/unit",
    },
    {
      name: "ui",
      testDir: "./tests/ui",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://localhost:3100",
        viewport: { width: 1440, height: 900 },
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "off",
      },
    },
  ],

  webServer: unitOnly
    ? undefined
    : {
        // Port 3100, not 3000: `reuseExistingServer` will happily adopt a
        // `next dev` server left running on the default port, and then the
        // suite silently runs against a dev build — slower, and StrictMode's
        // double-mounting exhausts WebGL contexts until unrelated render tests
        // start failing. Its own port makes that impossible.
        command: "npm run build && npx next start -p 3100",
        url: "http://localhost:3100",
        // The orchestrator URL is baked in at build time, so the stub in
        // tests/ui/stubOrchestrator.ts has to bind whatever this names. Point
        // it at a dedicated port: on :8000 the suite collides with a real
        // backend a developer has running, and the frontend then silently
        // takes its offline fallback instead of failing loudly.
        env: {
          NEXT_PUBLIC_FRIDAY_API: "http://127.0.0.1:8123",
          // The suite builds for production, where the dev rails ship off — but
          // they are how these tests drive states and visualizations, so turn
          // them back on for the run.
          NEXT_PUBLIC_DEV_RAILS: "1",
        },
        timeout: 420_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
      },
});
