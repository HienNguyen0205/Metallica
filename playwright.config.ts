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
        command: "npm run build && npm run start",
        url: "http://localhost:3000",
        timeout: 420_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
      },
});
