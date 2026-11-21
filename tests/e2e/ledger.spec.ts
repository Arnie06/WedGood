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
  throw new Error("CI must provide the local Supabase stack for ledger specs");
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

const figure = (page: Page, label: string) =>
  page
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");

/** A wedding with one venue and a planned $9,000 venue cost (an estimate, not yet booked). */
async function seed(label: string) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, {
    name: "Ledger",
    guests: 100,
    budgetMinor: 5_000_000,
  });
  const category = await rpc<string>(owner, "create_budget_category", {
    p_wedding: wedding,
    p_name: "Venue",
  });
  const item = await rpc<string>(owner, "create_budget_item", {
    p_wedding: wedding,
    p_category: category,
    p_name: "Venue fee",
    p_amount_minor: 900_000,
  });
  const candidate = await rpc<string>(owner, "create_candidate", {
    p_wedding: wedding,
    p_kind: "venue",
    p_category: "venue",
    p_name: "Garden House",
  });
  return { owner, wedding, item, candidate };
}

async function fillBooking(page: Page, fields: { amount?: string; confirm?: boolean } = {}) {
  await page.getByLabel(/^Total you're committing to/).fill(fields.amount ?? "10000");
  await page.getByLabel("Cost 1").selectOption({ label: "Venue · Venue fee" });
  await page.getByLabel("Due date 1").fill("2027-01-15");
  await page
    .getByLabel(/^Amount due/)
    .first()
    .fill("2500");
  await page.getByLabel("Label").first().fill("Deposit");
  await page.getByLabel("Due date 2").fill("2027-05-08");
  await page
    .getByLabel(/^Amount due/)
    .nth(1)
    .fill("7500");
  if (fields.confirm !== false) await page.getByLabel(/signed or explicitly agreed/).check();
}

test("book, pay, refund: T03/T04 figures, forecast counts the booking once", async ({ page }) => {
  const { owner, wedding, candidate } = await seed("led-flow");
  await signInViaUi(page, owner);
  const base = `/app/${wedding}`;

  // T03: nothing committed before booking.
  await page.goto(`${base}/plan/budget`);
  await expect(figure(page, "Forecast")).toHaveText("$9,000.00");
  await expect(figure(page, "Committed and paid")).toHaveText("$0.00 · $0.00");

  await page.goto(`${base}/discover/${candidate}`);
  await page.getByRole("link", { name: "Record a booking" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Record a booking with Garden House",
  );
  await fillBooking(page);
  await page.getByRole("button", { name: "Record this booking" }).click();

  // Lands on the booking.
  await expect(page.getByRole("heading", { level: 1, name: "Garden House" })).toBeVisible();
  await expect(figure(page, "Committed")).toHaveText("$10,000.00");
  await expect(figure(page, "Paid so far")).toHaveText("$0.00");
  await expect(figure(page, "Still owed")).toHaveText("$10,000.00");
  await expect(page.getByText("Deposit · January 15, 2027")).toBeVisible();

  // Pay $2,500, then a $500 refund.
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Record this" }) });
  await form.getByLabel(/^Amount/).fill("2500");
  await form.getByLabel("How you paid").fill("Check");
  await form.getByRole("button", { name: "Record this" }).click();
  await expect(page.getByText("Payment recorded.")).toBeVisible();
  await expect(figure(page, "Paid so far")).toHaveText("$2,500.00");
  await form.getByLabel("What happened?").selectOption("refund");
  await form.getByLabel(/^Amount/).fill("500");
  await form.getByRole("button", { name: "Record this" }).click();
  await expect(page.getByText("Refund recorded.")).toBeVisible();
  await expect(figure(page, "Paid so far")).toHaveText("$2,000.00");
  await expect(figure(page, "Still owed")).toHaveText("$8,000.00");

  // The vendor shows as booked, and the budget counts the booking once.
  await page.goto(`${base}/discover/${candidate}`);
  await expect(page.getByText("Booked.")).toBeVisible();
  await page.goto(`${base}/plan/budget`);
  await expect(figure(page, "Forecast")).toHaveText("$10,000.00");
  await expect(figure(page, "Committed and paid")).toHaveText("$10,000.00 · $2,000.00");
  await expect(page.getByText("Booked", { exact: true })).toBeVisible();
  await page.goto(`${base}/plan/budget/bookings`);
  await expect(page.getByText(/Paid \$2,000\.00 · Owed \$8,000\.00/)).toBeVisible();
});

test("an unconfirmed or unbalanced booking is refused with the input kept, and records nothing", async ({
  page,
}) => {
  const { owner, wedding, candidate } = await seed("led-invalid");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover/${candidate}/book`);
  await fillBooking(page, { confirm: false });
  await page.getByRole("button", { name: "Record this booking" }).click();
  await expect(page.getByText(/Confirm that this is signed or agreed/)).toBeVisible();
  await expect(page.getByLabel(/^Total you're committing to/)).toHaveValue("10000");

  await page.getByLabel(/signed or explicitly agreed/).check();
  await page
    .getByLabel(/^Amount \(USD\)/)
    .first()
    .fill("9000"); // first cost's amount
  await page.getByRole("button", { name: "Record this booking" }).click();
  await expect(page.getByText(/must add up to the total amount/)).toBeVisible();
  expect(
    await scalar("select count(*)::int as v from public.commitments where wedding_id=$1", [
      wedding,
    ]),
  ).toBe(0);
  expect(await scalar("select stage as v from public.candidates where id=$1", [candidate])).toBe(
    "saved",
  );
});

test("amending keeps the old version and the payments; voiding a mistake stops it counting", async ({
  page,
}) => {
  const { owner, wedding, item, candidate } = await seed("led-amend");
  const commitment = await rpc<string>(owner, "book_commitment", {
    p_wedding: wedding,
    p_candidate: candidate,
    p_expected_candidate_version: 1,
    p_title: "Venue contract",
    p_amount_minor: 1_000_000,
    p_allocations: [{ itemId: item, amountMinor: 1_000_000 }],
    p_installments: [{ dueOn: "2027-01-15", amountMinor: 1_000_000 }],
    p_confirmed: true,
  });
  await rpc(owner, "record_payment", {
    p_wedding: wedding,
    p_kind: "charge",
    p_amount_minor: 250_000,
    p_paid_on: "2026-01-02",
    p_commitment: commitment,
  });
  await rpc(owner, "record_payment", {
    p_wedding: wedding,
    p_kind: "charge",
    p_amount_minor: 100,
    p_paid_on: "2026-01-03",
    p_commitment: commitment,
  });
  await signInViaUi(page, owner);
  const detail = `/app/${wedding}/plan/budget/bookings/${commitment}`;
  await page.goto(detail);

  // Void the $1.00 entry typed by mistake.
  const mistake = page.getByRole("listitem").filter({ hasText: "$1.00" });
  await mistake.getByText("Entered by mistake?").click();
  await mistake.getByLabel("Why was this a mistake?").fill("Typo");
  await mistake.getByRole("button", { name: "Mark as entered by mistake" }).click();
  await expect(figure(page, "Paid so far")).toHaveText("$2,500.00");
  await expect(page.getByText("Entered by mistake", { exact: true })).toBeVisible();

  // Amend to $11,000.
  await page.getByRole("link", { name: "Amend this booking" }).click();
  await expect(page.getByLabel(/^Total you're committing to/)).toHaveValue("10000");
  await page.getByLabel(/^Total you're committing to/).fill("11000");
  await page.getByLabel("Cost 1").selectOption({ label: "Venue · Venue fee" });
  await page
    .getByLabel(/^Amount \(USD\)/)
    .first()
    .fill("11000");
  await page
    .getByLabel(/^Amount due/)
    .first()
    .fill("11000");
  await page.getByLabel(/signed or explicitly agreed/).check();
  await page.getByRole("button", { name: "Save the amended booking" }).click();
  await expect(figure(page, "Committed")).toHaveText("$11,000.00");
  await expect(figure(page, "Paid so far")).toHaveText("$2,500.00");
  await expect(page.getByRole("heading", { name: "Earlier versions" })).toBeVisible();
  expect(
    await scalar(
      "select count(*)::int as v from public.commitments where wedding_id=$1 and status='active'",
      [wedding],
    ),
  ).toBe(1);
  await page.goto(`/app/${wedding}/plan/budget`);
  await expect(figure(page, "Forecast")).toHaveText("$11,000.00");
});

test("a viewer sees bookings read-only and a non-member gets a 404", async ({ page, browser }) => {
  const { owner, wedding, item, candidate } = await seed("led-roles");
  const commitment = await rpc<string>(owner, "book_commitment", {
    p_wedding: wedding,
    p_candidate: candidate,
    p_expected_candidate_version: 1,
    p_title: "Venue contract",
    p_amount_minor: 1_000_000,
    p_allocations: [{ itemId: item, amountMinor: 1_000_000 }],
    p_installments: [],
    p_confirmed: true,
  });
  const viewer = await appUser("led-viewer");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/plan/budget/bookings/${commitment}`);
  await expect(page.getByRole("heading", { level: 1, name: "Venue contract" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record this" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Amend this booking" })).toHaveCount(0);
  await page.goto(`/app/${wedding}/discover/${candidate}/book`);
  await expect(
    page.getByText(/only the workspace owner or partner can record a booking/),
  ).toBeVisible();

  const outsider = await appUser("led-outsider");
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await signInViaUi(p2, outsider);
  const res = await p2.goto(`/app/${wedding}/plan/budget/bookings/${commitment}`);
  expect(res?.status()).toBe(404);
  await ctx.close();
});

test("ledger pages pass axe and reflow at 320px and 1280px", async ({ page }) => {
  const { owner, wedding, item, candidate } = await seed("led-a11y");
  const other = await rpc<string>(owner, "create_candidate", {
    p_wedding: wedding,
    p_kind: "vendor",
    p_category: "photographer",
    p_name: "A photographer whose name is long enough to need wrapping on a phone screen",
  });
  const commitment = await rpc<string>(owner, "book_commitment", {
    p_wedding: wedding,
    p_candidate: candidate,
    p_expected_candidate_version: 1,
    p_title: "A venue contract with a rather long title to test wrapping on a narrow phone",
    p_amount_minor: 1_000_000,
    p_allocations: [{ itemId: item, amountMinor: 1_000_000 }],
    p_installments: [
      { dueOn: "2026-01-15", amountMinor: 250_000, label: "Deposit" },
      { dueOn: "2027-05-08", amountMinor: 500_000 },
    ],
    p_confirmed: true,
  });
  await rpc(owner, "record_payment", {
    p_wedding: wedding,
    p_kind: "charge",
    p_amount_minor: 100_000,
    p_paid_on: "2026-01-02",
    p_commitment: commitment,
    p_method: "Check",
  });
  await signInViaUi(page, owner);
  const pages = [
    ["book", `/app/${wedding}/discover/${other}/book`],
    ["bookings", `/app/${wedding}/plan/budget/bookings`],
    ["booking", `/app/${wedding}/plan/budget/bookings/${commitment}`],
    ["booking-amend", `/app/${wedding}/plan/budget/bookings/${commitment}/amend`],
  ] as const;
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of pages) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((x) => `${name}@${width}: ${x.id}`)).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name}@${width} overflow`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `test-results/screenshots/${width}/ledger-${name}.png`,
        fullPage: true,
      });
    }
  }
});
