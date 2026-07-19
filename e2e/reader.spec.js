const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 900, height: 800 } });

test("reader renders attachments, thread context and plain-language reasons", async ({ page }) => {
  await signIn(page);
  const card = page.locator("#priorityView .card", { hasText: "Sign term sheet" }).first();
  await card.locator(".cPrimary").click();
  await expect(page.locator("#reader")).toBeVisible();

  const att = page.locator("#readerAttach .attChip");
  await expect(att).toContainText("term-sheet.pdf");
  await expect(att.locator(".attType")).toContainText("PDF");
  await expect(att.locator(".attSize")).toContainText("MB");

  await expect(page.locator("#readerThread")).toContainText("EARLIER IN THIS THREAD");
  await expect(page.locator("#readerThread")).toContainText("Sending the term sheet over");

  await expect(page.locator("#readerWhy")).toContainText("Document to review or sign");
  await expect(page.locator("#readerWhy")).toContainText("Waiting 3 days");
});

test("non-repliable mail hides Reply and Draft", async ({ page }) => {
  await signIn(page, {
    brief: {
      generated_at: Math.floor(Date.now() / 1000) - 100,
      accounts: [{ account: "QLAD", ok: true, count: 1 }],
      items: [{
        account: "QLAD", from_name: "Newsletter", from_email: "news@promo.com",
        subject: "Weekly digest", snippet: "stuff", body: "A digest.",
        ts: Math.floor(Date.now() / 1000) - 100, unread: false, bucket: "attention",
        msgid: "n1@x", signals: { reply: false }, // no reply_to => not repliable
      }],
    },
  });
  await page.locator("#priorityView .card").first().locator(".cPrimary").click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#readerReply")).toBeHidden();
  await expect(page.locator("#readerDraft")).toBeHidden();
});
