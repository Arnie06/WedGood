import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { allRoutes } from "./routes";

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const width of [320, 1280]) {
  test.describe(`axe WCAG 2.2 AA at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const route of allRoutes) {
      test(route, async ({ page }) => {
        await page.goto(route);
        const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
        const summary = results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          targets: v.nodes.map((n) => n.target.join(" ")),
        }));
        expect(summary).toEqual([]);
      });
    }
  });
}

test("each page has one h1, a main landmark and a title", async ({ page }) => {
  for (const route of allRoutes) {
    await page.goto(route);
    await expect(page.locator("h1"), route).toHaveCount(1);
    await expect(page.locator("main#main"), route).toHaveCount(1);
    await expect(page, route).toHaveTitle(/Wedding Workspace/);
  }
});
