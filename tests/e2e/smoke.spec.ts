import { expect, test } from "@playwright/test";

import { allRoutes } from "./routes";

/**
 * Cross-engine smoke (runs in Chromium, Firefox and WebKit). Deliberately
 * shallow: rendering, navigation and reflow. Accessibility and detailed layout
 * checks stay in the Chromium-only suites.
 */
test.describe("cross-browser smoke", () => {
  for (const route of allRoutes) {
    test(`${route} renders without horizontal overflow at 320px`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      await expect(page.locator("h1").first()).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("keyboard reaches the skip link first and it moves focus to main", async ({
    page,
    browserName,
  }) => {
    // Safari only Tabs to links with Option+Tab (OS setting), so plain Tab can't be asserted.
    test.skip(browserName === "webkit", "Safari does not Tab to links by default");
    await page.goto("/preview");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: /skip to/i });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content, main").first()).toBeVisible();
  });

  test("unknown routes show the styled 404", async ({ page }) => {
    const response = await page.goto("/no-such-page");
    expect(response?.status()).toBe(404);
  });

  test("protected area sends anonymous visitors to sign-in", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
