const { test, expect } = require("@playwright/test");
const { mockBackend, signIn } = require("./fixtures");

test.use({ viewport: { width: 1280, height: 800 } });

test("locked screen shows when there is no key", async ({ page }) => {
  await mockBackend(page, { brief: null, msgs: null, settings: null, flags: {} });
  await page.goto("/");
  await expect(page.locator("#keyScreen")).toBeVisible();
  await expect(page.locator("#app")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/signed-in/);
});

test("signed-in desktop shows the two-pane layout", async ({ page }) => {
  await signIn(page);
  await expect(page.locator("#keyScreen")).toBeHidden();
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#deskPane")).toBeVisible(); // right pane only appears >=980px
  await expect(page.locator("#viewTabs .vtIco").first()).toBeHidden(); // tabs are text pills on desktop
});
