const { test, expect } = require("@playwright/test");
const { makeBrief, signIn } = require("./fixtures");

test("morning brief summarizes the day and opens its source items", async ({ page }) => {
  await signIn(page);

  const brief = page.locator(".morningBrief");
  await expect(brief).toBeVisible();
  await expect(brief.getByText(/Good (morning|afternoon|evening), Gio\./)).toBeVisible();
  await expect(brief.getByText("3 replies and 2 events shape today")).toBeVisible();
  await expect(brief.getByText("NEEDS YOUR ATTENTION")).toBeVisible();
  await expect(brief.getByText("TODAY'S CALENDAR")).toBeVisible();
  await expect(brief.getByText("IMPORTANT UNREAD EMAILS")).toBeVisible();
  await expect(brief.getByText("U.S. TOP HEADLINES")).toBeVisible();
  await expect(brief.getByText("WORLD TOP HEADLINES")).toBeVisible();
  await expect(brief.getByText("Board call")).toBeVisible();
  await expect(brief.locator(".mbCalendar")).toBeVisible();
  await expect(brief.locator(".mbCalEvent")).toHaveCount(2);
  await expect(brief.locator(".mbCalCount")).toHaveText("2 events");
  await expect(brief.getByText("Zoom")).toBeVisible();
  await expect(brief.getByRole("link", { name: /Congress advances/ })).toHaveAttribute("href", "https://news.google.com/articles/us-1");

  const sectionOrder = await brief.locator(".mbSectionTitle").allTextContents();
  expect(sectionOrder.slice(0, 2)).toEqual(["U.S. TOP HEADLINES", "WORLD TOP HEADLINES"]);
  expect(sectionOrder.indexOf("TODAY'S CALENDAR")).toBeLessThan(sectionOrder.indexOf("NEEDS YOUR ATTENTION"));

  await brief.getByRole("button", { name: /Open Sign term sheet/ }).click();
  await expect(page.locator("#readerSubject")).toHaveText("Term sheet — sign by Friday?");
  await page.locator("#readerBack").click();

  await brief.getByRole("button", { name: /Open see you at 6 from Sarah/ }).click();
  await expect(page.locator("#thread")).toHaveClass(/open/);
  await expect(page.locator("#threadTitle")).toHaveText("Sarah");
});

test("daily brief keeps the calendar visible on an empty day", async ({ page }) => {
  const briefData = makeBrief();
  briefData.daily_brief.schedule = [];
  briefData.daily_brief.counts.events = 0;
  await signIn(page, { brief: briefData });

  const brief = page.locator(".morningBrief");
  await expect(brief.getByText("TODAY'S CALENDAR")).toBeVisible();
  await expect(brief.getByText("No events on your calendar today.")).toBeVisible();
  await expect(brief.locator(".mbCalCount")).toHaveText("0 events");
});

test("refresh brief requests a new source snapshot", async ({ page }) => {
  await signIn(page);
  const flagWrite = page.waitForRequest(r =>
    r.method() === "PUT" && r.url().includes("/daily_refresh_requested.json"));
  const workflowKick = page.waitForRequest(r =>
    r.method() === "POST" && r.url().includes("/api/send") &&
    (r.postDataJSON() || {}).action === "refresh");

  await page.getByRole("button", { name: "Refresh brief" }).click();

  expect((await flagWrite).postDataJSON()).toEqual(expect.any(Number));
  await workflowKick;
  await expect(page.getByText("Refreshing your morning brief…")).toBeVisible();
});

test("an old morning brief is not shown as today's", async ({ page }) => {
  const brief = makeBrief();
  brief.daily_brief.date = "2000-01-01";
  await signIn(page, { brief });

  await expect(page.locator(".morningBrief")).toHaveCount(0);
  await expect(page.locator("#briefStrip")).not.toHaveClass(/hidden/);
});
