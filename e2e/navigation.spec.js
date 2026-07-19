const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 375, height: 812 } });

test("mobile bottom nav shows icons and switches views", async ({ page }) => {
  await signIn(page);
  const tabs = page.locator("#viewTabs");
  await expect(tabs).toBeVisible();
  expect(await tabs.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  await expect(page.locator("#tabPriority .vtIco")).toBeVisible(); // icons appear on mobile

  await page.locator("#tabMsg").click();
  await expect(page.locator("#msgView")).toBeVisible();
  await expect(page.locator("#priorityView")).toBeHidden();
  await expect(page.locator("#tabMsg")).toHaveAttribute("aria-selected", "true");
});

test("arrow keys move between tabs (roving tabindex)", async ({ page }) => {
  await signIn(page);
  await page.locator("#tabPriority").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#tabMail")).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => document.activeElement.id)).toBe("tabMail");
  await expect(page.locator("#mailView")).toBeVisible();
});
