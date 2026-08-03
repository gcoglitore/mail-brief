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

test("signed-in desktop centers the email feed", async ({ page }) => {
  await signIn(page);
  await expect(page.locator("#keyScreen")).toBeHidden();
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#deskPane")).toBeHidden();
  await expect(page.locator("#viewTabs .vtIco").first()).toBeHidden(); // tabs are text pills on desktop

  const feed = await page.locator(".wrap").evaluate(el => {
    const box = el.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width, viewport: window.innerWidth };
  });
  expect(feed.width).toBeGreaterThan(900);
  expect(Math.abs((feed.left + feed.right) / 2 - feed.viewport / 2)).toBeLessThanOrEqual(1);
});

test("desktop centers a wider email preview without changing the phone reader", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByRole("button", { name: /Open Sign term sheet/ }).click();

  const desktop = await page.evaluate(() => {
    const preview = document.querySelector("#readerInner").getBoundingClientRect();
    return { previewLeft: preview.left, previewRight: preview.right, previewWidth: preview.width };
  });
  expect(desktop.previewWidth).toBeGreaterThan(900);
  expect(Math.abs((desktop.previewLeft + desktop.previewRight) / 2 - 720)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await page.evaluate(() => {
    const preview = document.querySelector("#readerInner").getBoundingClientRect();
    const reader = document.querySelector("#reader").getBoundingClientRect();
    return { previewWidth: preview.width, readerLeft: reader.left };
  });
  expect(phone.readerLeft).toBe(0);
  expect(phone.previewWidth).toBeLessThanOrEqual(390);
});
