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

// REL-09: the booking page reads as a ladder (contract, invoiced, paid, still to pay) and a payment
// can name an invoice. Drives the real app against the real local Supabase stack.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for invoice specs");
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

/** A wedding with one booked venue: contract $12,000.00. */
async function seed(label: string) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, {
    name: "Invoices",
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
  const commitment = await rpc<string>(owner, "book_commitment", {
    p_wedding: wedding,
    p_candidate: candidate,
    p_expected_candidate_version: 1,
    p_title: "Venue contract",
    p_amount_minor: 1_200_000,
    p_allocations: [{ itemId: item, amountMinor: 1_200_000 }],
    p_installments: [],
    p_confirmed: true,
  });
  return { owner, wedding, item, candidate, commitment };
}

const invoiceForm = (page: Page) =>
  page.locator("form").filter({ has: page.getByRole("button", { name: "Add this invoice" }) });
const paymentForm = (page: Page) =>
  page.locator("form").filter({ has: page.getByRole("button", { name: "Record this" }) });

test("record an invoice, pay it, and read the ladder; the budget shows invoiced and unpaid", async ({
  page,
}) => {
  const { owner, wedding, commitment } = await seed("inv-flow");
  await signInViaUi(page, owner);
  const detail = `/app/${wedding}/plan/budget/bookings/${commitment}`;
  await page.goto(detail);

  await expect(figure(page, "Contract")).toHaveText("$12,000.00");
  await expect(figure(page, "Invoiced")).toHaveText("$0.00");
  await expect(figure(page, "Paid so far")).toHaveText("$0.00");
  await expect(figure(page, "Still to pay")).toHaveText("$12,000.00");
  await expect(page.getByText("No invoices recorded. When the vendor sends one")).toBeVisible();
  // No invoice to name yet, so the payment form offers no picker.
  await expect(page.getByLabel("Which invoice is this paying?")).toHaveCount(0);

  const inv = invoiceForm(page);
  await inv.getByLabel(/^Amount on the invoice/).fill("6000");
  await inv.getByLabel("Invoice number").fill("INV-1");
  await inv.getByLabel("Date issued").fill("2026-10-15");
  await inv.getByLabel("Due date").fill("2026-11-01");
  await inv.getByRole("button", { name: "Add this invoice" }).click();
  await expect(page.getByText("Invoice recorded.")).toBeVisible();
  await expect(figure(page, "Invoiced")).toHaveText("$6,000.00");
  await expect(page.getByText("$6,000.00 of it not paid yet.")).toBeVisible();
  // The contract and what is still to pay are untouched by an invoice.
  await expect(figure(page, "Contract")).toHaveText("$12,000.00");
  await expect(figure(page, "Still to pay")).toHaveText("$12,000.00");
  const row = page
    .getByRole("region", { name: "Invoices" })
    .getByRole("listitem")
    .filter({ hasText: "INV-1" });
  await expect(row.getByText("Past due")).toBeVisible();

  // Pay $4,000 against it.
  const pay = paymentForm(page);
  await pay.getByLabel("Which invoice is this paying?").selectOption({ index: 1 });
  await pay.getByLabel(/^Amount/).fill("4000");
  await pay.getByRole("button", { name: "Record this" }).click();
  await expect(page.getByText("Payment recorded.")).toBeVisible();
  await expect(figure(page, "Paid so far")).toHaveText("$4,000.00");
  await expect(figure(page, "Still to pay")).toHaveText("$8,000.00");
  await expect(figure(page, "Invoiced")).toHaveText("$6,000.00");
  await expect(page.getByText("$2,000.00 of it not paid yet.")).toBeVisible();
  await expect(row).toContainText("$4,000.00 paid, $2,000.00 to go");
  await expect(page.getByText("For invoice INV-1")).toBeVisible();

  // The budget page says how much is invoiced and not yet paid; the forecast is the contract.
  await page.goto(`/app/${wedding}/plan/budget`);
  await expect(figure(page, "Forecast")).toHaveText("$12,000.00");
  await expect(figure(page, "Committed and paid")).toHaveText("$12,000.00 · $4,000.00");
  await expect(page.getByText(/\$2,000\.00 of it invoiced and not yet paid/)).toBeVisible();
});

test("an invoice larger than the contract is flagged, not blocked", async ({ page }) => {
  const { owner, wedding, commitment } = await seed("inv-big");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/budget/bookings/${commitment}`);
  const inv = invoiceForm(page);
  await inv.getByLabel(/^Amount on the invoice/).fill("15000");
  await inv.getByRole("button", { name: "Add this invoice" }).click();
  await expect(page.getByText("Invoice recorded.")).toBeVisible();
  await expect(page.getByText(/\$3,000\.00 more than the contract/)).toBeVisible();
  await expect(figure(page, "Contract")).toHaveText("$12,000.00");
  await expect(figure(page, "Still to pay")).toHaveText("$12,000.00");
});

test("a bad invoice keeps the input and records nothing; a repeated number is refused", async ({
  page,
}) => {
  const { owner, wedding, commitment } = await seed("inv-bad");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/budget/bookings/${commitment}`);
  const inv = invoiceForm(page);
  await inv.getByLabel(/^Amount on the invoice/).fill("0");
  await inv.getByLabel("Invoice number").fill("A-9");
  await inv.getByLabel("Date issued").fill("2026-12-10");
  await inv.getByLabel("Due date").fill("2026-12-01");
  await inv.getByRole("button", { name: "Add this invoice" }).click();
  await expect(page.getByText("Enter the amount on the invoice")).toBeVisible();
  await expect(
    page.getByText("The due date can't be before the date it was issued."),
  ).toBeVisible();
  await expect(inv.getByLabel("Invoice number")).toHaveValue("A-9");
  expect(
    await scalar("select count(*)::int as v from public.invoices where wedding_id=$1", [wedding]),
  ).toBe(0);

  await inv.getByLabel(/^Amount on the invoice/).fill("100");
  await inv.getByLabel("Due date").fill("");
  await inv.getByRole("button", { name: "Add this invoice" }).click();
  await expect(page.getByText("Invoice recorded.")).toBeVisible();
  const again = invoiceForm(page);
  // A refused try followed by a saved one leaves the next form blank, not filled with the old values.
  await expect(again.getByLabel("Date issued")).toHaveValue("");
  await expect(again.getByLabel("Due date")).toHaveValue("");
  await again.getByLabel(/^Amount on the invoice/).fill("100");
  await again.getByLabel("Invoice number").fill("a-9");
  await again.getByRole("button", { name: "Add this invoice" }).click();
  await expect(
    page.getByText("This booking already has an invoice with that number."),
  ).toBeVisible();
  expect(
    await scalar("select count(*)::int as v from public.invoices where wedding_id=$1", [wedding]),
  ).toBe(1);
});

test("an invoice entered by mistake is kept, stops counting, and frees its payments", async ({
  page,
}) => {
  const { owner, wedding, commitment } = await seed("inv-void");
  const invoice = await rpc<string>(owner, "create_invoice", {
    p_wedding: wedding,
    p_commitment: commitment,
    p_amount_minor: 600_000,
    p_number: "OOPS",
  });
  await rpc(owner, "record_payment", {
    p_wedding: wedding,
    p_kind: "charge",
    p_amount_minor: 100_000,
    p_paid_on: "2026-01-02",
    p_commitment: commitment,
    p_invoice: invoice,
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/budget/bookings/${commitment}`);
  await expect(figure(page, "Invoiced")).toHaveText("$6,000.00");

  const row = page
    .getByRole("region", { name: "Invoices" })
    .getByRole("listitem")
    .filter({ hasText: "OOPS" });
  await row.getByText("Entered by mistake?").click();
  await row.getByLabel("Why was this a mistake?").fill("Wrong booking");
  await row.getByRole("button", { name: "Mark as entered by mistake" }).click();
  await expect(page.getByText("Wrong booking")).toBeVisible();
  await expect(figure(page, "Invoiced")).toHaveText("$0.00");
  // The money that was paid is still paid; it just no longer names the invoice.
  await expect(figure(page, "Paid so far")).toHaveText("$1,000.00");
  await expect(page.getByText("For invoice OOPS")).toHaveCount(0);
  expect(
    await scalar("select count(*)::int as v from public.invoices where wedding_id=$1", [wedding]),
  ).toBe(1);
});

test("amending the booking keeps its invoices and the payments that name them", async ({
  page,
}) => {
  const { owner, wedding, commitment } = await seed("inv-amend");
  const invoice = await rpc<string>(owner, "create_invoice", {
    p_wedding: wedding,
    p_commitment: commitment,
    p_amount_minor: 600_000,
    p_number: "KEEP",
  });
  await rpc(owner, "record_payment", {
    p_wedding: wedding,
    p_kind: "charge",
    p_amount_minor: 250_000,
    p_paid_on: "2026-01-02",
    p_commitment: commitment,
    p_invoice: invoice,
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/budget/bookings/${commitment}/amend`);
  await page.getByLabel(/^Total you're committing to/).fill("13000");
  await page.getByLabel("Cost 1").selectOption({ index: 1 });
  await page
    .getByLabel(/^Amount \(USD\)/)
    .first()
    .fill("13000");
  await page.getByLabel(/signed or explicitly agreed/).check();
  await page.getByRole("button", { name: "Save the amended booking" }).click();

  await expect(figure(page, "Contract")).toHaveText("$13,000.00");
  await expect(figure(page, "Invoiced")).toHaveText("$6,000.00");
  await expect(figure(page, "Paid so far")).toHaveText("$2,500.00");
  await expect(page.getByText("For invoice KEEP")).toBeVisible();
  await expect(page.getByText("$3,500.00 of it not paid yet.")).toBeVisible();
  expect(
    await scalar(
      `select count(*)::int as v from public.invoices i join public.commitments c on c.id = i.commitment_id
        where i.wedding_id=$1 and c.status='active'`,
      [wedding],
    ),
  ).toBe(1);
});

test("a viewer sees invoices read-only", async ({ page }) => {
  const { owner, wedding, commitment } = await seed("inv-viewer");
  await rpc(owner, "create_invoice", {
    p_wedding: wedding,
    p_commitment: commitment,
    p_amount_minor: 600_000,
    p_number: "VIEW",
  });
  const viewer = await appUser("inv-viewer-user");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/plan/budget/bookings/${commitment}`);
  await expect(page.getByText("Invoice VIEW")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add this invoice" })).toHaveCount(0);
  await expect(page.getByText("Entered by mistake?")).toHaveCount(0);
});

test("the booking page with invoices passes axe and reflows at 320px and 1280px", async ({
  page,
}) => {
  const { owner, wedding, commitment } = await seed("inv-a11y");
  const invoice = await rpc<string>(owner, "create_invoice", {
    p_wedding: wedding,
    p_commitment: commitment,
    p_amount_minor: 600_000,
    p_number: "AN-INVOICE-NUMBER-LONG-ENOUGH-TO-NEED-WRAPPING-ON-A-PHONE",
    p_due_on: "2026-12-01",
    p_note: "A note about this invoice that is long enough to wrap on a narrow screen.",
  });
  await rpc(owner, "create_invoice", {
    p_wedding: wedding,
    p_commitment: commitment,
    p_amount_minor: 900_000,
    p_number: "second",
  });
  await rpc(owner, "record_payment", {
    p_wedding: wedding,
    p_kind: "charge",
    p_amount_minor: 100_000,
    p_paid_on: "2026-01-02",
    p_commitment: commitment,
    p_invoice: invoice,
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${wedding}/plan/budget/bookings/${commitment}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `booking@${width}: ${x.id}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `booking@${width} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `test-results/screenshots/${width}/invoices-booking.png`,
      fullPage: true,
    });
  }
});
