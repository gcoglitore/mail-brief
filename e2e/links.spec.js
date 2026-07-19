const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 900, height: 800 } });

test("URLs in an email body become clickable links", async ({ page }) => {
  await signIn(page);
  await page.locator("#priorityView .card", { hasText: "Sign term sheet" }).first().locator(".cPrimary").click();
  await expect(page.locator("#reader")).toBeVisible();
  const link = page.locator("#readerBody a.inlineLink");
  await expect(link).toHaveText("https://example.com/termsheet");
  await expect(link).toHaveAttribute("href", "https://example.com/termsheet");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("URLs in a text/DM message become clickable (www gets https)", async ({ page }) => {
  await signIn(page);
  await page.locator("#tabMsg").click();
  await page.locator("#msgView .chat", { hasText: "Sarah" }).first().click();
  await expect(page.locator("#thread")).toHaveClass(/open/);
  const link = page.locator("#threadBody a.inlineLink");
  await expect(link).toHaveText("www.example.com/spot");
  await expect(link).toHaveAttribute("href", "https://www.example.com/spot");
});
