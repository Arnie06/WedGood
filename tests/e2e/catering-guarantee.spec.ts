import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  withSuperuser,
  type TestUser,
} from "../integration/helpers";

// REL-08: caterer count. Drives the real app against the local stack.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for caterer count specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");

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

async function rpc<T>(
  p: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T> {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

/**
 * A reception with Chicken and Veg, four invited guests (three attending, one waiting) and a
 * caterer assigned to it. Planning number: 3 attending + 1 waiting = 4.
 */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Catering Wedding", tz: "America/New_York" });
  const event = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  const meals: string[] = [];
  for (const name of ["Chicken", "Veg"]) {
    meals.push(
      await rpc<string>(
        owner.client.rpc("add_meal_option", { p_wedding: w, p_event_id: event, p_name: name }),
      ),
    );
  }
  const guests: string[] = [];
  for (let i = 0; i < 4; i++) {
    guests.push(
      await rpc<string>(
        owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name: `Guest ${i} Example` } }),
      ),
    );
  }
  const created = await rpc<{ o_invitation_id: string }[]>(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: event,
      p_groups: [{ guestIds: guests, householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [sha(randomBytes(32).toString("base64url"))],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  const members = await withSuperuser(
    async (db) =>
      (
        await db.query<{ id: string; guest_id: string }>(
          "select id, guest_id from public.invitation_members where invitation_id = $1",
          [created[0]!.o_invitation_id],
        )
      ).rows,
  );
  const memberOf = (i: number) => members.find((m) => m.guest_id === guests[i])!.id;
  const answer = (i: number, status: "accepted" | "declined", meal?: string) =>
    rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: memberOf(i),
        p_status: status,
        p_reason: "test",
        ...(meal && { p_meal_option_id: meal }),
      }),
    );
  await answer(0, "accepted", meals[0]);
  await answer(1, "accepted", meals[0]);
  await answer(2, "accepted", meals[1]);
  const caterer = await rpc<string>(
    owner.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "vendor",
      p_category: "caterer",
      p_name: "Fork & Spoon",
    }),
  );
  await rpc(
    owner.client.rpc("set_event_vendors", {
      p_wedding: w,
      p_event: event,
      p_add: [caterer],
      p_remove: [],
    }),
  );
  return { owner, w, event, meals, guests, caterer, answer };
}

type Setup = Awaited<ReturnType<typeof setup>>;
/** What the tray sends: today's replies for the event. */
async function previewFor(f: Setup) {
  const rows = await rpc<
    {
      event_id: string;
      yes: number;
      yes_without_meal: number;
      meals: { id: string; count: number }[];
    }[]
  >(f.owner.client.rpc("event_demand", { p_wedding: f.w }));
  const d = rows.find((r) => r.event_id === f.event)!;
  return {
    yes: d.yes,
    withoutMeal: d.yes_without_meal,
    meals: d.meals.map((m) => ({ id: m.id, count: m.count })),
  };
}
const lockFor = async (f: Setup, count: number, due?: string) =>
  rpc<string>(
    f.owner.client.rpc("lock_guarantee", {
      p_wedding: f.w,
      p_event: f.event,
      p_count: count,
      p_seen: await previewFor(f),
      ...(due && { p_due: due }),
    }),
  );

async function join(owner: TestUser, w: string, role: "viewer", label: string) {
  const user = await appUser(label);
  const raw = randomBytes(32).toString("base64url");
  await rpc(
    owner.client.rpc("create_collaborator_invite", {
      p_wedding: w,
      p_email: user.email,
      p_role: role,
      p_token_hash: sha(raw),
    }),
  );
  await rpc(user.client.rpc("redeem_collaborator_invite", { p_token_hash: sha(raw) }));
  return user;
}

test("lock the count, watch replies drift from it, then revise it with a reason", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const f = await setup("cg-flow");
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events/${f.event}`);

  await expect(page.getByTestId("guarantee-empty")).toContainText("No count locked yet");
  await page.getByRole("button", { name: "Lock the count" }).click();
  const dialog = page.getByRole("dialog", { name: /Caterer count for Reception/ });

  // Today's replies are in front of the person before the button.
  const preview = dialog.getByTestId("guarantee-preview");
  await expect(preview).toContainText("3 attending, 1 still waiting");
  await expect(preview).toContainText("Chicken: 2");
  await expect(preview).toContainText("Veg: 1");
  // The starting number is the planning number, and the sentence follows what is typed.
  await expect(dialog.getByLabel(/Count to give the caterer/)).toHaveValue("4");
  await expect(dialog.getByTestId("lock-sentence")).toHaveText(
    "You're telling the caterer 4 guests.",
  );
  await dialog.getByLabel(/Count to give the caterer/).fill("5");
  await expect(dialog.getByTestId("lock-sentence")).toHaveText(
    "You're telling the caterer 5 guests.",
  );
  await dialog.getByLabel(/Count to give the caterer/).fill("0");
  await expect(dialog.getByRole("button", { name: "Lock count" })).toBeDisabled();
  await dialog.getByLabel(/Count to give the caterer/).fill("5");
  await dialog.getByLabel("Caterer", { exact: true }).selectOption({ label: "Fork & Spoon" });
  await dialog.getByLabel(/Caterer needs it by/).fill("2027-05-20");
  await dialog.getByRole("button", { name: "Lock count" }).click();

  // The success state says nothing was sent and offers a package.
  const done = dialog.getByTestId("guarantee-done");
  await expect(done).toContainText("Caterer count locked.");
  await expect(done).toContainText("Nothing was sent to the caterer");
  await expect(done.getByRole("link", { name: "Make a caterer package" })).toHaveAttribute(
    "href",
    new RegExp(`/app/${f.w}/plan/packages/new\\?preset=caterer`),
  );
  await done.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const summary = page.getByTestId("guarantee-summary");
  await expect(summary).toContainText("5 guests");
  await expect(summary).toContainText("by you");
  await expect(summary).toContainText("Fork & Spoon");
  await expect(summary).toContainText(/The caterer needs it by May 20, 2027 \(\d+ days away\)\./);
  await expect(page.getByTestId("drift-note")).toContainText(
    "Locked 5 · now 3 attending (1 still waiting) · 2 more than are attending.",
  );

  // A guest cancels. The count stays; the note moves.
  await f.answer(0, "declined");
  await page.reload();
  await expect(page.getByTestId("guarantee-summary")).toContainText("5 guests");
  await expect(page.getByTestId("drift-note")).toContainText("Locked 5 · now 2 attending");

  // The same note shows on the seating and budget pages.
  await page.goto(`/app/${f.w}/seating/${f.event}`);
  await expect(page.getByTestId("seating-drift-note")).toContainText("Locked 5 · now 2 attending");
  await page.goto(`/app/${f.w}/plan/budget`);
  await expect(page.getByTestId("budget-drift")).toContainText("Reception");
  await expect(page.getByTestId("budget-drift-note")).toContainText("Locked 5 · now 2 attending");

  // Revise: a reason is required, and the old count stays in the history.
  await page.goto(`/app/${f.w}/plan/events/${f.event}`);
  await page.getByRole("button", { name: "Revise count" }).click();
  const rev = page.getByRole("dialog", { name: /Caterer count for Reception/ });
  await expect(rev.getByLabel(/Count to give the caterer/)).toHaveValue("5");
  await rev.getByLabel(/Count to give the caterer/).fill("3");
  await rev.getByRole("button", { name: "Save revised count" }).click();
  await expect(rev.getByRole("alert")).toContainText("Say why the count is changing");
  await rev.getByLabel(/Why is the count changing/).fill("Two guests cancelled");
  await rev.getByRole("button", { name: "Save revised count" }).click();
  await expect(rev.getByTestId("guarantee-done")).toContainText("Caterer count revised.");
  await rev.getByRole("button", { name: "Done" }).click();

  await expect(page.getByTestId("guarantee-summary")).toContainText("3 guests");
  await expect(page.getByTestId("drift-note")).toContainText("Locked 3 · now 2 attending");
  const history = page.getByTestId("guarantee-history");
  await history.getByText(/Count history/).click();
  await expect(history).toContainText("Revised from 5 to 3: Two guests cancelled");
});

/** A caterer booking for the Reception: a per-guest Dinner cost (minimum 5) counted by its replies. */
async function bookCaterer(f: Setup, minQty: number) {
  const category = await rpc<string>(
    f.owner.client.rpc("create_budget_category", { p_wedding: f.w, p_name: "Food" }),
  );
  const item = await rpc<string>(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: category,
      p_name: "Dinner",
      p_cost_mode: "per_guest",
      p_amount_minor: 9_500,
      p_min_qty: minQty,
      p_count_source: "event_yes",
      p_count_event: f.event,
    }),
  );
  const version = await withSuperuser(
    async (db) =>
      (
        await db.query<{ version: number }>("select version from public.candidates where id = $1", [
          f.caterer,
        ])
      ).rows[0]!.version,
  );
  const commitment = await rpc<string>(
    f.owner.client.rpc("book_commitment", {
      p_wedding: f.w,
      p_candidate: f.caterer,
      p_expected_candidate_version: version,
      p_title: "Fork & Spoon catering",
      p_amount_minor: 800_000,
      p_allocations: [{ itemId: item, amountMinor: 800_000 }],
      p_installments: [],
      p_confirmed: true,
    }),
  );
  return { commitment, item };
}

test("the card brings attending, the locked count, the booking's minimum, invoices and payments together", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const f = await setup("cg-breakdown");
  // Reply by the end of May 1 in New York.
  await withSuperuser((db) =>
    db.query("update public.invitations set deadline = $2 where event_id = $1", [
      f.event,
      "2027-05-02T03:59:59Z",
    ]),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  const eventUrl = `/app/${f.w}/plan/events/${f.event}`;

  // Nothing locked or booked yet: the rows say so, plainly.
  await page.goto(eventUrl);
  await expect(page.getByTestId("catering-attending")).toContainText(
    "3 (+ 1 waiting, reply by May 1",
  );
  await expect(page.getByTestId("guarantee-empty")).toBeVisible();
  await expect(page.getByTestId("catering-no-booking")).toContainText("No catering booking yet");

  // Book the caterer through a per-guest cost with a minimum of 5, lock 4.
  const { commitment } = await bookCaterer(f, 5);
  await rpc(
    f.owner.client.rpc("lock_guarantee", {
      p_wedding: f.w,
      p_event: f.event,
      p_count: 4,
      p_seen: await previewFor(f),
      p_candidate: f.caterer,
    }),
  );
  await page.reload();
  await expect(page.getByTestId("guarantee-summary")).toContainText("4 guests");
  await expect(page.getByTestId("guarantee-summary")).toContainText("by you · Fork & Spoon");
  const bookingRow = page.getByTestId("catering-booking");
  await expect(bookingRow).toContainText("Fork & Spoon catering · contract $8,000.00");
  await expect(bookingRow).toContainText("the chosen caterer");
  await expect(bookingRow.getByRole("link", { name: "Fork & Spoon catering" })).toHaveAttribute(
    "href",
    `/app/${f.w}/plan/budget/bookings/${commitment}`,
  );
  await expect(page.getByTestId("catering-minimum")).toContainText("5 · from the cost “Dinner”");
  await expect(page.getByTestId("catering-money")).toContainText("No invoices yet · Paid $0.00");
  await expect(page.getByTestId("catering-minimum-note")).toHaveText(
    "The locked count is 1 below the minimum of 5. The booking may still charge for 5.",
  );
  await expect(page.getByTestId("drift-note")).toContainText("Locked 4 · now 3 attending");

  // An invoice and a part payment, then a mistaken invoice that no longer counts.
  const invoice = await rpc<string>(
    f.owner.client.rpc("create_invoice", {
      p_wedding: f.w,
      p_commitment: commitment,
      p_amount_minor: 475_000,
      p_number: "FS-1",
    }),
  );
  await rpc(
    f.owner.client.rpc("record_payment", {
      p_wedding: f.w,
      p_kind: "charge",
      p_amount_minor: 200_000,
      p_paid_on: "2026-11-01",
      p_commitment: commitment,
      p_invoice: invoice,
    }),
  );
  const oops = await rpc<string>(
    f.owner.client.rpc("create_invoice", {
      p_wedding: f.w,
      p_commitment: commitment,
      p_amount_minor: 100_000,
      p_number: "OOPS",
    }),
  );
  await rpc(
    f.owner.client.rpc("void_invoice", {
      p_wedding: f.w,
      p_invoice: oops,
      p_reason: "Entered twice",
    }),
  );
  await page.reload();
  await expect(page.getByTestId("catering-money")).toHaveText(
    /Invoiced \$4,750\.00 · Paid \$2,000\.00/,
  );
  // The same figures as the booking page.
  await page.getByRole("link", { name: "Fork & Spoon catering" }).click();
  await expect(page).toHaveURL(new RegExp(`/plan/budget/bookings/${commitment}`));
  await expect(
    page.locator("dt", { hasText: /^Invoiced$/ }).locator("xpath=following-sibling::dd[1]"),
  ).toHaveText("$4,750.00");

  // Revising to the minimum clears the minimum note; nothing about the booking changed.
  await page.goto(eventUrl);
  await page.getByRole("button", { name: "Revise count" }).click();
  const rev = page.getByRole("dialog", { name: /Caterer count for Reception/ });
  await rev.getByLabel(/Count to give the caterer/).fill("5");
  await rev.getByLabel(/Why is the count changing/).fill("Contract minimum is 5");
  await rev.getByRole("button", { name: "Save revised count" }).click();
  await rev.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("guarantee-summary")).toContainText("5 guests");
  await expect(page.getByTestId("catering-minimum-note")).toHaveCount(0);
  await expect(page.getByTestId("catering-booking")).toContainText("contract $8,000.00");
});

test("more guests than the caterer was told gets a plain pointer to revise", async ({ page }) => {
  const f = await setup("cg-under");
  await lockFor(f, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events/${f.event}`);
  const note = page.getByTestId("drift-note");
  await expect(note).toContainText("1 more attending than the caterer was told");
  await expect(note).toHaveAttribute("data-state", "under");
  await expect(note.getByRole("link", { name: "Review the caterer count" })).toBeVisible();
});

test("a viewer sees no counts unless the owner shares totals, and can never lock or revise", async ({
  page,
}) => {
  const f = await setup("cg-viewer");
  await lockFor(f, 4);
  const viewer = await join(f.owner, f.w, "viewer", "cg-viewer-member");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/events/${f.event}`);
  await expect(page.getByRole("heading", { name: "Caterer count" })).toHaveCount(0);
  await expect(page.getByText("4 guests")).toHaveCount(0);
  await page.goto(`/app/${f.w}/plan/budget`);
  await expect(page.getByTestId("budget-drift")).toHaveCount(0);

  await rpc(f.owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
  await page.goto(`/app/${f.w}/plan/events/${f.event}`);
  await expect(page.getByTestId("guarantee-summary")).toContainText("4 guests");
  await expect(page.getByRole("button", { name: /Lock the count|Revise count/ })).toHaveCount(0);
  await page.goto(`/app/${f.w}/plan/budget`);
  await expect(page.getByTestId("budget-drift-note")).toContainText("Locked 4 · now 3 attending");
});

test("the caterer brief carries the locked count and its dates", async ({ page }) => {
  const f = await setup("cg-package");
  await lockFor(f, 7, "2027-05-20");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/packages/new`);
  await page.getByRole("link", { name: /Start with caterer brief/i }).click();
  await page.getByRole("button", { name: "Preview package" }).click();
  await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();
  await expect(page.getByText("Count for the caterer").first()).toBeVisible();
  await expect(page.getByText("May 20, 2027").first()).toBeVisible();
});

test("accessible and within the screen at 320 and 1280, trays included", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await setup("cg-a11y");
  await signInViaUi(page, f.owner);
  const axe = (include?: string) => {
    const b = new AxeBuilder({ page }).withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
    ]);
    return include ? b.include(include) : b;
  };
  const noOverflow = async (label: string) =>
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      `${label} overflow`,
    ).toBeLessThanOrEqual(0);

  // 320: the lock tray on an event with no count yet.
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/app/${f.w}/plan/events/${f.event}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Lock the count" }).click();
  let dialog = page.getByRole("dialog", { name: /Caterer count for Reception/ });
  await expect(dialog.getByTestId("guarantee-preview")).toBeVisible();
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box ? box.x + box.width : Infinity;
    })
    .toBeLessThanOrEqual(320);
  expect((await axe("dialog").analyze()).violations.map((x) => `lock tray@320: ${x.id}`)).toEqual(
    [],
  );
  await page.screenshot({ path: "test-results/screenshots/320/guarantee-lock-tray.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Lock, then revise, so the page has drift and a history to check.
  const id = await lockFor(f, 2);
  await rpc(
    f.owner.client.rpc("revise_guarantee", {
      p_wedding: f.w,
      p_guarantee: id,
      p_count: 6,
      p_seen: await previewFor(f),
      p_reason: "More family confirmed than the first count allowed for",
    }),
  );
  // A booking with a minimum above the count, so the breakdown rows and the minimum note are checked.
  await bookCaterer(f, 8);

  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["guarantee-event", `/app/${f.w}/plan/events/${f.event}`],
      ["guarantee-budget", `/app/${f.w}/plan/budget`],
      ["guarantee-seating", `/app/${f.w}/seating/${f.event}`],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (name === "guarantee-event") {
        await page
          .getByTestId("guarantee-history")
          .getByText(/Count history/)
          .click();
      }
      expect((await axe().analyze()).violations.map((x) => `${name}@${width}: ${x.id}`)).toEqual(
        [],
      );
      await noOverflow(`${name}@${width}`);
      await page.screenshot({
        path: `test-results/screenshots/${width}/${name}.png`,
        fullPage: true,
      });
    }
    await page.goto(`/app/${f.w}/plan/events/${f.event}`);
    await page.getByRole("button", { name: "Revise count" }).click();
    dialog = page.getByRole("dialog", { name: /Caterer count for Reception/ });
    await expect(dialog.getByLabel(/Why is the count changing/)).toBeVisible();
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return box ? box.x + box.width : Infinity;
      })
      .toBeLessThanOrEqual(width);
    expect(
      (await axe("dialog").analyze()).violations.map((x) => `revise tray@${width}: ${x.id}`),
    ).toEqual([]);
    await page.screenshot({ path: `test-results/screenshots/${width}/guarantee-revise-tray.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});
