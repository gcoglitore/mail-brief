const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 900, height: 800 } });

test("archive then undo restores the item", async ({ page }) => {
  await signIn(page);
  await page.locator("#tabMail").click();
  const card = page.locator("#content .card", { hasText: "Sign term sheet" }).first();
  await card.hover();
  await card.getByRole("button", { name: "Archive" }).click();
  await expect(page.locator("#toast")).toContainText("Archived");
  await expect(page.locator("#content .card", { hasText: "Sign term sheet" })).toHaveCount(0);

  await page.locator("#toast .tUndo").click();
  await expect(page.locator("#content .card", { hasText: "Sign term sheet" })).toHaveCount(1);
});

test("archive commits to the server after the undo window closes", async ({ page }) => {
  await signIn(page);
  const committed = page.waitForRequest(
    (r) => r.url().includes("/api/send") && (r.postDataJSON() || {}).action === "archive",
    { timeout: 9000 }
  );
  await page.locator("#tabMail").click();
  const card = page.locator("#content .card", { hasText: "Sign term sheet" }).first();
  await card.hover();
  await card.getByRole("button", { name: "Archive" }).click();
  await committed; // fires ~6s later, once Undo lapses
  await expect(page.locator("#content .card", { hasText: "Sign term sheet" })).toHaveCount(0);
});
