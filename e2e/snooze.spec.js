const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 900, height: 800 } });

test("snooze moves an item out of Priority, then Restore brings it back", async ({ page }) => {
  await signIn(page);
  const card = page.locator("#priorityView .card", { hasText: "Sign term sheet" }).first();
  await card.hover();
  await card.getByRole("button", { name: "More actions" }).click();

  const menu = page.locator("#snoozeMenu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "1 hour" }).click();
  await expect(page.locator("#toast")).toContainText("Snoozed");
  await expect(page.locator("#priorityView .card", { hasText: "Sign term sheet" })).toHaveCount(0);

  await page.getByRole("button", { name: /Snoozed/ }).click();
  await expect(page.locator("#priorityView")).toContainText("Sign term sheet");
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.locator("#toast")).toContainText("Restored");
});
