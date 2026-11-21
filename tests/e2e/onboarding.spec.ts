import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  withSuperuser,
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
  throw new Error("CI must provide the local Supabase stack for onboarding specs");
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

async function signInViaUi(page: Page, user: { email: string }, next?: string) {
  await page.goto(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

test("a new user creates a workspace with only a name; unknowns stay unknown", async ({ page }) => {
  const user = await appUser("onb-min");
  await signInViaUi(page, user);
  await page.goto("/app");
  await page.getByRole("link", { name: "Start a new wedding workspace" }).click();
  await expect(page).toHaveURL(/\/app\/onboarding$/);

  await page.getByLabel(/^Wedding name/).fill("Jules & Sam");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL(/\/app\/[0-9a-f-]{36}$/);

  await expect(page.getByRole("heading", { name: "Jules & Sam", level: 1 })).toBeVisible();
  await expect(page.getByText("Not set yet")).toHaveCount(4);
  const id = page.url().split("/").pop()!;
  await withSuperuser(async (db) => {
    const r = await db.query(
      "select date, target_budget_minor, target_guest_count, location from public.weddings where id=$1",
      [id],
    );
    expect(r.rows[0]).toEqual({
      date: null,
      target_budget_minor: null,
      target_guest_count: null,
      location: null,
    });
  });
});

test("optional details persist across reload and show a date-only countdown", async ({ page }) => {
  const user = await appUser("onb-full");
  await signInViaUi(page, user);
  await page.goto("/app/onboarding");
  await page.getByLabel(/^Wedding name/).fill("Alex & Morgan");
  await page.getByLabel("Wedding date").fill("2099-05-22");
  await page.getByLabel("Location").fill("Napa Valley");
  await page.getByLabel("Budget target").fill("40,000");
  await page.getByLabel("Guest count target").fill("120");
  await page.getByLabel(/^Time zone/).selectOption("America/Los_Angeles");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL(/\/app\/[0-9a-f-]{36}$/);

  await page.reload();
  await expect(page.getByText("May 22, 2099")).toBeVisible();
  await expect(page.getByRole("main").getByText(/days to go/)).toBeVisible();
  await expect(page.getByText("$40,000.00")).toBeVisible();
  await expect(page.getByText("120", { exact: true })).toBeVisible();
  await expect(page.getByText("Napa Valley")).toBeVisible();
});

test("invalid details show field errors and keep what was typed", async ({ page }) => {
  const user = await appUser("onb-invalid");
  await signInViaUi(page, user);
  await page.goto("/app/onboarding");
  await page.getByLabel("Budget target").fill("lots");
  await page.getByLabel("Guest count target").fill("-4");
  await page.getByLabel("Location").fill("Somewhere");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page.getByText("Give your wedding a name")).toBeVisible();
  await expect(page.getByText("Enter an amount like 40000")).toBeVisible();
  await expect(page.getByText("Enter a whole number")).toBeVisible();
  await expect(page.getByLabel("Budget target")).toHaveValue("lots");
  await expect(page.getByLabel("Location")).toHaveValue("Somewhere");
  await expect(page).toHaveURL(/\/app\/onboarding$/);
  await withSuperuser(async (db) => {
    const r = await db.query("select count(*)::int n from public.memberships where user_id=$1", [
      user.id,
    ]);
    expect(r.rows[0].n).toBe(0);
  });
});

test("owner edits event details and clears one back to unknown", async ({ page }) => {
  const owner = await appUser("onb-edit");
  const wedding = await createWedding(owner, {
    name: "Edit Me",
    date: "2099-01-01",
    budgetMinor: 1_000_000,
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/settings/event`);
  await expect(page.getByLabel("Budget target")).toHaveValue("10000");
  await page.getByLabel(/^Wedding name/).fill("Edited");
  await page.getByLabel("Wedding date").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.goto(`/app/${wedding}`);
  await expect(page.getByRole("heading", { name: "Edited", level: 1 })).toBeVisible();
  await expect(page.getByText("Still deciding is fine.")).toBeVisible();
});

test("a stale edit is refused with a reload message and does not overwrite", async ({ page }) => {
  const owner = await appUser("onb-stale");
  const wedding = await createWedding(owner, { name: "Stale" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/settings/event`);
  // Someone else saves first.
  const { error } = await owner.client.rpc("update_wedding_settings", {
    p_wedding: wedding,
    p_expected_version: 1,
    p_name: "Saved elsewhere",
    p_timezone: "America/Chicago",
    p_base_currency: "USD",
  });
  expect(error).toBeNull();
  await page.getByLabel(/^Wedding name/).fill("My stale edit");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Someone updated these details")).toBeVisible();
  await withSuperuser(async (db) => {
    const r = await db.query("select name from public.weddings where id=$1", [wedding]);
    expect(r.rows[0].name).toBe("Saved elsewhere");
  });
});

test("a viewer sees event details read-only and a non-member gets a 404", async ({ page }) => {
  const owner = await appUser("onb-owner");
  const viewer = await appUser("onb-viewer");
  const outsider = await appUser("onb-outsider");
  const wedding = await createWedding(owner, { name: "Private" });
  await withSuperuser(async (db) => {
    await db.query(
      "insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')",
      [wedding, viewer.id],
    );
  });
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/settings/event`);
  await expect(page.getByText("Ask the workspace owner to change them.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(page.getByLabel(/^Wedding name/)).toBeDisabled();

  await page.context().clearCookies();
  await signInViaUi(page, outsider);
  const res = await page.goto(`/app/${wedding}/settings/event`);
  expect(res?.status()).toBe(404);
});

test("onboarding and event settings pass axe and reflow at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("onb-a11y");
  const wedding = await createWedding(owner, { name: "A11y" });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, name] of [
      ["/app/onboarding", "onboarding"],
      [`/app/${wedding}/settings/event`, "event-settings"],
      [`/app/${wedding}`, "workspace-home"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((v) => `${name}@${width}: ${v.id}`)).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name}@${width} overflow`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `test-results/screenshots/${width}/${name}.png`,
        fullPage: true,
      });
    }
  }
});
