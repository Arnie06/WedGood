import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  type TestUser,
} from "../integration/helpers";

// Drives the real app against the real local Supabase stack (see membership.spec.ts).
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for empty-state specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";

async function appUser(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID()}@example.test`;
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { id: data.user.id, email, client };
}

async function signInViaUi(page: Page, user: { email: string }) {
  await page.goto("/sign-in");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

test("seating with no events offers to create one right there", async ({ page }) => {
  const owner = await appUser("empty-seat");
  const wedding = await createWedding(owner, { name: "Empty Seating" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/seating`);

  await expect(page.getByRole("heading", { name: "Create your first event" })).toBeVisible();
  await expect(page.getByLabel(/^Event name/)).toHaveValue("Reception");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("link", { name: /Open the seating plan/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create your first event" })).toHaveCount(0);
});

test("an empty budget leads with setup, then shows the summary with the breakdown folded", async ({
  page,
}) => {
  const owner = await appUser("empty-budget");
  const wedding = await createWedding(owner, { name: "Empty Budget" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/budget`);

  await expect(page.getByText("Start with some categories")).toBeVisible();
  // No wall of zeroes before there is anything to summarise.
  await expect(page.getByRole("heading", { name: "Where you stand" })).toHaveCount(0);
  await expect(page.getByText("$0.00")).toHaveCount(0);

  await page.getByRole("button", { name: "Add suggested categories" }).click();
  await expect(page.getByRole("heading", { name: "Where you stand" })).toBeVisible();
  const breakdown = page.locator("details", { hasText: "How the forecast is built" });
  await expect(breakdown.getByText("Planned costs")).toBeHidden();
  await breakdown.getByText("How the forecast is built").click();
  await expect(breakdown.getByText("Planned costs")).toBeVisible();
  await expect(breakdown.getByText("Reserve", { exact: true })).toBeVisible();
});

test("empty seating and budget pass axe and reflow at 320 and 1280", async ({ page }) => {
  const owner = await appUser("empty-a11y");
  const wedding = await createWedding(owner, { name: "Empty A11y" });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ["seating", "plan/budget"]) {
      await page.goto(`/app/${wedding}/${path}`);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations, path).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }
  }
});
