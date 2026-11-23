import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  type TestUser,
} from "../integration/helpers";

// UX-05: the brief's late cancellation. A seated guest declines from their own link after the plan
// was finalized and the caterer count was locked; the guest's page then lists what was updated,
// what needs review and what did not change. Drives the real app against the local Supabase stack.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for guest consequences specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const ZONE = "America/New_York";

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
 * Reception: Ada and Bo attending with Fish, both seated at Table 6, plan finalized, caterer count
 * locked at 2, a per-guest Catering estimate counting the attending guests. Bo has their own link.
 */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Consequences Wedding", tz: ZONE });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  const fish = await rpc<string>(
    owner.client.rpc("add_meal_option", { p_wedding: w, p_event_id: reception, p_name: "Fish" }),
  );
  const ids: Record<string, string> = {};
  for (const name of ["Ada Example", "Bo Example"]) {
    ids[name] = await rpc<string>(
      owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } }),
    );
  }
  const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  await rpc(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: reception,
      p_groups: [
        { guestIds: [ids["Ada Example"]], householdId: null },
        { guestIds: [ids["Bo Example"]], householdId: null },
      ],
      p_plus_one_quota: 0,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: tokens.map(sha),
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  const members = await rpc<{ id: string; guest_id: string }[]>(
    adminClient().from("invitation_members").select("id, guest_id").eq("event_id", reception),
  );
  for (const name of ["Ada Example", "Bo Example"]) {
    await rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: members.find((m) => m.guest_id === ids[name])!.id,
        p_status: "accepted",
        p_reason: "Told us at the engagement party",
        p_meal_option_id: fish,
      }),
    );
  }
  const layout = await rpc<string>(
    owner.client.rpc("ensure_seating_layout", { p_wedding: w, p_event_id: reception }),
  );
  const table = await rpc<string>(
    owner.client.rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: "Table 6",
      p_capacity: 8,
    }),
  );
  for (const name of ["Ada Example", "Bo Example"]) {
    await rpc(
      owner.client.rpc("assign_guest_seat", {
        p_wedding: w,
        p_layout: layout,
        p_guest: ids[name],
        p_table: table,
      }),
    );
  }
  await rpc(owner.client.rpc("number_table_seats", { p_wedding: w, p_table: table }));
  const seat = await rpc<{ seat_number: number }>(
    adminClient()
      .from("seat_assignments")
      .select("seat_number")
      .eq("layout_id", layout)
      .eq("guest_id", ids["Bo Example"])
      .single(),
  );
  const { revision } = await rpc<{ revision: number }>(
    adminClient().from("seating_layouts").select("revision").eq("id", layout).single(),
  );
  await rpc(
    owner.client.rpc("finalize_seating_layout", {
      p_wedding: w,
      p_layout: layout,
      p_expected_revision: revision,
    }),
  );
  const fishCount = [{ id: fish, count: 2 }];
  await rpc(
    owner.client.rpc("lock_guarantee", {
      p_wedding: w,
      p_event: reception,
      p_count: 2,
      p_seen: { yes: 2, withoutMeal: 0, meals: fishCount },
    }),
  );
  const locked = await rpc<{ locked_at: string }>(
    adminClient()
      .from("catering_guarantees")
      .select("locked_at")
      .eq("event_id", reception)
      .eq("status", "locked")
      .single(),
  );
  const category = await rpc<string>(
    owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Food" }),
  );
  await rpc(
    owner.client.rpc("create_budget_item", {
      p_wedding: w,
      p_category: category,
      p_name: "Catering",
      p_cost_mode: "per_guest",
      p_amount_minor: 9_500,
      p_count_source: "event_yes",
      p_count_event: reception,
    }),
  );
  return {
    owner,
    w,
    reception,
    bo: ids["Bo Example"]!,
    boToken: tokens[1]!,
    boSeat: seat.seat_number,
    finalized: revision,
    lockedOn: new Date(locked.locked_at).toLocaleDateString("en-US", {
      dateStyle: "medium",
      timeZone: ZONE,
    }),
  };
}

/** Bo declines on their own RSVP page (the UX-03 stepper). */
async function boDeclines(page: Page, token: string) {
  await page.goto(`/rsvp/${token}`);
  await page.getByRole("button", { name: "Edit answers" }).click();
  await page.getByRole("group", { name: "Bo Example" }).getByLabel("Not attending").check();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Check your reply/ })).toBeVisible();
  await page.getByRole("button", { name: "Update my reply" }).click();
  await expect(
    page.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();
}

test("a late decline lists every consequence on the guest page", async ({ browser, page }) => {
  const f = await setup("conseq-late");
  const guest = await browser.newContext();
  await boDeclines(await guest.newPage(), f.boToken);
  await guest.close();

  await page.setViewportSize({ width: 390, height: 900 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/guests/${f.bo}`);
  await expect(
    page.getByRole("heading", { level: 2, name: "What the latest changes affected" }),
  ).toBeVisible();
  const card = page.getByTestId(`consequences-${f.reception}`);
  await expect(card.getByRole("heading", { level: 3, name: "Reception" })).toBeVisible();
  await expect(card).toContainText("Latest change: Attending → Not attending");
  await expect(card).toContainText("From the guest's own link.");

  await expect(card.getByTestId("consequences-updated").getByRole("listitem")).toHaveText([
    "Attending: 1 fewer, 1 now.",
    "Planning number: 1 fewer, 1 now.",
    "Fish: 1 fewer, 1 now.",
    "Per-guest estimates that count this event follow the new number: Catering.",
    `Seat ${f.boSeat} at Table 6 in the finalized plan is free again in the live plan.`,
  ]);
  const review = card.getByTestId("consequences-review");
  await expect(review.getByRole("listitem")).toHaveText([
    `The finalized seating plan (version ${f.finalized}) is out of date. Finalize it again before you print or share it. Open seating`,
    "Needs attention has an open “seats released” item for this event. Open Needs attention",
    "The caterer was told 2; 1 is attending now, 1 fewer. Check whether the count can still go down. Open the event",
  ]);
  await expect(card.getByTestId("consequences-unchanged").getByRole("listitem")).toHaveText([
    `The caterer count stays at 2, locked ${f.lockedOn}.`,
    `Finalized seating version ${f.finalized} is kept as it was.`,
    "Signed bookings, contracts, invoices and payments. A reply never changes these.",
  ]);

  // The links go where they say.
  await review.getByRole("link", { name: "Open seating" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/${f.w}/seating/${f.reception}$`));
});

test("the panel passes axe and fits at 320, 390 and 1280", async ({ browser, page }) => {
  const f = await setup("conseq-a11y");
  const guest = await browser.newContext();
  await boDeclines(await guest.newPage(), f.boToken);
  await guest.close();
  await signInViaUi(page, f.owner);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/guests/${f.bo}`);
    await expect(page.getByTestId(`consequences-${f.reception}`)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `guest-consequences@${width}: ${x.id}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `guest-consequences@${width} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `test-results/screenshots/${width}/guest-consequences.png`,
      fullPage: true,
    });
  }
});
