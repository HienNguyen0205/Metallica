import { test, expect } from "@playwright/test";
import { gotoScene } from "./helpers";
import { TOOL_FLOW, startStubOrchestrator } from "./stubOrchestrator";

/**
 * §8 of the memory design — "xem lại và xoá", the one mitigation standing
 * behind the decision to let the model write facts unprompted. §9 states the
 * residual risk it covers: a poisoned sentence only has to land once and it is
 * permanent until the operator sees it and deletes it. These check that seeing
 * and deleting are actually reachable from the interface.
 *
 * The rail fetches on open, so every test here needs the stub already bound
 * before the page loads.
 */

test("reviewing lists what FRIDAY has stored, marking web-sourced facts", async ({ page }) => {
  const stub = await startStubOrchestrator(TOOL_FLOW);
  try {
    await gotoScene(page);
    await page.getByRole("button", { name: /MEMORY ·/ }).click();

    const group = page.getByRole("group", { name: "Stored memories" });
    await expect(group).toContainText("DEPLOYS ARE SAFE ON TUESDAYS", { timeout: 10_000 });
    await expect(group).toContainText("THE OFFICE CLOSES AT 9PM");

    // Provenance is the whole point: a fact the model copied off a web page is
    // the one an attacker could have written, and it has to look different.
    const webRow = group.locator("div", { hasText: "THE OFFICE CLOSES" }).first();
    await expect(webRow).toContainText("FROM WEB");
    const userRow = group.locator("div", { hasText: "DEPLOYS ARE SAFE" }).first();
    await expect(userRow).not.toContainText("FROM WEB");
  } finally {
    await stub.close();
  }
});

test("forgetting a fact reaches the store, not just the screen", async ({ page }) => {
  const stub = await startStubOrchestrator(TOOL_FLOW);
  try {
    await gotoScene(page);
    await page.getByRole("button", { name: /MEMORY ·/ }).click();

    const group = page.getByRole("group", { name: "Stored memories" });
    await expect(group).toContainText("THE OFFICE CLOSES", { timeout: 10_000 });

    await page.getByRole("button", { name: /^Forget: the office closes/i }).click();

    await expect(group).not.toContainText("THE OFFICE CLOSES");
    // The row leaving the screen proves nothing on its own — the bug this
    // guards is a delete that only updates local state.
    expect(stub.forgotten, "DELETE /memory/{id} was never called").toEqual([2]);
    expect(stub.memories.map((m) => m.id), "the row is still in the store").toEqual([1]);
  } finally {
    await stub.close();
  }
});

test("an unreachable store says so instead of looking empty", async ({ page }) => {
  // No stub bound at all: the fetch fails outright.
  await gotoScene(page);
  await page.getByRole("button", { name: /MEMORY ·/ }).click();

  const group = page.getByRole("group", { name: "Stored memories" });
  // "FRIDAY remembers nothing" and "the store could not be read" are opposite
  // facts, and the second one silently rendering as the first would tell the
  // operator their memory store is clean when it may be full.
  await expect(group).toContainText("UNREACHABLE", { timeout: 15_000 });
  await expect(group).not.toContainText("NOTHING REMEMBERED");
});
