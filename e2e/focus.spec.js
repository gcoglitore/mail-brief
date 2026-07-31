const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 900, height: 800 } });

test("Preferences moves focus in and restores it to the trigger on Escape", async ({ page }) => {
  await signIn(page);
  await page.locator("#prefsBtn").focus();
  await page.locator("#prefsBtn").click();
  await expect(page.locator("#settingsSheet")).toBeVisible();
  expect(await page.evaluate(() => document.getElementById("settingsSheet").contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#settingsWrap")).toBeHidden();
  expect(await page.evaluate(() => document.activeElement === document.getElementById("prefsBtn"))).toBe(true);
});

test("row overflow menu restores focus to the More button on Escape", async ({ page }) => {
  await signIn(page);
  const card = page.locator("#priorityView .card", { hasText: "Sign term sheet" }).first();
  await card.hover();
  await card.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator("#snoozeMenu")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#snoozeMenu")).toBeHidden();
  expect(
    await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-label") === "More actions")
  ).toBe(true);
});

test("email and conversation rows open from the keyboard", async ({ page }) => {
  await signIn(page);

  const email = page.getByRole("button", {
    name: "Open Term sheet — sign by Friday? from Dana Investor",
  });
  await email.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#reader")).toBeVisible();
  await page.locator("#readerBack").click();

  const chat = page.getByRole("button", { name: "Open conversation with Sarah" });
  await chat.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#thread")).toHaveClass(/open/);
});

test("preference switches have accessible names and state", async ({ page }) => {
  await signIn(page);
  await page.locator("#prefsBtn").click();
  const texts = page.getByRole("switch", { name: "Include Texts (iMessage / SMS)" });
  await expect(texts).toHaveAttribute("aria-checked", "true");
  await texts.click();
  await expect(page.getByRole("switch", { name: "Include Texts (iMessage / SMS)" }))
    .toHaveAttribute("aria-checked", "false");
});
