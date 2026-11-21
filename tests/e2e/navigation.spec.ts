import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { adminClient, anonClient, createWedding, localStack } from "../integration/helpers";

// Drives the real app against the real local Supabase stack (see membership.spec.ts).
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for navigation specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";

async function ownerWithWorkspace(label: string) {
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
  const wedding = await createWedding({ id: data.user.id, email, client }, { name: "Nav, Test" });
  return { email, wedding };
}

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

test("every bottom-nav item and every More link opens a real page", async ({ page }) => {
  const { email, wedding } = await ownerWithWorkspace("nav");
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, email);
  await page.goto(`/app/${wedding}`);

  const nav = page.getByRole("navigation", { name: "Workspace" });
  for (const label of ["Discover", "Plan", "Guests", "More", "Home"]) {
    await nav.getByRole("link", { name: label }).click();
    await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page.getByText("We couldn't find that page")).toHaveCount(0);
  }

  await nav.getByRole("link", { name: "More" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();
  const hrefs = await page
    .getByRole("main")
    .getByRole("link")
    .evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
  expect(hrefs.length).toBeGreaterThanOrEqual(6);
  for (const href of hrefs) {
    const response = await page.goto(href!);
    expect(response?.status(), href!).toBe(200);
    await expect(page.locator("h1").first()).toBeVisible();
  }
});

test("More page has no axe violations or overflow at 320 and 1280", async ({ page }) => {
  const { email, wedding } = await ownerWithWorkspace("nav-a11y");
  await signIn(page, email);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/app/${wedding}/more`);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

test("landing offers sign-up and sign-in and no longer says accounts are closed", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText(/accounts aren't open/i)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create account" })).toHaveAttribute(
    "href",
    "/sign-up",
  );
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
});
