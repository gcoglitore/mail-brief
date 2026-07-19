const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 900, height: 800 } });

test("row-density preference persists across a reload", async ({ page }) => {
  await signIn(page);
  await page.locator("#prefsBtn").click();
  const sheet = page.locator("#settingsSheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("aria-modal", "true");

  await sheet.getByRole("button", { name: "Compact" }).click();
  await expect(page.locator("body")).toHaveClass(/compact/);
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("#settingsWrap")).toBeHidden();

  await page.reload();
  await page.waitForSelector("body.signed-in");
  await expect(page.locator("body")).toHaveClass(/compact/); // restored from localStorage
});
