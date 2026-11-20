import { expect, test } from "@playwright/test";
import { allRoutes, previewRoutes, viewports } from "./routes";

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of allRoutes) {
      test(`no horizontal overflow on ${route}`, async ({ page }) => {
        await page.goto(route);
        await page.evaluate(() => document.fonts.ready);
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

        const slug = route === "/" ? "landing" : route.slice(1).replaceAll("/", "-");
        await page.screenshot({
          path: `test-results/screenshots/${viewport.name}/${slug}.png`,
          fullPage: true,
        });
      });
    }

    test("navigation pattern matches the breakpoint", async ({ page }) => {
      await page.goto(previewRoutes[0]);
      const nav = page.getByRole("navigation", { name: "Workspace" });
      await expect(nav).toHaveCount(1);
      const box = await nav.boundingBox();
      expect(box).not.toBeNull();
      if (viewport.width >= 1024) {
        expect(box!.x).toBeLessThan(40);
        expect(box!.height).toBeLessThan(viewport.height);
      } else {
        expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport.height - 1);
        // Every bottom-nav target is at least 44×44 CSS px.
        for (const link of await nav.getByRole("link").all()) {
          const target = await link.boundingBox();
          expect(target!.width).toBeGreaterThanOrEqual(44);
          expect(target!.height).toBeGreaterThanOrEqual(44);
        }
      }
    });
  });
}

test.describe("content stays visible above the bottom navigation", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("last content on the preview home can scroll clear of the nav", async ({ page }) => {
    await page.goto("/preview");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const lastCard = page.locator("main section").last();
    const nav = page.getByRole("navigation", { name: "Workspace" });
    const [cardBox, navBox] = [await lastCard.boundingBox(), await nav.boundingBox()];
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(navBox!.y);
  });
});
