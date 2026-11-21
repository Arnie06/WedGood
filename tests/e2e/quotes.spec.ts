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
  throw new Error("CI must provide the local Supabase stack for quote specs");
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

async function venue(owner: TestUser, wedding: string, name = "Garden House"): Promise<string> {
  const { data, error } = await owner.client.rpc("create_candidate", {
    p_wedding: wedding,
    p_kind: "venue",
    p_category: "venue",
    p_name: name,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

async function quoteViaRpc(owner: TestUser, wedding: string, candidate: string): Promise<string> {
  const { data, error } = await owner.client.rpc("create_proposal", {
    p_wedding: wedding,
    p_candidate: candidate,
    p_title: "Saturday package",
    p_received_on: "2026-11-03",
    p_valid_until: "2027-01-15",
    p_source_url: "https://example.com/quotes/a/very/long/path/that/should/not/overflow/anything",
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** A cost card found by its exact heading, not by words that also appear in the edit forms. */
function lineCard(page: Page, name: string) {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
}

async function scalar(sql: string, params: unknown[]): Promise<unknown> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows[0]?.v);
}

test("move a venue through the pipeline; the stage persists and filters the list", async ({
  page,
}) => {
  const owner = await appUser("quote-stage");
  const wedding = await createWedding(owner, { name: "Stage" });
  const id = await venue(owner, wedding);
  await venue(owner, wedding, "Coastal Terrace");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover/${id}`);

  const stage = page.getByLabel(/^Where things stand/);
  await expect(stage).toHaveValue("saved");
  // Booked is not offered; it needs a commitment, which comes later.
  await expect(stage.locator("option[value=booked]")).toHaveCount(0);
  await stage.selectOption("contacted");
  await page.getByRole("button", { name: "Update stage" }).click();
  await expect(page.getByText("Stage updated.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/^Where things stand/)).toHaveValue("contacted");
  expect(await scalar("select stage v from public.candidates where id=$1", [id])).toBe("contacted");

  await page.goto(`/app/${wedding}/discover`);
  await expect(
    page.getByRole("listitem").filter({ hasText: "Garden House" }).getByText("Contacted"),
  ).toBeVisible();
  await page.goto(`/app/${wedding}/discover?stage=contacted`);
  await expect(page.getByTestId("result-count")).toHaveText("(1)");
  await expect(page.getByRole("link", { name: "Coastal Terrace" })).toHaveCount(0);
});

test("enter a quote cost by cost; unknowns are never zero and the total says when it is partial", async ({
  page,
}) => {
  const owner = await appUser("quote-flow");
  const wedding = await createWedding(owner, { name: "Flow", guests: 100 });
  const id = await venue(owner, wedding);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover/${id}`);
  await expect(page.getByText(/No quotes yet/)).toBeVisible();

  await page.getByRole("link", { name: "Add a quote" }).click();
  await page.getByLabel(/^Name this quote/).fill("Saturday package");
  await page.getByRole("button", { name: "Save and add costs" }).click();
  await page.waitForURL(/\/quotes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Saturday package" })).toBeVisible();
  await expect(page.getByTestId("known-total")).toContainText("$0.00");
  await expect(page.getByTestId("completeness")).toHaveText("No costs entered yet.");

  const add = page.getByRole("region", { name: "Add a cost" });
  // Per-guest dinner with a 120-guest minimum, used as the base for a percentage.
  await add.getByLabel(/^What is this cost for/).fill("Dinner service");
  await add.getByLabel(/^How is it priced/).selectOption("per_guest");
  await add.getByLabel(/^Price per guest/).fill("95");
  await add.getByLabel(/^Minimum guests/).fill("120");
  await add.getByLabel(/^Do service charge/).selectOption("yes");
  await add.getByLabel(/^Where did this come from/).fill("Email from the caterer, Nov 3");
  await add.getByRole("button", { name: "Add this cost" }).click();
  await expect(add.getByText("Cost added.")).toBeVisible();
  await expect(add.getByLabel(/^What is this cost for/)).toHaveValue("");

  // A cost with no amount at all stays unknown.
  await add.getByLabel(/^What is this cost for/).fill("Venue fee");
  await add.getByRole("button", { name: "Add this cost" }).click();
  await expect(lineCard(page, "Venue fee")).toContainText("Not known yet");

  await add.getByLabel(/^What is this cost for/).fill("Service charge");
  await add.getByLabel(/^How is it priced/).selectOption("percent");
  await add.getByLabel(/^Percentage/).fill("22");
  await add.getByRole("button", { name: "Add this cost" }).click();

  const dinner = lineCard(page, "Dinner service");
  await expect(dinner.getByTestId("line-amount")).toHaveText("$11,400.00");
  await expect(dinner).toContainText("$95.00 × 120 guests (minimum 120 applies)");
  await expect(dinner).toContainText("Source: Email from the caterer, Nov 3");
  const service = lineCard(page, "Service charge");
  await expect(service.getByTestId("line-amount")).toHaveText("$2,508.00");
  await expect(page.getByTestId("known-total")).toContainText("$13,908.00");
  await expect(page.getByTestId("known-total")).toContainText("so far");
  await expect(page.getByTestId("completeness")).toHaveText(
    "1 required cost is still unknown, so this is not the full price.",
  );
  expect(
    await scalar(
      "select amount_minor::text v from public.proposal_lines where wedding_id=$1 and description='Venue fee'",
      [wedding],
    ),
  ).toBeNull();

  // Fill in the unknown through the edit form; the total becomes complete.
  const venueFee = lineCard(page, "Venue fee");
  await venueFee.getByText("Edit", { exact: false }).first().click();
  await venueFee.getByLabel(/^Amount/).fill("5,000");
  await venueFee.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("known-total")).toContainText("$18,908.00");
  await expect(page.getByTestId("known-total")).not.toContainText("so far");
  await expect(page.getByTestId("completeness")).toHaveText("Every required cost has an amount.");

  // An inclusion adds nothing.
  await add.getByLabel(/^What is this cost for/).fill("Chairs");
  await add.getByLabel(/^How is it priced/).selectOption("included");
  await add.getByLabel(/^Already covered by/).selectOption({ label: "Venue fee" });
  await add.getByRole("button", { name: "Add this cost" }).click();
  const chairs = lineCard(page, "Chairs");
  await expect(chairs).toContainText("Already covered by “Venue fee”");
  await expect(page.getByTestId("known-total")).toContainText("$18,908.00");

  // The venue fee can't be removed while Chairs says it is included in it.
  // (Its edit panel is still open from the save above.)
  await venueFee.getByRole("button", { name: /^Remove/ }).click();
  await expect(venueFee.getByText(/say they're included in this one/)).toBeVisible();

  // The quote appears on the venue's page with its honest subtotal.
  await page.goto(`/app/${wedding}/discover/${id}`);
  await expect(page.getByText("Known so far: $18,908.00")).toBeVisible();
  await expect(page.getByText("Every required cost has an amount.")).toBeVisible();
});

test("per-guest costs need a guest count rather than a guess", async ({ page }) => {
  const owner = await appUser("quote-noguests");
  const wedding = await createWedding(owner, { name: "NoGuests" });
  const id = await venue(owner, wedding);
  const quote = await quoteViaRpc(owner, wedding, id);
  await owner.client.rpc("add_proposal_line", {
    p_wedding: wedding,
    p_proposal: quote,
    p_expected_version: 1,
    p_description: "Dinner",
    p_cost_mode: "per_guest",
    p_amount_minor: 9500,
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover/${id}/quotes/${quote}`);
  const line = lineCard(page, "Dinner");
  await expect(line).toContainText("Not known yet");
  await expect(line).toContainText("set a guest count in event settings");
  await expect(page.getByText(/Per-guest costs need a guest count/)).toBeVisible();
  await expect(page.getByTestId("known-total")).toContainText("$0.00");
  await expect(page.getByTestId("completeness")).toContainText("still unknown");
});

test("field errors keep the person's input and save nothing", async ({ page }) => {
  const owner = await appUser("quote-err");
  const wedding = await createWedding(owner, { name: "Err" });
  const id = await venue(owner, wedding);
  const quote = await quoteViaRpc(owner, wedding, id);
  await signInViaUi(page, owner);

  await page.goto(`/app/${wedding}/discover/${id}/quotes/new`);
  await page.getByLabel(/^Link to the quote/).fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Save and add costs" }).click();
  await expect(page.getByText("Give this quote a short name.")).toBeVisible();
  await expect(page.getByText(/web address starting with https/)).toBeVisible();
  await expect(page.getByLabel(/^Link to the quote/)).toHaveValue("javascript:alert(1)");

  await page.goto(`/app/${wedding}/discover/${id}/quotes/${quote}`);
  const add = page.getByRole("region", { name: "Add a cost" });
  await add.getByLabel(/^How is it priced/).selectOption("percent");
  await add.getByLabel(/^Percentage/).fill("250");
  await add.getByRole("button", { name: "Add this cost" }).click();
  await expect(add.getByText("Say what this cost is for.")).toBeVisible();
  await expect(add.getByText(/between 0.01 and 100/)).toBeVisible();
  await expect(add.getByLabel(/^Percentage/)).toHaveValue("250");
  expect(
    await scalar("select count(*)::int v from public.proposal_lines where wedding_id=$1", [
      wedding,
    ]),
  ).toBe(0);
  expect(
    await scalar("select count(*)::int v from public.proposals where wedding_id=$1", [wedding]),
  ).toBe(1);
});

test("a viewer can read quotes but not change them; others get a 404", async ({ page }) => {
  const owner = await appUser("quote-own");
  const wedding = await createWedding(owner, { name: "Roles" });
  const id = await venue(owner, wedding);
  const quote = await quoteViaRpc(owner, wedding, id);
  const viewer = await appUser("quote-view");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/discover/${id}`);
  await expect(page.getByRole("link", { name: "Saturday package" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add a quote" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update stage" })).toHaveCount(0);
  await page.goto(`/app/${wedding}/discover/${id}/quotes/${quote}`);
  await expect(page.getByRole("heading", { level: 1, name: "Saturday package" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add this cost|Save details/ })).toHaveCount(0);
  expect((await page.goto(`/app/${wedding}/discover/${id}/quotes/new`))?.status()).toBe(404);

  const stranger = await appUser("quote-stranger");
  await page.context().clearCookies();
  await signInViaUi(page, stranger);
  expect((await page.goto(`/app/${wedding}/discover/${id}/quotes/${quote}`))?.status()).toBe(404);
  // The right quote under the wrong venue is also not found.
  const other = await createWedding(stranger, { name: "Other" });
  const otherVenue = await venue(stranger, other);
  expect((await page.goto(`/app/${other}/discover/${otherVenue}/quotes/${quote}`))?.status()).toBe(
    404,
  );
});

test("quote pages pass axe and reflow at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("quote-a11y");
  const wedding = await createWedding(owner, { name: "A11y", guests: 120 });
  const id = await venue(owner, wedding, "A venue with a rather long name for a narrow phone");
  const quote = await quoteViaRpc(owner, wedding, id);
  let v = 1;
  const add = async (extra: Record<string, unknown>) => {
    const r = await owner.client.rpc("add_proposal_line", {
      p_wedding: wedding,
      p_proposal: quote,
      p_expected_version: v,
      ...extra,
    });
    if (r.error) throw new Error(r.error.message);
    v += 1;
    return r.data as string;
  };
  const fee = await add({
    p_description: "Venue fee including a long description that must wrap on a phone",
    p_cost_mode: "fixed",
    p_amount_minor: 500000,
    p_percent_base: true,
    p_evidence: "Page 2 of the PDF contract the planner emailed us on the third of November",
  });
  await add({
    p_description: "Dinner",
    p_cost_mode: "per_guest",
    p_amount_minor: 9500,
    p_min_qty: 100,
    p_max_qty: 110,
  });
  await add({ p_description: "Service", p_cost_mode: "percent", p_rate_bp: 2200 });
  await add({ p_description: "Chairs", p_cost_mode: "included", p_included_in_line_id: fee });
  await add({
    p_description: "Late bar",
    p_cost_mode: "quantity",
    p_required: false,
    p_certainty: "estimated",
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, name] of [
      [`/app/${wedding}/discover/${id}`, "quote-venue"],
      [`/app/${wedding}/discover/${id}/quotes/new`, "quote-new"],
      [`/app/${wedding}/discover/${id}/quotes/${quote}`, "quote-detail"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (name === "quote-detail") {
        for (const summary of await page.locator("summary").all()) await summary.click();
      }
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((x) => `${name}@${width}: ${x.id}`)).toEqual([]);
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
