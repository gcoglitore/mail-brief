const { test, expect } = require("@playwright/test");
const { signIn } = require("./fixtures");

test.use({ viewport: { width: 390, height: 844 } });

test("breaking alert expands and can be muted with undo", async ({ page }) => {
  await signIn(page);

  const alert = page.locator(".breakingAlert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("BREAKING · TECHNOLOGY");
  await expect(alert).toContainText("Major AI regulation approved");
  await expect(alert).toContainText("Reuters and 3 other sources");

  const read = alert.getByRole("button", { name: "Read summary" });
  await read.click();
  await expect(page.locator("#breakingDetails")).toBeVisible();
  await expect(alert.getByRole("button", { name: "Hide summary" })).toHaveAttribute("aria-expanded", "true");

  await alert.getByRole("button", { name: "Mute this story" }).click();
  await expect(page.locator("#breakingNews")).toBeHidden();
  await expect(page.locator("#toast")).toContainText("Story muted");

  await page.locator("#toast").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".breakingAlert")).toBeVisible();
});

test("priority stays quiet when no breaking story is available", async ({ page }) => {
  await signIn(page, { news: [] });
  await expect(page.locator("#breakingNews")).toBeHidden();
});
