const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

function isReplyWrite(request) {
  return request.method() === "PUT" && request.url().includes("/msg_outbox/web_");
}

test("replies to an iMessage conversation from the Texts view", async ({ page }) => {
  await signIn(page);
  await page.getByRole("tab", { name: /Texts/ }).click();
  await page.getByRole("button", { name: /Open and reply to Sarah via iMessage/ }).click();

  await expect(page.getByText("Reply to Sarah via iMessage", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Reply to Sarah via iMessage", exact: true }).fill("On my way — see you at 6.");
  const write = page.waitForRequest(isReplyWrite);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const request = await write;
  expect(request.postDataJSON()).toMatchObject({ chatID: "c1", text: "On my way — see you at 6." });
  await expect(page.getByText(/Queued for your Mac/).first()).toBeVisible();
});

test("replies to a Signal conversation from the DMs view", async ({ page }) => {
  await signIn(page);
  await page.getByRole("tab", { name: /DMs/ }).click();
  await page.getByRole("button", { name: /Open and reply to Ops channel via Signal/ }).click();

  await expect(page.getByText("Reply to Ops channel via Signal", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Reply to Ops channel via Signal", exact: true }).fill("Great, thanks for confirming.");
  const write = page.waitForRequest(isReplyWrite);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const request = await write;
  expect(request.postDataJSON()).toMatchObject({ chatID: "c2", text: "Great, thanks for confirming." });
  await expect(page.getByText(/Queued for your Mac/).first()).toBeVisible();
});

test("keeps a chat reply locally and queues it after reconnecting", async ({ page }) => {
  const state = await signIn(page, { msgQueueOffline: true });
  await page.getByRole("tab", { name: /Texts/ }).click();
  await page.getByRole("button", { name: /Open and reply to Sarah via iMessage/ }).click();
  await page.getByRole("textbox", { name: "Reply to Sarah via iMessage", exact: true }).fill("Saved while offline");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByText(/Saved on this device/).first()).toBeVisible();
  const queued = page.waitForRequest(isReplyWrite);
  state.msgQueueOffline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await queued;
  await expect(page.getByText(/Queued for your Mac/).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const q = JSON.parse(localStorage.getItem("mailbrief_msg_reply_queue") || "[]");
    return q[0] && q[0].state;
  })).toBe("queued");
});
