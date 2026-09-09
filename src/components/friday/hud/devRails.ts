"use client";

/**
 * Whether the two dev rails render at all.
 *
 * They call `setState`, which is the *unguarded* escape hatch — it bypasses the
 * transition table entirely. That is the right tool for driving the machine
 * while building, and the wrong thing to hand a visitor, so it ships off.
 *
 * On during `next dev` without any setup; the Playwright suite builds for
 * production and turns it back on through `playwright.config.ts`, because the
 * rails are how the tests drive states and visualizations.
 */
export function devRailsEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEV_RAILS === "1";
}
