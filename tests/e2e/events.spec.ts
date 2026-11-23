import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
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
  throw new Error("CI must provide the local Supabase stack for event specs");
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

/** Ceremony (no guests) and Reception (3 invited, 2 attending, one seated, one agenda item). */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Events Wedding", tz: "America/New_York" });
  const ceremony = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Ceremony", kind: "ceremony", localDate: "2027-06-12" },
    }),
  );
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12", capacity: 100 },
    }),
  );
  const meal = await rpc<string>(
    owner.client.rpc("add_meal_option", { p_wedding: w, p_event_id: reception, p_name: "Chicken" }),
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
      p_plus_one_quota: 1,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [sha(randomBytes(32).toString("base64url"))],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  expect(created).toHaveLength(1);
  const members = await rpc<{ id: string; guest_id: string }[]>(
    adminClient()
      .from("invitation_members")
      .select("id, guest_id")
      .eq("invitation_id", created[0]!.o_invitation_id),
  );
  const memberOf = (g: string) => members.find((m) => m.guest_id === g)!.id;
  for (const [i, g] of guests.slice(0, 2).entries()) {
    await rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: memberOf(g),
        p_status: "accepted",
        p_reason: "test",
        ...(i === 0 && { p_meal_option_id: meal }),
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
      p_label: "Table 1",
      p_capacity: 8,
    }),
  );
  await rpc(
    owner.client.rpc("assign_guest_seat", {
      p_wedding: w,
      p_layout: layout,
      p_guest: guests[0]!,
      p_table: table,
    }),
  );
  await rpc(
    owner.client.rpc("create_timeline_item", {
      p_wedding: w,
      p_event: reception,
      p_title: "Cocktail hour",
      p_starts_at: "2027-06-12T21:00:00Z",
    }),
  );
  return { owner, w, ceremony, reception };
}

async function join(owner: TestUser, w: string, role: "viewer" | "partner", label: string) {
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

test("the event page pulls who, meals, seating and agenda together, and is reachable from Guests, Seating and Home", async ({
  page,
}) => {
  const f = await setup("event-hub");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);

  // From Home.
  await page.goto(`/app/${f.w}`);
  await page.getByRole("link", { name: "Reception", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/plan/events/${f.reception}$`));
  await expect(page.getByRole("heading", { name: "Reception", level: 1 })).toBeVisible();

  // Counts: 3 invited, 2 attending, 1 waiting; planning number is yes plus waiting until the reply date.
  const strip = page.getByTestId("count-strip");
  const figures = strip.getByLabel("Responses for Reception");
  await expect(figures).toContainText("Invited3");
  await expect(figures).toContainText("Attending2");
  await expect(figures).toContainText("Waiting1");
  await expect(figures).toContainText("Not attending0");
  await expect(page.getByTestId("planning-number")).toHaveText(
    /Planning for 3 people: 2 attending \+ 1 still waiting, not counting 1 plus-one place not named yet\./,
  );
  await expect(page.getByTestId("meal-totals")).toContainText("Chicken: 1");
  await expect(page.getByText("1 attending guest hasn't chosen a meal yet.")).toBeVisible();
  await expect(page.getByTestId("seating-totals")).toContainText(
    "1 of 2 attending guests have a seat. 1 still needs one.",
  );
  await expect(page.getByTestId("agenda-preview")).toContainText("Cocktail hour");
  // REL-07: with no vendor saved or assigned, the card says so and offers no empty assign button.
  await expect(page.getByRole("heading", { name: "Vendors at this event" })).toBeVisible();
  await expect(page.getByTestId("vendors-empty")).toContainText("No vendors assigned yet.");
  await expect(page.getByRole("button", { name: /Assign vendors/ })).toHaveCount(0);

  // From Guests and Seating.
  await page.goto(`/app/${f.w}/guests`);
  await page.getByRole("link", { name: "Events", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Events", level: 1 })).toBeVisible();
  await page.goto(`/app/${f.w}/seating/${f.reception}`);
  await page.getByRole("link", { name: "Event page" }).click();
  await expect(page).toHaveURL(new RegExp(`/plan/events/${f.reception}$`));

  // Links out to the editors.
  await expect(page.getByRole("link", { name: /Open the seating plan/ })).toHaveAttribute(
    "href",
    `/app/${f.w}/seating/${f.reception}`,
  );
  await expect(page.getByRole("link", { name: /Open the agenda/ })).toHaveAttribute(
    "href",
    `/app/${f.w}/plan/day-of/${f.reception}`,
  );
});

test("switch events with the keyboard, and edit an event on its page", async ({ page }) => {
  const f = await setup("event-switch");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);

  const nav = page.getByRole("navigation", { name: "Events" });
  await expect(nav.getByRole("link", { name: "Reception" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await nav.getByRole("link", { name: "Ceremony" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/plan/events/${f.ceremony}$`));
  await expect(page.getByRole("heading", { name: "Ceremony", level: 1 })).toBeVisible();
  await expect(page.getByText("No agenda yet. Add what happens and when.")).toBeVisible();
  await expect(page.getByText("No meal choices yet.")).toBeVisible();

  // Change how the Reception counts guests: the planning number follows.
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await page.getByRole("button", { name: "Edit event" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit event" });
  await dialog.getByLabel("Planning number").selectOption("yes");
  await dialog.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByTestId("planning-number")).toHaveText(
    /Planning for 2 people: 2 attending, not counting 1 still waiting/,
  );
  // Wait for the first tray to finish closing so only one dialog is in the page.
  await expect(page.getByRole("dialog", { name: "Edit event" })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit event" }).click();
  await page
    .getByRole("dialog", { name: "Edit event" })
    .getByLabel(/Also plan for plus-one places/)
    .check();
  await page
    .getByRole("dialog", { name: "Edit event" })
    .getByRole("button", { name: "Save event" })
    .click();
  await expect(page.getByTestId("planning-number")).toContainText("Planning for 3 people");

  // The invitations page shows the same numbers and no longer carries the edit tray.
  await page.goto(`/app/${f.w}/guests/invitations`);
  await expect(page.getByRole("button", { name: "Edit event" })).toHaveCount(0);
  await expect(page.getByTestId("planning-number").first()).toBeVisible();
  await page.getByRole("link", { name: /Open the event page for Reception/ }).click();
  await expect(page).toHaveURL(new RegExp(`/plan/events/${f.reception}$`));
});

test("a viewer sees only what their role allows, until the owner shares guest totals", async ({
  page,
}) => {
  const f = await setup("event-viewer");
  const viewer = await join(f.owner, f.w, "viewer", "event-viewer-member");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, viewer);

  await page.goto(`/app/${f.w}/plan/events`);
  await expect(page.getByRole("button", { name: "Add an event" })).toHaveCount(0);
  await expect(page.getByText("attending ·")).toHaveCount(0);
  await page.getByRole("link", { name: /Open the event page for Reception/ }).click();
  await expect(page.getByTestId("totals-hidden")).toBeVisible();
  await expect(page.getByTestId("count-strip")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Meals" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Seating" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit event" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Invitations and answers/ })).toHaveCount(0);
  await expect(page.getByTestId("agenda-preview")).toContainText("Cocktail hour");
  // The page never carries names.
  await expect(page.locator("body")).not.toContainText("Ada Example");

  // The viewer cannot change the setting.
  await page.goto(`/app/${f.w}/settings/members`);
  await expect(page.getByTestId("share-totals")).toContainText("Only an owner can change this.");
  await expect(page.getByRole("button", { name: /guest totals/ })).toHaveCount(0);

  // The owner turns sharing on from People and access.
  await page.context().clearCookies();
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/settings/members`);
  await page.getByRole("button", { name: "Let collaborators see guest totals" }).click();
  await expect(page.getByText("Collaborators can now see guest totals.")).toBeVisible();

  await page.context().clearCookies();
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await expect(page.getByTestId("count-strip")).toBeVisible();
  await expect(page.getByTestId("planning-number")).toContainText("Planning for 3 people");
  await expect(page.getByTestId("meal-totals")).toContainText("Chicken: 1");
  await expect(page.getByTestId("seating-totals")).toContainText("1 of 2");
  // Totals only: no links into the guest-level pages, and no names.
  await expect(page.getByRole("link", { name: /Open the seating plan/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Invitations and answers/ })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Ada Example");
  // The guest-level pages stay closed to them.
  await page.goto(`/app/${f.w}/guests/invitations`);
  await expect(page.getByText(/limited to the workspace owner/)).toBeVisible();
});

test("a partner can read totals but only the owner sees the sharing button", async ({ page }) => {
  const f = await setup("event-partner");
  const partner = await join(f.owner, f.w, "partner", "event-partner-member");
  await signInViaUi(page, partner);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await expect(page.getByTestId("count-strip")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit event" })).toBeVisible();
  await page.goto(`/app/${f.w}/settings/members`);
  await expect(page.getByTestId("share-totals")).toContainText("Only an owner can change this.");
});

test("the event pages have no accessibility violations and do not overflow at 320 and 1280", async ({
  page,
}) => {
  const f = await setup("event-a11y");
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["events-list", `/app/${f.w}/plan/events`],
      ["event-page", `/app/${f.w}/plan/events/${f.reception}`],
      ["event-page-empty", `/app/${f.w}/plan/events/${f.ceremony}`],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      for (const s of await page.locator("summary").all()) await s.click();
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
  // Edit tray at 320 stays inside the screen.
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await page.getByRole("button", { name: "Edit event" }).click();
  const box = await page.getByRole("dialog", { name: "Edit event" }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
});
