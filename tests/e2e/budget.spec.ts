import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
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
  throw new Error("CI must provide the local Supabase stack for budget specs");
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

async function rpc<T>(user: TestUser, fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await user.client.rpc(fn, args);
  if (r.error) throw new Error(`${fn}: ${r.error.message}`);
  return r.data as T;
}

async function scalar(sql: string, params: unknown[]): Promise<unknown> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows[0]?.v);
}

/** The value shown under a summary label, e.g. figure(page, "Forecast"). */
const figure = (page: Page, label: string) =>
  page
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");

const page_ = (wedding: string) => `/app/${wedding}/plan/budget`;

test("empty budget: suggested categories, add costs, T01 figures, unknown stays incomplete", async ({
  page,
}) => {
  const owner = await appUser("bud-flow");
  const wedding = await createWedding(owner, {
    name: "Budget",
    guests: 120,
    budgetMinor: 5_000_000,
  });
  await signInViaUi(page, owner);
  await page.goto(page_(wedding));

  await expect(page.getByRole("heading", { level: 1, name: "Budget" })).toBeVisible();
  await expect(page.getByText("Start with some categories")).toBeVisible();
  await expect(figure(page, "Your target")).toHaveText("$50,000.00");
  await expect(figure(page, "Forecast")).toHaveText("$0.00");
  await page.getByRole("button", { name: "Add suggested categories" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Catering and bar" })).toBeVisible();

  // Catering: $95 per guest, minimum 120 guests.
  const addCost = async (fill: (add: Locator) => Promise<void>) => {
    await page.getByRole("button", { name: "Add a cost" }).click();
    const add = page.getByRole("dialog", { name: "Add a cost" });
    await fill(add);
    await add.getByRole("button", { name: "Add cost" }).click();
    await expect(add).toBeHidden();
    await expect(page.getByText("Cost added.").last()).toBeVisible();
  };
  await addCost(async (add) => {
    await add.getByLabel(/^What is this cost/).fill("Dinner");
    await add.getByLabel(/^Category/).selectOption({ label: "Catering and bar" });
    await add.getByLabel(/^How is it priced/).selectOption("per_guest");
    await add.getByLabel(/^Price per guest/).fill("95");
    await add.getByLabel(/^Minimum guests/).fill("120");
  });
  await expect(page.getByText("$95.00 × 120 guests")).toBeVisible();

  // A bar at $30 per guest and a fixed venue hire of $20,000.
  await addCost(async (add) => {
    await add.getByLabel(/^What is this cost/).fill("Bar");
    await add.getByLabel(/^Category/).selectOption({ label: "Catering and bar" });
    await add.getByLabel(/^How is it priced/).selectOption("per_guest");
    await add.getByLabel(/^Price per guest/).fill("30");
  });
  await expect(page.getByText("$30.00 × 120 guests")).toBeVisible();
  await addCost(async (add) => {
    await add.getByLabel(/^What is this cost/).fill("Venue hire");
    await add.getByLabel(/^Category/).selectOption({ label: "Venue" });
    await add.getByLabel(/^Amount/).fill("20000");
  });

  // $35,000 planned, no reserve yet.
  await page.getByText("How the forecast is built").click();
  await expect(figure(page, "Planned costs")).toHaveText("$35,000.00");
  await page.getByRole("button", { name: "Change the reserve" }).click();
  await page.getByLabel(/^Reserve for the unexpected/).fill("10");
  await page.getByRole("button", { name: "Save reserve" }).click();
  await expect(figure(page, "Forecast")).toHaveText("$38,500.00");
  await expect(figure(page, "Left against your target")).toHaveText("$11,500.00"); // 50,000 - 38,500

  // A cost with no amount is flagged and never counted as zero.
  await addCost(async (add) => {
    await add.getByLabel(/^What is this cost/).fill("Photographer");
    await add.getByLabel(/^Category/).selectOption({ label: "Photography and video" });
  });
  await expect(page.getByText(/1 cost has no amount yet/)).toBeVisible();
  await expect(figure(page, "Forecast")).toHaveText("At least $38,500.00");
  await expect(page.getByText("Not known yet")).toBeVisible();
  expect(
    await scalar(
      "select amount_minor as v from public.budget_items where wedding_id=$1 and name='Photographer'",
      [wedding],
    ),
  ).toBeNull();

  // Committed and paid are honestly zero; nothing was booked.
  await expect(page.getByText(/Nothing booked or paid yet/)).toBeVisible();
});

test("a blank target shows 'Not set', not zero, and a category over its target is flagged", async ({
  page,
}) => {
  const owner = await appUser("bud-null");
  const wedding = await createWedding(owner, { name: "No target" });
  const cat = await rpc<string>(owner, "create_budget_category", {
    p_wedding: wedding,
    p_name: "Flowers",
    p_allocation_minor: 100_000,
  });
  await rpc(owner, "create_budget_item", {
    p_wedding: wedding,
    p_category: cat,
    p_name: "Bouquets",
    p_amount_minor: 150_000,
  });
  await signInViaUi(page, owner);
  await page.goto(page_(wedding));
  await expect(figure(page, "Your target")).toHaveText("Not set");
  await expect(page.getByText("Needs a target")).toBeVisible();
  await expect(page.getByText(/\$500\.00 above this category's target/)).toBeVisible();
});

test("edit a cost, field errors keep input, a stale edit is refused without overwriting", async ({
  browser,
}) => {
  const owner = await appUser("bud-edit");
  const wedding = await createWedding(owner, { name: "Edit" });
  const cat = await rpc<string>(owner, "create_budget_category", {
    p_wedding: wedding,
    p_name: "Music",
  });
  const id = await rpc<string>(owner, "create_budget_item", {
    p_wedding: wedding,
    p_category: cat,
    p_name: "DJ",
    p_amount_minor: 100_000,
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInViaUi(page, owner);
  await page.goto(page_(wedding));
  await page.getByRole("button", { name: "Edit DJ" }).click();

  const form = page.getByRole("dialog", { name: "Edit cost" });
  await form.getByLabel(/^Amount/).fill("abc");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form.getByText("Enter an amount like 950")).toBeVisible();
  await expect(form.getByLabel(/^Amount/)).toHaveValue("abc");

  // Someone else changes it first.
  await rpc(owner, "update_budget_item", {
    p_wedding: wedding,
    p_item: id,
    p_expected_version: 1,
    p_category: cat,
    p_name: "DJ",
    p_cost_mode: "fixed",
    p_amount_minor: 120_000,
  });
  await form.getByLabel(/^Amount/).fill("900");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form.getByText(/Someone changed this/)).toBeVisible();
  expect(
    await scalar("select amount_minor::int as v from public.budget_items where id=$1", [id]),
  ).toBe(120_000);

  await page.reload();
  await page.getByRole("button", { name: "Edit DJ" }).click();
  const fresh = page.getByRole("dialog", { name: "Edit cost" });
  await fresh.getByLabel(/^Amount/).fill("900");
  await fresh.getByRole("button", { name: "Save changes" }).click();
  await expect(fresh).toBeHidden();
  expect(
    await scalar("select amount_minor::int as v from public.budget_items where id=$1", [id]),
  ).toBe(90_000);
  await ctx.close();
});

test("a viewer sees the budget without edit controls; a non-member gets a 404", async ({
  page,
  browser,
}) => {
  const owner = await appUser("bud-roles");
  const wedding = await createWedding(owner, { name: "Roles" });
  const cat = await rpc<string>(owner, "create_budget_category", {
    p_wedding: wedding,
    p_name: "Venue",
  });
  await rpc(owner, "create_budget_item", {
    p_wedding: wedding,
    p_category: cat,
    p_name: "Hire",
    p_amount_minor: 1000,
  });
  const viewer = await appUser("bud-viewer");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(page_(wedding));
  await expect(page.getByRole("heading", { level: 3, name: "Venue" })).toBeVisible();
  await expect(page.getByText("Hire")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Add a cost|Add a category|Change the reserve/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);

  const outsider = await appUser("bud-outsider");
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await signInViaUi(p2, outsider);
  const res = await p2.goto(page_(wedding));
  expect(res?.status()).toBe(404);
  await ctx.close();
});

test("changing the currency is refused while budget amounts exist", async ({ page }) => {
  const owner = await appUser("bud-cur");
  const wedding = await createWedding(owner, { name: "Currency" });
  await rpc(owner, "create_budget_category", {
    p_wedding: wedding,
    p_name: "Venue",
    p_allocation_minor: 100,
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/settings/event`);
  await page.getByLabel(/^Currency/).selectOption("EUR");
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByText(/currency can't change while your budget has amounts/)).toBeVisible();
  expect(
    await scalar("select base_currency as v from public.weddings where id=$1", [wedding]),
  ).toBe("USD");
});

test("budget page passes axe and reflows at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("bud-a11y");
  const wedding = await createWedding(owner, { name: "A11y", guests: 120, budgetMinor: 200_000 });
  const cat = await rpc<string>(owner, "create_budget_category", {
    p_wedding: wedding,
    p_name: "A category with a rather long name to test wrapping on a phone",
    p_allocation_minor: 100_000,
  });
  await rpc(owner, "create_budget_item", {
    p_wedding: wedding,
    p_category: cat,
    p_name: "A cost with a long description that has to wrap on a narrow phone screen",
    p_cost_mode: "per_guest",
    p_amount_minor: 9_500,
    p_min_qty: 120,
  });
  await rpc(owner, "create_budget_item", {
    p_wedding: wedding,
    p_category: cat,
    p_name: "Unknown cost",
  });
  await rpc(owner, "set_budget_reserve", {
    p_wedding: wedding,
    p_expected_version: 0,
    p_reserve_bp: 1000,
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(page_(wedding));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `budget@${width}: ${x.id}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `budget@${width} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/screenshots/${width}/budget.png`, fullPage: true });
  }
});
