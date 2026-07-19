const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 900, height: 800 } });

test("a reply written offline queues, then sends when back online", async ({ page }) => {
  const state = await signIn(page, { apiOffline: true });

  const card = page.locator("#priorityView .card", { hasText: "Sign term sheet" }).first();
  await card.hover();
  await card.getByRole("button", { name: "Reply" }).click();
  await expect(page.locator("#composeWrap")).toBeVisible();
  await page.locator("#composeBody").fill("On my way.");
  await page.locator("#composeSend").click();

  // Offline: parked in the outbox, surfaced in the net bar.
  await expect(page.locator("#composeSend")).toContainText("outbox");
  await expect(page.locator("#netBar")).toContainText("outbox");

  // Back online: the queued reply flushes and the net bar confirms it sent.
  state.apiOffline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#netBar")).toContainText("sent");
});
