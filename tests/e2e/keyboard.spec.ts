import { expect, test, type Page } from "@playwright/test";

async function focusedOutline(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
  });
}

test("skip link is first in tab order and moves focus to main", async ({ page }) => {
  await page.goto("/preview");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test.describe("desktop sidebar keyboard navigation", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("tabs through nav with a visible eucalyptus focus ring and marks the current page", async ({
    page,
  }) => {
    await page.goto("/preview");
    const nav = page.getByRole("navigation", { name: "Workspace" });
    await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

    const guests = nav.getByRole("link", { name: "Guests" });
    for (
      let i = 0;
      i < 12 && !(await guests.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press("Tab");
    }
    await expect(guests).toBeFocused();
    expect(await focusedOutline(page)).toEqual({
      style: "solid",
      width: "2px",
      color: "rgb(61, 90, 80)",
    });

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/preview\/guests$/);
    await expect(page.getByRole("heading", { level: 1, name: "Guests" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Guests" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });
});

test.describe("mobile bottom navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("reaches every group and keeps one current item", async ({ page }) => {
    await page.goto("/preview");
    const nav = page.getByRole("navigation", { name: "Workspace" });
    for (const [label, path] of [
      ["Discover", "/preview/discover"],
      ["Plan", "/preview/plan"],
      ["Guests", "/preview/guests"],
      ["More", "/preview/more"],
      ["Home", "/preview"],
    ] as const) {
      await nav.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(nav.locator("[aria-current=page]")).toHaveCount(1);
      await expect(nav.locator("[aria-current=page]")).toHaveText(label);
    }
  });
});

test("landing primary action uses charcoal text on blush", async ({ page }) => {
  await page.goto("/");
  const cta = page.getByRole("main").getByRole("link", { name: "Explore the preview" }).first();
  const colors = await cta.evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(colors).toEqual({ color: "rgb(27, 28, 26)", background: "rgb(216, 140, 154)" });
});

test("preview is labelled as sample data on every section", async ({ page }) => {
  for (const route of ["/preview", "/preview/plan"]) {
    await page.goto(route);
    await expect(page.getByRole("note", { name: "About this preview" })).toContainText(
      "fictional sample data",
    );
  }
});

test("unknown routes render the styled not-found page", async ({ page }) => {
  const response = await page.goto("/does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("We couldn't find that page");
});
