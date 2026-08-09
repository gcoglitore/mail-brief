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

test("account and notification utilities stay out of the daily feed", async ({ page }) => {
  await signIn(page);
  await expect(page.locator("#lockBtn")).toBeHidden();
  await expect(page.locator("#alertBtn")).toBeHidden();

  await page.locator("#prefsBtn").click();
  await expect(page.getByRole("button", { name: "Sign out on this device" })).toBeVisible();
  await expect(page.getByText("Priority and breaking alerts")).toBeVisible();
});

test("signing out removes private cached data from the device", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("mailbrief_skip_test_key")) return;
    localStorage.setItem("mailbrief_msgs", JSON.stringify({ chats: [{ title: "Private chat" }] }));
    localStorage.setItem("mailbrief_flags", JSON.stringify({ private: { pin: true } }));
    localStorage.setItem("mailbrief_news_cache", JSON.stringify([{ title: "Private news" }]));
    localStorage.setItem("mailbrief_outbox", JSON.stringify([{ body: "Private reply" }]));
    localStorage.setItem("mailbrief_msg_reply_queue", JSON.stringify([{ text: "Private DM" }]));
  });
  await signIn(page);
  await page.evaluate(() => sessionStorage.setItem("mailbrief_skip_test_key", "1"));
  await page.locator("#prefsBtn").click();
  await page.getByRole("button", { name: "Sign out on this device", exact: true }).click();
  await expect(page.locator("#keyScreen")).toBeVisible();

  const remaining = await page.evaluate(() => [
    "mailbrief_key", "mailbrief_cache", "mailbrief_msgs", "mailbrief_flags",
    "mailbrief_news_cache", "mailbrief_outbox", "mailbrief_msg_reply_queue",
  ].filter(k => localStorage.getItem(k) !== null));
  expect(remaining).toEqual([]);
});
