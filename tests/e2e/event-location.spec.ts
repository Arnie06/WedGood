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

// REL-06: venue spaces and one place per event. Drives the real app against the local stack.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for event location specs");
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
 * Reception with 3 invited (2 attending, 1 waiting: planning number 3), one 8-seat table and an
 * agenda place that names the barn. Venues: Old Barn (140, Terrace seats 110) and Rose Hall
 * (90, Library seats 2).
 */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Place Wedding", tz: "America/New_York" });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  const barn = await rpc<string>(
    owner.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "venue",
      p_category: "venue",
      p_name: "Old Barn",
      p_seated_capacity: 140,
    }),
  );
  const hall = await rpc<string>(
    owner.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "venue",
      p_category: "venue",
      p_name: "Rose Hall",
      p_seated_capacity: 90,
    }),
  );
  const terrace = await rpc<string>(
    owner.client.rpc("create_venue_space", {
      p_wedding: w,
      p_candidate: barn,
      p_name: "Terrace",
      p_seated_capacity: 110,
    }),
  );
  const library = await rpc<string>(
    owner.client.rpc("create_venue_space", {
      p_wedding: w,
      p_candidate: hall,
      p_name: "Library",
      p_seated_capacity: 2,
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
  for (const g of guests.slice(0, 2)) {
    await rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: members.find((m) => m.guest_id === g)!.id,
        p_status: "accepted",
        p_reason: "test",
      }),
    );
  }
  const layout = await rpc<string>(
    owner.client.rpc("ensure_seating_layout", { p_wedding: w, p_event_id: reception }),
  );
  await rpc(
    owner.client.rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: "Table 1",
      p_capacity: 8,
    }),
  );
  const dinner = await rpc<string>(
    owner.client.rpc("create_timeline_item", {
      p_wedding: w,
      p_event: reception,
      p_title: "Dinner",
      p_starts_at: "2027-06-12T22:00:00Z",
      p_location: "Old Barn terrace",
    }),
  );
  return { owner, w, reception, barn, hall, terrace, library, dinner };
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

test("choose a venue and space, see the fit, then move it and review what changes first", async ({
  page,
}) => {
  const f = await setup("loc-flow");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);

  await expect(page.getByTestId("where-empty")).toContainText("No place chosen yet.");
  await page.getByRole("button", { name: "Choose a place" }).click();
  let dialog = page.getByRole("dialog", { name: /Where is Reception/ });
  // The space picker waits for a venue.
  await expect(dialog.getByLabel("Space at this venue")).toBeDisabled();
  await dialog.getByLabel("Venue", { exact: true }).selectOption({ label: "Old Barn" });
  await dialog.getByLabel("Space at this venue").selectOption({ label: "Terrace (seats 110)" });
  await expect(dialog.getByTestId("location-impact")).toContainText("3 of 110 fits.");
  await dialog.getByRole("button", { name: "Save place" }).click();
  await expect(page.getByText("Place saved.")).toBeVisible();

  const summary = page.getByTestId("where-summary");
  await expect(summary).toContainText("Old Barn");
  await expect(summary).toContainText("Terrace");
  await expect(summary).toContainText("Room for 110 (from the space).");
  await expect(page.getByTestId("where-fit")).toContainText("Fits 3 of 110");

  // Move to the Library: the review lists tables, the planning number and the agenda place.
  await page.getByRole("button", { name: "Change place" }).click();
  dialog = page.getByRole("dialog", { name: /Where is Reception/ });
  await dialog.getByLabel("Venue", { exact: true }).selectOption({ label: "Rose Hall" });
  await expect(
    dialog.getByText("The space was cleared because you changed the venue."),
  ).toBeVisible();
  await dialog.getByLabel("Space at this venue").selectOption({ label: "Library (seats 2)" });
  const impact = dialog.getByTestId("location-impact");
  await expect(impact).toContainText(
    "Your tables seat 8, which is 6 more than the new place holds (2).",
  );
  await expect(impact).toContainText("short by 1");
  await expect(impact).toContainText("1 agenda place names Old Barn.");
  await dialog.getByLabel(/Also change those agenda places to Rose Hall/).check();
  await dialog.getByRole("button", { name: "Save place" }).click();
  await expect(page.getByText("Place saved. 1 agenda place updated.")).toBeVisible();

  await expect(summary).toContainText("Rose Hall");
  await expect(summary).toContainText("Library");
  await expect(page.getByTestId("where-fit")).toContainText(
    "Short by 1: planning for 3, room for 2",
  );
  const item = await rpc<{ location: string }>(
    adminClient().from("timeline_items").select("location").eq("id", f.dinner).single(),
  );
  expect(item.location).toBe("Rose Hall terrace");

  // The seating header shows both numbers and warns about the gap.
  await page.goto(`/app/${f.w}/seating/${f.reception}`);
  await expect(page.getByTestId("room-capacity")).toHaveText("Tables seat 8 · Library seats 2");
  await expect(
    page.getByText(/Your tables have 8 seats, which is more than the 2 Library holds\./),
  ).toBeVisible();
});

test("a removed space is shown as no longer at the venue, and the picker starts clean", async ({
  page,
}) => {
  const f = await setup("loc-stale");
  await rpc(
    f.owner.client.rpc("set_event_location", {
      p_wedding: f.w,
      p_event: f.reception,
      p_expected_version: 0,
      p_candidate: f.hall,
      p_space: f.library,
    }),
  );
  await rpc(
    f.owner.client.rpc("archive_venue_space", {
      p_wedding: f.w,
      p_space: f.library,
      p_expected_version: 1,
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  const summary = page.getByTestId("where-summary");
  await expect(summary).toContainText("Library (no longer at this venue)");
  await expect(summary).toContainText("Choose a current place to compare capacity.");
  await expect(page.getByTestId("where-fit")).toHaveCount(0);

  await page.getByRole("button", { name: "Change place" }).click();
  const dialog = page.getByRole("dialog", { name: /Where is Reception/ });
  await expect(dialog.getByText(/Library \(no longer at this venue\)/)).toBeVisible();
  await expect(dialog.getByLabel("Space at this venue")).toHaveValue("");
  await dialog.getByRole("button", { name: "Save place" }).click();
  await expect(page.getByText("Place saved.")).toBeVisible();
  await expect(summary).not.toContainText("no longer at this venue");
  // The whole venue now gives Rose Hall's own capacity.
  await expect(summary).toContainText("Room for 90 (from the venue).");
});

test("add, edit and remove a space on the venue page", async ({ page }) => {
  const f = await setup("loc-spaces");
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/discover/${f.barn}`);

  const spaces = page.getByTestId("spaces");
  await expect(spaces).toContainText("Terrace");
  await expect(spaces).toContainText("Seats 110");

  await page.getByRole("button", { name: "Add a space" }).click();
  let dialog = page.getByRole("dialog", { name: /Add a space at Old Barn/ });
  await dialog.getByRole("button", { name: "Add space" }).click();
  await expect(dialog.getByText("Add a name for this space.")).toBeVisible();
  await dialog.getByLabel(/Space name/).fill("Terrace");
  await dialog.getByLabel("Seated capacity").fill("20");
  await dialog.getByRole("button", { name: "Add space" }).click();
  await expect(dialog.getByText("This venue already has a space with that name.")).toBeVisible();
  await dialog.getByLabel(/Space name/).fill("Loft");
  await dialog.getByLabel("Seated capacity").fill("0");
  await dialog.getByRole("button", { name: "Add space" }).click();
  await expect(dialog.getByText(/between 1 and 100000/)).toBeVisible();
  await dialog.getByLabel("Seated capacity").fill("");
  await dialog.getByRole("button", { name: "Add space" }).click();
  await expect(spaces).toContainText("Loft");
  await expect(spaces).toContainText("Capacity not entered yet");

  await page.getByRole("button", { name: "Edit Loft" }).click();
  dialog = page.getByRole("dialog", { name: "Edit Loft" });
  await dialog.getByLabel("Seated capacity").fill("45");
  await dialog.getByRole("button", { name: "Save space" }).click();
  await expect(spaces).toContainText("Seats 45");

  await page.getByRole("button", { name: "Edit Loft" }).click();
  await page
    .getByRole("dialog", { name: "Edit Loft" })
    .getByRole("button", { name: "Remove this space" })
    .click();
  await expect(spaces).not.toContainText("Loft");
});

test("a viewer sees the place and spaces but cannot change them, and the fit stays with guest totals", async ({
  page,
}) => {
  const f = await setup("loc-viewer");
  await rpc(
    f.owner.client.rpc("set_event_location", {
      p_wedding: f.w,
      p_event: f.reception,
      p_expected_version: 0,
      p_candidate: f.barn,
      p_space: f.terrace,
    }),
  );
  const viewer = await join(f.owner, f.w, "viewer", "loc-viewer-member");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  const summary = page.getByTestId("where-summary");
  await expect(summary).toContainText("Old Barn");
  await expect(summary).toContainText("Terrace");
  await expect(summary).toContainText("Room for 110 (from the space).");
  await expect(page.getByTestId("where-fit")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Change place|Choose a place/ })).toHaveCount(0);

  await page.goto(`/app/${f.w}/discover/${f.barn}`);
  await expect(page.getByTestId("spaces")).toContainText("Terrace");
  await expect(page.getByRole("button", { name: "Add a space" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Edit Terrace/ })).toHaveCount(0);
  await expect(page.getByTestId("held-here")).toContainText("Reception");
});

test("accessible and within the screen at 320 and 1280, trays included", async ({ page }) => {
  test.setTimeout(90_000); // slow when other specs share the machine
  const f = await setup("loc-a11y");
  await rpc(
    f.owner.client.rpc("set_event_location", {
      p_wedding: f.w,
      p_event: f.reception,
      p_expected_version: 0,
      p_candidate: f.barn,
      p_space: f.terrace,
    }),
  );
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["event-where", `/app/${f.w}/plan/events/${f.reception}`],
      ["venue-spaces", `/app/${f.w}/discover/${f.barn}`],
    ] as const) {
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
        path: `test-results/screenshots/${width}/${name}.png`,
        fullPage: true,
      });
    }
    // The location tray with a review showing.
    await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
    await page.getByRole("button", { name: "Change place" }).click();
    const dialog = page.getByRole("dialog", { name: /Where is Reception/ });
    await dialog.getByLabel("Venue", { exact: true }).selectOption({ label: "Rose Hall" });
    await dialog.getByLabel("Space at this venue").selectOption({ label: "Library (seats 2)" });
    await expect(dialog.getByTestId("location-impact")).toBeVisible();
    // Wait out the slide-in, then check the tray sits inside the screen.
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return box ? box.x + box.width : Infinity;
      })
      .toBeLessThanOrEqual(width);
    expect((await dialog.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    const results = await new AxeBuilder({ page })
      .include("dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `tray@${width}: ${x.id}`)).toEqual([]);
    await page.screenshot({ path: `test-results/screenshots/${width}/event-where-tray.png` });
    await page.keyboard.press("Escape");
  }
});
