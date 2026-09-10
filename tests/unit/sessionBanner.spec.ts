import { test, expect } from "@playwright/test";
import { needsMisconfigBanner } from "@/lib/api/session";

test("flags localhost API on public page", () => {
  expect(needsMisconfigBanner("metallica.vercel.app", "http://localhost:8000")).toBe(true);
});

test("quiet on local dev", () => {
  expect(needsMisconfigBanner("localhost", "http://localhost:8000")).toBe(false);
});

test("quiet when API is deployed", () => {
  expect(needsMisconfigBanner("metallica.vercel.app", "https://friday.onrender.com")).toBe(false);
});
