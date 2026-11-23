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

// REL-10: needs attention. Drives the real app against the local stack.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for needs attention specs");
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

/**
 * A reception (capacity 2) with four invited guests, a locked caterer count of 3, a finalized
 * seating plan and a booked venue that no event uses. Then one waiting guest accepts and one
 * seated guest declines, so the list holds: over capacity, a guest without a seat, a seat that was
 * released, and the unused venue.
 */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Attention Wedding", tz: "America/New_York" });
  const event = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12", capacity: 2 },
    }),
  );
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
  const answer = (i: number, status: "accepted" | "declined") =>
    rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: members.find((m) => m.guest_id === guests[i])!.id,
        p_status: status,
        p_reason: "test",
      }),
    );
  for (const i of [0, 1, 2]) await answer(i, "accepted");

  // The caterer is told 3. Nobody has chosen a meal and there are none to choose.
  await rpc(
    owner.client.rpc("lock_guarantee", {
      p_wedding: w,
      p_event: event,
      p_count: 3,
      p_seen: { yes: 3, withoutMeal: 3, meals: [] },
    }),
  );

  // Seat the three and finalize.
  const layout = await rpc<string>(
    owner.client.rpc("ensure_seating_layout", { p_wedding: w, p_event_id: event }),
  );
  const table = await rpc<string>(
    owner.client.rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: "A",
      p_capacity: 8,
    }),
  );
  for (const i of [0, 1, 2]) {
    await rpc(
      owner.client.rpc("assign_guest_seat", {
        p_wedding: w,
        p_layout: layout,
        p_guest: guests[i]!,
        p_table: table,
      }),
    );
  }
  const rev = await withSuperuser(
    async (db) =>
      (await db.query("select revision from public.seating_layouts where id = $1", [layout]))
        .rows[0].revision as number,
  );
  await rpc(
    owner.client.rpc("finalize_seating_layout", {
      p_wedding: w,
      p_layout: layout,
      p_expected_revision: rev,
    }),
  );
  await answer(3, "accepted");
  await answer(0, "declined");

  // A booked venue that no event uses.
  const venue = await rpc<string>(
    owner.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "venue",
      p_category: "venue",
      p_name: "Old Barn",
    }),
  );
  const cat = await rpc<string>(
    owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Venue" }),
  );
  const item = await rpc<string>(
    owner.client.rpc("create_budget_item", {
      p_wedding: w,
      p_category: cat,
      p_name: "Venue fee",
      p_amount_minor: 900_000,
    }),
  );
  await rpc(
    owner.client.rpc("book_commitment", {
      p_wedding: w,
      p_candidate: venue,
      p_expected_candidate_version: 1,
      p_title: "Barn contract",
      p_amount_minor: 1_000_000,
      p_allocations: [{ itemId: item, amountMinor: 1_000_000 }],
      p_installments: [{ dueOn: "2027-01-15", amountMinor: 1_000_000 }],
      p_confirmed: true,
    }),
  );
  return { owner, w, event, answer };
}

/** The kinds in the open list (not the hidden one), in the order shown. */
const kindsOn = async (page: Page) =>
  page
    .getByTestId("attention-list")
    .getByTestId("attention-item")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));

test("owner: the list, dismiss and show again, handled, and the Event page", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await setup("at-owner");
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);

  // Home shows the top three, most urgent first, with a link to the rest.
  await page.goto(`/app/${f.w}`);
  const card = page.getByTestId("home-attention");
  await expect(card.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(card).toContainText("4 things need you.");
  expect(await kindsOn(page)).toEqual(["over_capacity", "seats_missing", "seats_released"]);
  await expect(card.getByTestId("attention-item").first()).toContainText(
    "Reception: more guests than the room holds",
  );
  await expect(card.getByTestId("attention-item").first()).toContainText(
    "Short by 1: planning for 3, room for 2",
  );
  await card.getByRole("link", { name: "See all 4" }).click();

  // The full list has all four, with the unused venue last.
  await expect(page.getByRole("heading", { name: "Needs attention", level: 1 })).toBeVisible();
  expect(await kindsOn(page)).toEqual([
    "over_capacity",
    "seats_missing",
    "seats_released",
    "venue_unused",
  ]);
  await expect(page.getByTestId("attention-list")).toContainText(
    "Old Barn is booked but no event uses it",
  );
  await expect(page.getByTestId("attention-list")).toContainText("1 guest without a seat");

  // Dismiss hides it, and it stays hidden after a reload.
  await page
    .getByRole("button", { name: /^Dismiss: Reception: more guests than the room holds/ })
    .click();
  await expect(page.getByTestId("attention-list").getByTestId("attention-item")).toHaveCount(3);
  await page.reload();
  expect(await kindsOn(page)).not.toContain("over_capacity");
  const hidden = page.getByTestId("attention-hidden-list");
  await expect(hidden).toContainText("more guests than the room holds");

  // Show again brings it back.
  await hidden.getByRole("button", { name: /^Show again:/ }).click();
  await expect(page.getByTestId("attention-hidden-list-empty")).toHaveText("Nothing is hidden.");
  expect(await kindsOn(page)).toContain("over_capacity");

  // A dismissed item comes back by itself when the condition changes (capacity 2 to 1).
  await page
    .getByRole("button", { name: /^Dismiss: Reception: more guests than the room holds/ })
    .click();
  await expect(page.getByTestId("attention-hidden-list")).toContainText(
    "more guests than the room",
  );
  const version = await withSuperuser(
    async (db) =>
      (await db.query("select version from public.events where id = $1", [f.event])).rows[0]
        .version as number,
  );
  await rpc(
    f.owner.client.rpc("update_event", {
      p_wedding: f.w,
      p_event_id: f.event,
      p_expected_version: version,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12", capacity: 1 },
    }),
  );
  await page.reload();
  expect(await kindsOn(page)).toContain("over_capacity");
  await expect(page.getByTestId("attention-list")).toContainText(
    "Short by 2: planning for 3, room for 1",
  );

  // Mark the stored item handled.
  await page.getByRole("button", { name: /^Mark handled:/ }).click();
  await expect(page.getByTestId("attention-list")).not.toContainText("a seat was released");
  await page.reload();
  expect(await kindsOn(page)).toEqual(["over_capacity", "seats_missing", "venue_unused"]);

  // The Event page lists this event's items only.
  await page.goto(`/app/${f.w}/plan/events/${f.event}`);
  const onEvent = page.getByTestId("event-attention");
  await expect(onEvent).toContainText("more guests than the room holds");
  await expect(onEvent).toContainText("1 guest without a seat");
  await expect(onEvent).not.toContainText("Old Barn");
});

test("a viewer sees only the items that carry no guest data, and cannot act on them", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const f = await setup("at-viewer");
  const viewer = await join(f.owner, f.w, "viewer", "at-v");
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}`);
  const card = page.getByTestId("home-attention");
  await expect(card).toContainText("1 thing needs you.");
  expect(await kindsOn(page)).toEqual(["venue_unused"]);
  await expect(card.getByRole("button", { name: /Dismiss/ })).toHaveCount(0);
  await expect(card).not.toContainText("more guests than the room holds");

  await page.goto(`/app/${f.w}/plan/attention`);
  expect(await kindsOn(page)).toEqual(["venue_unused"]);
  await expect(page.getByRole("heading", { name: "Hidden" })).toHaveCount(0);
  await expect(page.getByText("shown to the owner and partners only")).toBeVisible();
  await page.goto(`/app/${f.w}/plan/events/${f.event}`);
  await expect(page.getByTestId("event-attention")).toHaveCount(0);
});

test("a calm empty state when nothing needs attention", async ({ page }) => {
  const owner = await appUser("at-empty");
  const w = await createWedding(owner, { name: "Quiet Wedding" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${w}`);
  await expect(page.getByTestId("home-attention")).toContainText("Nothing needs you right now.");
  await page.goto(`/app/${w}/plan/attention`);
  await expect(page.getByTestId("attention-list-empty")).toHaveText("Nothing needs you right now.");
});

test("Home, the list and the Event page pass axe and reflow at 320px and 1280px", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const f = await setup("at-axe");
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [``, `/plan/attention`, `/plan/events/${f.event}`]) {
      await page.goto(`/app/${f.w}${path}`);
      await expect(page.getByTestId("attention-item").first()).toBeVisible();
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations, `axe ${path || "home"}@${width}`).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path || "home"}@${width} overflow`).toBeLessThanOrEqual(0);
    }
  }
});

// UX-12: the item drawer (W9). What happened, what it touches, a suggested fix and the history,
// read back from existing rows. Nothing new is stored.
test("owner: the Details drawer shows the fix and the history, and acts from inside", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const f = await setup("at-drawer");
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/attention`);

  // The released seat: one release so far.
  const details = page.getByRole("button", { name: /^Details: Reception: a seat was released/ });
  await details.click();
  const drawer = page.getByRole("dialog", { name: "Reception: a seat was released" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("What happened");
  await expect(drawer).toContainText("A guest lost their seat after you finalized");
  await expect(drawer).toContainText("The finalized seating plan, now out of date");
  await expect(drawer).toContainText("Review the plan, then finalize it again");
  await expect(drawer.getByTestId("attention-history")).toContainText("opened, 1 seat released");
  await expect(drawer.getByRole("link", { name: "Open the seating plan" })).toBeVisible();

  // Escape closes and returns focus to the Details button.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(details).toBeFocused();

  // A second release adds to the same item and to its history.
  await f.answer(1, "declined");
  await page.reload();
  await page.getByRole("button", { name: /^Details: Reception: 2 seats were released/ }).click();
  const drawer2 = page.getByRole("dialog", { name: "Reception: 2 seats were released" });
  await expect(drawer2.getByTestId("attention-history")).toContainText("2 seats released");

  // Mark handled from inside the drawer: it closes and the item leaves the list.
  await drawer2.getByRole("button", { name: /^Mark handled:/ }).click();
  await expect(drawer2).toBeHidden();
  await expect(page.getByTestId("attention-list")).not.toContainText("seats were released");

  // A computed item dismissed, then changed, says so in its history. Two attend now, so make the
  // room hold one, dismiss, then have the declined guest accept again (3 against 1).
  const version = await withSuperuser(
    async (db) =>
      (await db.query("select version from public.events where id = $1", [f.event])).rows[0]
        .version as number,
  );
  await rpc(
    f.owner.client.rpc("update_event", {
      p_wedding: f.w,
      p_event_id: f.event,
      p_expected_version: version,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12", capacity: 1 },
    }),
  );
  await page.reload();
  await page
    .getByRole("button", { name: /^Dismiss: Reception: more guests than the room holds/ })
    .click();
  await expect(page.getByTestId("attention-hidden-list")).toContainText(
    "more guests than the room",
  );
  await f.answer(1, "accepted");
  await page.reload();
  await page
    .getByTestId("attention-list")
    .getByRole("button", { name: /^Details: Reception: more guests than the room holds/ })
    .click();
  const history = page.getByRole("dialog").getByTestId("attention-history");
  await expect(history).toContainText("Back since then because it changed");
  await expect(history).toContainText("dismissed by you");
});

test("the drawer passes axe and fits at 320px and 1280px; a viewer sees a partial history", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const f = await setup("at-drawer-axe");
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/plan/attention`);
    await page.getByRole("button", { name: /^Details: Reception: a seat was released/ }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByTestId("attention-detail")).toBeVisible();
    await page.waitForTimeout(300);
    const axe = await new AxeBuilder({ page }).include("dialog").analyze();
    expect(axe.violations, `axe drawer@${width}`).toEqual([]);
    const box = await drawer.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width + 1, `drawer@${width} fits`).toBe(true);
  }

  const viewer = await join(f.owner, f.w, "viewer", "at-dv");
  await page.context().clearCookies();
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/attention`);
  await page.getByRole("button", { name: /^Details: Old Barn is booked/ }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("Events, capacity checks and the agenda");
  await expect(drawer.getByRole("button", { name: /Dismiss/ })).toHaveCount(0);
  await expect(drawer).toContainText("Who did what is shown to the owner and partners.");
});
