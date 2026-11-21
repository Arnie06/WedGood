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

// These specs drive the real app against the real local Supabase stack. Without
// the stack they are skipped (and reported as skipped), never faked.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
// In CI a missing stack is a pipeline failure, not a reason to skip.
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for membership specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";

// Test users get a known password so the browser can sign in through the real form.
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

async function signInViaUi(page: Page, user: { email: string }, next?: string) {
  await page.goto(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

test("signed-out visitors are sent to sign in and returned afterwards", async ({ page }) => {
  const owner = await appUser("guard-owner");
  const wedding = await createWedding(owner);
  await page.goto(`/app/${wedding}`);
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2F/);
  await page.getByLabel(/^Email/).fill(owner.email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/${wedding}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("a signed-in non-member sees the same 404 as an unknown workspace", async ({ page }) => {
  const owner = await appUser("tenant-a");
  const outsider = await appUser("tenant-b");
  const wedding = await createWedding(owner);
  await signInViaUi(page, outsider);
  await expect(page).toHaveURL(/\/app$/);

  const real = await page.goto(`/app/${wedding}`);
  expect(real?.status()).toBe(404);
  const bodyReal = await page.locator("body").innerText();
  const fake = await page.goto("/app/00000000-0000-4000-8000-000000000000");
  expect(fake?.status()).toBe(404);
  expect(await page.locator("body").innerText()).toBe(bodyReal);
  const members = await page.goto(`/app/${wedding}/settings/members`);
  expect(members?.status()).toBe(404);
});

test("unsafe next targets are ignored after sign-in", async ({ page }) => {
  const user = await appUser("redirect");
  await signInViaUi(page, user, "https://evil.example/phish");
  await expect(page).toHaveURL(/\/app$/);
});

test("owner invites a partner by link; wrong account is refused; right account joins", async ({
  page,
  browser,
}) => {
  const owner = await appUser("flow-owner");
  const partner = await appUser("flow-partner");
  const wrong = await appUser("flow-wrong");
  const wedding = await createWedding(owner, { name: "Flow Wedding" });

  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/settings/members`);
  await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();

  await page.getByLabel("Their email address").fill(partner.email);
  await page.getByLabel("Role", { exact: true }).selectOption("partner");
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = page.getByLabel("Invitation link");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText(partner.email)).toBeVisible();

  // Wrong signed-in account: generic refusal, nothing joined.
  const wrongCtx = await browser.newContext();
  const wrongPage = await wrongCtx.newPage();
  await signInViaUi(wrongPage, wrong);
  await wrongPage.goto(url);
  await wrongPage.getByRole("button", { name: "Join this wedding" }).click();
  await expect(wrongPage.locator('main [role="alert"]')).toContainText(
    "isn't valid for the account",
  );
  expect((await wrongPage.goto(`/app/${wedding}`))?.status()).toBe(404);
  await wrongCtx.close();

  // Signed out: asked to sign in, then returned to the invite.
  const ctx = await browser.newContext();
  const partnerPage = await ctx.newPage();
  await partnerPage.goto(url);
  await partnerPage.getByRole("link", { name: "Sign in" }).click();
  await partnerPage.getByLabel(/^Email/).fill(partner.email);
  await partnerPage.getByLabel(/^Password/).fill(password);
  await partnerPage.getByRole("button", { name: "Sign in" }).click();
  await expect(partnerPage).toHaveURL(url);
  await partnerPage.getByRole("button", { name: "Join this wedding" }).click();
  await expect(partnerPage).toHaveURL(new RegExp(`/app/${wedding}$`));
  await expect(partnerPage.getByText("Flow Wedding").first()).toBeVisible();

  // Replaying the link now fails.
  await partnerPage.goto(url);
  await partnerPage.getByRole("button", { name: "Join this wedding" }).click();
  await expect(partnerPage.locator('main [role="alert"]')).toBeVisible();

  // A plain partner sees the list but no invitation controls.
  await partnerPage.goto(`/app/${wedding}/settings/members`);
  await expect(partnerPage.getByText("Only owners, and partners")).toBeVisible();
  await expect(partnerPage.getByRole("button", { name: "Create invitation" })).toHaveCount(0);
  await ctx.close();

  // Owner removes the partner; access ends immediately.
  await page.reload();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Yes, remove" }).click();
  // The row (and its inline message) unmounts on success; the list shrinking is the evidence.
  await expect(page.getByRole("heading", { name: "Members (1)" })).toBeVisible();
  await expect(page.getByText(partner.email)).toHaveCount(0);
});

test("the last owner cannot leave", async ({ page }) => {
  const owner = await appUser("last-owner");
  const wedding = await createWedding(owner);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/settings/members`);
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.getByRole("button", { name: "Yes, leave" }).click();
  await expect(page.locator('main [role="alert"]')).toContainText("at least one owner");
  await expect(page).toHaveURL(new RegExp(`/settings/members$`));
});

test("members page has no axe violations and no overflow at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("a11y-owner");
  const wedding = await createWedding(owner);
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${wedding}/settings/members`);
    await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `test-results/screenshots/${width}/members.png`,
      fullPage: true,
    });
  }
});
