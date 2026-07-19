const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 900, height: 800 } });

test("Priority shows the calendar agenda with an in-progress marker", async ({ page }) => {
  await signIn(page);
  const agenda = page.locator(".agenda");
  await expect(agenda).toBeVisible();
  await expect(agenda).toContainText("AGENDA");
  await expect(agenda).toContainText("Board call");
  await expect(agenda).toContainText("Zoom");

  // The event whose window straddles "now" is marked live.
  const live = page.locator(".agendaRow.now");
  await expect(live).toHaveCount(1);
  await expect(live).toContainText("Standup");
});

test("no agenda block when the calendar is empty", async ({ page }) => {
  await signIn(page, { brief: Object.assign(require("./fixtures").makeBrief(), { calendar: [] }) });
  await expect(page.locator(".agenda")).toHaveCount(0);
});
