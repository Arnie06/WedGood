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

// REL-03: budget costs count from replies. Drives the real app against the local Supabase stack.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for budget count specs");
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

const figure = (page: Page, label: string) =>
  page
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");

/** A Reception with three invited guests who have not answered, a guest target of 100, and a Food category. */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Counts Wedding", guests: 100 });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception" },
    }),
  );
  const guests: string[] = [];
  for (const name of ["Ada Example", "Bo Example", "Cy Example"]) {
    guests.push(
      await rpc<string>(owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } })),
    );
  }
  const created = await rpc<{ o_invitation_id: string }[]>(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: reception,
      p_groups: [{ guestIds: guests, householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [sha(randomBytes(32).toString("base64url"))],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  const members = await rpc<{ id: string; guest_id: string }[]>(
    adminClient()
      .from("invitation_members")
      .select("id, guest_id")
      .eq("invitation_id", created[0]!.o_invitation_id),
  );
  const category = await rpc<string>(
    owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Catering and bar" }),
  );
  const reply = (i: number, status: "accepted" | "declined") =>
    rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: members.find((m) => m.guest_id === guests[i])!.id,
        p_status: status,
        p_reason: "test",
      }),
    );
  return { owner, w, reception, category, reply };
}

test("a new per-guest cost counts the reception and follows replies; the guest target is still there", async ({
  page,
}) => {
  const f = await setup("count-flow");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/budget`);

  await page.getByRole("button", { name: "Add a cost" }).click();
  const add = page.getByRole("dialog", { name: "Add a cost" });
  await add.getByLabel(/^What is this cost/).fill("Dinner");
  await add.getByLabel(/^Category/).selectOption({ label: "Catering and bar" });
  await add.getByLabel(/^How is it priced/).selectOption("per_guest");
  await add.getByLabel(/^Price per guest/).fill("95");
  // New per-guest costs start on the reception's planning number (ADR-031 D1).
  await expect(add.getByLabel(/^Which guest count/)).toHaveValue("event_plan");
  await expect(add.getByLabel(/^Which event/)).toHaveValue(f.reception);
  await add.getByRole("button", { name: "Add cost" }).click();
  await expect(add).toBeHidden();

  // Three invited and still deciding: planning number 3.
  await expect(page.getByText("$95.00 × 3 guests · Reception planning number")).toBeVisible();
  await expect(figure(page, "Forecast")).toHaveText("$285.00");

  // Replies move the cost, with no edit to the budget.
  await f.reply(0, "accepted");
  await f.reply(1, "declined");
  await page.reload();
  await expect(page.getByText("$95.00 × 2 guests · Reception planning number")).toBeVisible();
  await expect(figure(page, "Forecast")).toHaveText("$190.00");

  // A cost that predates replies (no source sent) keeps counting the guest target: no change on upgrade.
  await rpc(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: f.category,
      p_name: "Late-night snack",
      p_cost_mode: "per_guest",
      p_amount_minor: 1_000,
    }),
  );
  await page.reload();
  await expect(page.getByText("$10.00 × 100 guests")).toBeVisible();
  await expect(figure(page, "Forecast")).toHaveText("$1,190.00");
  await expect(
    page.getByText(/Per-guest costs that count your guest target use 100/),
  ).toBeVisible();

  // Switch the dinner to the guest target from its edit tray.
  await page.getByRole("button", { name: "Edit Dinner" }).click();
  const edit = page.getByRole("dialog", { name: "Edit cost" });
  await expect(edit.getByLabel(/^Which guest count/)).toHaveValue("event_plan");
  await edit.getByLabel(/^Which guest count/).selectOption("typed");
  await edit.getByLabel(/^How many guests/).fill("80");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("$95.00 × 80 guests · typed")).toBeVisible();
  await expect(figure(page, "Forecast")).toHaveText("$8,600.00");
});

test("a planned attendance prices the cost before anyone replies, and replies are tracked against it", async ({
  page,
}) => {
  const f = await setup("count-plan");
  await rpc(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: f.category,
      p_name: "Dinner",
      p_cost_mode: "per_guest",
      p_amount_minor: 9_500,
      p_count_source: "event_plan",
      p_count_event: f.reception,
    }),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);

  // No plan yet: the cost follows replies (3 invited) and asks for a plan.
  await page.goto(`/app/${f.w}/plan/budget`);
  await expect(page.getByTestId("plan-tracking")).toContainText("No plan yet");
  await expect(figure(page, "Forecast")).toHaveText("$285.00");

  // Set the plan on the event page: 120 expected guests.
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await page.getByRole("button", { name: "Edit event" }).click();
  const edit = page.getByRole("dialog", { name: "Edit event" });
  await edit.getByLabel("Planned attendance", { exact: true }).fill("120");
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("dialog", { name: "Edit event" })).toHaveCount(0);

  // Three invited, nobody answered: priced at the plan, with the tally beside it.
  await page.goto(`/app/${f.w}/plan/budget`);
  await expect(page.getByText("$95.00 × 120 guests · Reception plan")).toBeVisible();
  await expect(figure(page, "Forecast")).toHaveText("$11,400.00");
  await expect(page.getByTestId("plan-tracking")).toHaveText(
    "Plan: 120 guests, $11,400.00. So far: 3 guests, 117 below plan (−$11,115.00).",
  );
  await page.getByText("How the forecast is built").click();
  await expect(page.getByTestId("plan-summary")).toContainText(
    "$11,400.00 planned, $285.00 at today's replies ($11,115.00 below plan)",
  );

  // Mark the invitations complete: the cost follows replies alone, and the plan is still there.
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await page.getByRole("button", { name: "Edit event" }).click();
  const again = page.getByRole("dialog", { name: "Edit event" });
  await again.getByLabel(/All invitations for this event are out/).check();
  await again.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("dialog", { name: "Edit event" })).toHaveCount(0);
  await page.goto(`/app/${f.w}/plan/budget`);
  await expect(page.getByText("$95.00 × 3 guests · Reception planning number")).toBeVisible();
  await expect(figure(page, "Forecast")).toHaveText("$285.00");
  await expect(page.getByTestId("plan-tracking")).toHaveText(
    "Plan: 120 guests, $11,400.00. Replies: 3 guests, 117 below plan (−$11,115.00).",
  );
});

test("an event with nobody invited leaves the cost unknown, not zero", async ({ page }) => {
  const f = await setup("count-empty");
  const brunch = await rpc<string>(
    f.owner.client.rpc("create_event", {
      p_wedding: f.w,
      p_event: { name: "Brunch", kind: "brunch" },
    }),
  );
  await rpc(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: f.category,
      p_name: "Brunch buffet",
      p_cost_mode: "per_guest",
      p_amount_minor: 4_000,
      p_count_source: "event_plan",
      p_count_event: brunch,
    }),
  );
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/budget`);
  await expect(page.getByText("No one invited yet")).toBeVisible();
  await expect(page.getByText(/nobody is invited to Brunch yet/)).toBeVisible();
  await expect(figure(page, "Forecast")).toHaveText("At least $0.00");
  await expect(page.getByText(/1 cost has no amount yet/)).toBeVisible();
});

test("a viewer sees the cost follow replies but not the count, until the owner shares guest totals", async ({
  page,
}) => {
  const f = await setup("count-viewer");
  await rpc(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: f.category,
      p_name: "Dinner",
      p_cost_mode: "per_guest",
      p_amount_minor: 9_500,
      p_count_source: "event_plan",
      p_count_event: f.reception,
    }),
  );
  const viewer = await appUser("count-viewer-member");
  const raw = randomBytes(32).toString("base64url");
  await rpc(
    f.owner.client.rpc("create_collaborator_invite", {
      p_wedding: f.w,
      p_email: viewer.email,
      p_role: "viewer",
      p_token_hash: sha(raw),
    }),
  );
  await rpc(viewer.client.rpc("redeem_collaborator_invite", { p_token_hash: sha(raw) }));

  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/budget`);
  // The amount follows replies for everyone ...
  await expect(figure(page, "Forecast")).toHaveText("$285.00");
  // ... but the count and its arithmetic are not shown.
  await expect(page.getByText("$95.00 per guest, based on replies to Reception")).toBeVisible();
  await expect(page.getByText(/× 3 guests/)).toHaveCount(0);
  await expect(page.getByText(/planning number/)).toHaveCount(0);

  await rpc(f.owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
  await page.reload();
  await expect(page.getByText("$95.00 × 3 guests · Reception planning number")).toBeVisible();
});

test("the cost form and list have no accessibility violations and do not overflow at 320 and 1280", async ({
  page,
}) => {
  const f = await setup("count-a11y");
  await rpc(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: f.category,
      p_name: "Dinner",
      p_cost_mode: "per_guest",
      p_amount_minor: 9_500,
      p_min_qty: 120,
      p_count_source: "event_plan",
      p_count_event: f.reception,
    }),
  );
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/plan/budget`);
    await expect(page.getByText(/minimum 120 applies/)).toBeVisible();
    const open = async () => {
      await page.getByRole("button", { name: "Edit Dinner" }).click();
      const dialog = page.getByRole("dialog", { name: "Edit cost" });
      await expect(dialog.getByLabel(/^Which event/)).toHaveValue(f.reception);
      return dialog;
    };
    await page.screenshot({
      path: `test-results/screenshots/${width}/budget-counts-list.png`,
      fullPage: true,
    });
    const dialog = await open();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}px`,
    ).toBe(true);
    await page.screenshot({ path: `test-results/screenshots/${width}/budget-counts-form.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("the plan and tracking lines and the event form's new switch are accessible and fit at 320 and 1280", async ({
  page,
}) => {
  const f = await setup("count-plan-a11y");
  await rpc(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: f.category,
      p_name: "Dinner",
      p_cost_mode: "per_guest",
      p_amount_minor: 9_500,
      p_count_source: "event_plan",
      p_count_event: f.reception,
    }),
  );
  const v = await rpc<{ version: number }[]>(
    adminClient().from("events").select("version").eq("id", f.reception),
  );
  await rpc(
    f.owner.client.rpc("update_event", {
      p_wedding: f.w,
      p_event_id: f.reception,
      p_expected_version: v[0]!.version,
      p_event: { name: "Reception", kind: "reception", targetAttendance: 120 },
    }),
  );
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/plan/budget`);
    await expect(page.getByTestId("plan-tracking")).toBeVisible();
    await page.screenshot({
      path: `test-results/screenshots/${width}/budget-plan-tracking.png`,
      fullPage: true,
    });
    await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
    await page.getByRole("button", { name: "Edit event" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit event" });
    await expect(dialog.getByLabel(/All invitations for this event are out/)).not.toBeChecked();
    await dialog.getByLabel(/All invitations for this event are out/).scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/screenshots/${width}/event-form-plan.png` });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});

// UX-10: the event page lists the costs this event's guests price, read from the budget.
test("the event page shows the costs it prices, follows replies, and leaves other events empty", async ({
  page,
}) => {
  const f = await setup("event-budget");
  const brunch = await rpc<string>(
    f.owner.client.rpc("create_event", {
      p_wedding: f.w,
      p_event: { name: "Brunch", kind: "brunch" },
    }),
  );
  const item = (name: string, extra: Record<string, unknown>) =>
    rpc(
      f.owner.client.rpc("create_budget_item", {
        p_wedding: f.w,
        p_category: f.category,
        p_name: name,
        p_cost_mode: "per_guest",
        p_amount_minor: 9_500,
        ...extra,
      }),
    );
  await item("Dinner", { p_count_source: "event_plan", p_count_event: f.reception });
  await item("Late-night snack", { p_amount_minor: 1_000 }); // guest target: belongs to no event
  await item("Brunch buffet", { p_count_source: "event_plan", p_count_event: brunch });
  await rpc(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: f.category,
      p_name: "Cake",
      p_cost_mode: "fixed",
      p_amount_minor: 50_000,
    }),
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  const card = page.getByTestId("event-budget");
  await expect(card.getByRole("heading", { name: "Budget" })).toBeVisible();
  // Only the Reception's own per-guest cost, priced by its three invited guests, as on the budget page.
  const rows = card.getByTestId("event-budget-list").getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Dinner");
  await expect(rows.first()).toContainText("$285.00");
  await expect(rows.first()).toContainText("$95.00 × 3 guests · Reception planning number");
  await expect(rows.first()).toContainText("Catering and bar");
  await expect(card).not.toContainText("Late-night snack");
  await expect(card).not.toContainText("Brunch buffet");
  await expect(card).not.toContainText("Cake");

  // A reply moves it with no edit to the budget.
  await f.reply(0, "accepted");
  await f.reply(1, "declined");
  await page.reload();
  await expect(card).toContainText("$190.00");
  await expect(card).toContainText("$95.00 × 2 guests · Reception planning number");

  // The link goes to the budget, which shows the same figure.
  await card.getByRole("link", { name: /Open the budget/ }).click();
  await expect(page).toHaveURL(new RegExp(`/app/${f.w}/plan/budget$`));
  await expect(page.getByText("$95.00 × 2 guests · Reception planning number")).toBeVisible();

  // An event nobody's cost counts says so, never a made-up figure. Brunch has nobody invited yet.
  await page.goto(`/app/${f.w}/plan/events/${brunch}`);
  await expect(page.getByTestId("event-budget-list").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("event-budget")).toContainText("No one invited yet");
  const empty = await rpc<string>(
    f.owner.client.rpc("create_event", {
      p_wedding: f.w,
      p_event: { name: "Rehearsal", kind: "rehearsal" },
    }),
  );
  await page.goto(`/app/${f.w}/plan/events/${empty}`);
  await expect(page.getByTestId("event-budget-empty")).toContainText(
    "No cost is priced by this event's guests yet",
  );
});

test("a viewer sees the event's cost but no counts until the owner shares guest totals", async ({
  page,
}) => {
  const f = await setup("event-budget-viewer");
  await rpc(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: f.category,
      p_name: "Dinner",
      p_cost_mode: "per_guest",
      p_amount_minor: 9_500,
      p_count_source: "event_plan",
      p_count_event: f.reception,
    }),
  );
  const viewer = await appUser("event-budget-viewer-member");
  const raw = randomBytes(32).toString("base64url");
  await rpc(
    f.owner.client.rpc("create_collaborator_invite", {
      p_wedding: f.w,
      p_email: viewer.email,
      p_role: "viewer",
      p_token_hash: sha(raw),
    }),
  );
  await rpc(viewer.client.rpc("redeem_collaborator_invite", { p_token_hash: sha(raw) }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  const card = page.getByTestId("event-budget");
  await expect(card).toContainText("$285.00");
  await expect(card).toContainText("$95.00 per guest, based on replies to Reception");
  await expect(card).not.toContainText("× 3 guests");

  await rpc(f.owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
  await page.reload();
  await expect(card).toContainText("$95.00 × 3 guests · Reception planning number");
});

test("the event budget card is accessible and fits at 320, 390 and 1280", async ({ page }) => {
  const f = await setup("event-budget-a11y");
  await rpc(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: f.category,
      p_name: "Dinner with a rather long name to check that the row wraps instead of overflowing",
      p_cost_mode: "per_guest",
      p_amount_minor: 9_500,
      p_min_qty: 120,
      p_count_source: "event_plan",
      p_count_event: f.reception,
    }),
  );
  await signInViaUi(page, f.owner);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
    const card = page.getByTestId("event-budget");
    await expect(card).toContainText("minimum 120 applies");
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/screenshots/${width}/event-budget-card.png`,
      fullPage: true,
    });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, `axe at ${width}px`).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}px`,
    ).toBe(true);
  }
});
