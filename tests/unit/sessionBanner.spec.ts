import { test, expect } from "@playwright/test";

function needsMisconfigBanner(pageHost: string, api: string): boolean {
  const pageIsLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(pageHost);
  const apiIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(api);
  return !pageIsLocal && apiIsLocal;
}

test("flags localhost API on public page", () => {
  expect(needsMisconfigBanner("metallica.vercel.app", "http://localhost:8000")).toBe(true);
});

test("quiet on local dev", () => {
  expect(needsMisconfigBanner("localhost", "http://localhost:8000")).toBe(false);
});

test("quiet when API is deployed", () => {
  expect(needsMisconfigBanner("metallica.vercel.app", "https://friday.onrender.com")).toBe(false);
});
