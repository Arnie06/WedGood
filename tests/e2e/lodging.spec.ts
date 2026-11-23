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

// UX-17 lodging (L1). The couple adds a hotel and a room block, records the hotel's pickup report,
// sees the possible attrition charge beside (not in) the budget forecast, sets where guests stay
// without dragging, and publishes hotels on the guest website with the rate hidden. Drives the real
// app against the local Supabase stack; GUEST_LODGING=on in the E2E env. Synthetic names only.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for lodging specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const NAMES = ["Ada Example", "Bo Example"];

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

/** A wedding with a Reception, Ada and Bo attending, and an "Accommodation" budget category. */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Lodging Wedding" });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  const ids: string[] = [];
  for (const name of NAMES) {
    ids.push(
      await rpc<string>(owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } })),
    );
  }
  await rpc(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: reception,
      p_groups: [{ guestIds: ids, householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [sha(randomBytes(32).toString("base64url"))],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  const members = await rpc<{ id: string }[]>(
    adminClient().from("invitation_members").select("id").eq("event_id", reception),
  );
  for (const m of members) {
    await rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: m.id,
        p_status: "accepted",
        p_reason: "Told us in person",
      }),
    );
  }
  await rpc(owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Accommodation" }));
  return { owner, w };
}

async function checkPage(page: Page, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, `${name} axe`).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${name} overflow`).toBeLessThanOrEqual(0);
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: `test-results/screenshots/${width}/${name}.png`, fullPage: true });
}

test("a hotel, a room block, a pickup report, the budget card, stays and the website", async ({
  page,
  browser,
}) => {
  const f = await setup("lodging-flow");
  await page.setViewportSize({ width: 390, height: 900 });
  await signInViaUi(page, f.owner);

  await page.goto(`/app/${f.w}/plan`);
  await page.getByRole("link", { name: "Lodging" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Lodging" })).toBeVisible();

  // Add a hotel (shown to guests, rate hidden by default).
  await page.getByRole("button", { name: "Add a hotel" }).click();
  const hotelTray = page.getByRole("dialog", { name: "Add a hotel" });
  await hotelTray.getByLabel(/^Hotel name/).fill("Harbour Inn");
  await hotelTray.getByLabel(/^Address/).fill("1 Quay Street");
  await hotelTray.getByLabel(/^Hotel website/).fill("http://not-secure.example");
  await hotelTray.getByRole("button", { name: "Add hotel" }).click();
  await expect(hotelTray.getByText("Links must start with https://")).toBeVisible();
  await hotelTray.getByLabel(/^Hotel website/).fill("https://inn.example.com");
  await hotelTray.getByRole("button", { name: "Add hotel" }).click();
  await expect(hotelTray).toBeHidden();
  const hotel = page.getByTestId("hotel-Harbour Inn");
  await expect(hotel).toContainText("Shown to guests");
  await expect(hotel).toContainText("Rate hidden");

  // Add a room block; a bad room count is explained and the typed details are kept.
  await hotel.getByRole("button", { name: "Add a room block" }).click();
  const blockTray = page.getByRole("dialog", { name: "Add a room block" });
  await blockTray.getByLabel(/^First night/).fill("2027-06-11");
  await blockTray.getByLabel(/^Check-out day/).fill("2027-06-13");
  await blockTray.getByLabel(/^Rooms held each night/).fill("0");
  await blockTray.getByLabel(/^Group rate per night/).fill("189.50");
  await blockTray.getByLabel(/^Rooms you may leave unbooked/).fill("20");
  await blockTray.getByLabel(/^Book by/).fill("2027-05-10");
  await blockTray.getByLabel(/^Booking code for guests/).fill("SMITHWED");
  await blockTray.getByLabel(/^Budget category/).selectOption({ label: "Accommodation" });
  await blockTray.getByRole("button", { name: "Add block" }).click();
  await expect(blockTray.getByText(/Enter how many rooms are held/)).toBeVisible();
  await expect(blockTray.getByLabel(/^Group rate per night/)).toHaveValue("189.50");
  await checkPage(page, "lodging-block-tray@390");
  await blockTray.getByLabel(/^Rooms held each night/).fill("20");
  await blockTray.getByRole("button", { name: "Add block" }).click();
  await expect(blockTray).toBeHidden();
  const block = hotel.getByTestId("lodging-block");
  await expect(block).toContainText("20 rooms × 2 nights = 40 room-nights");
  await expect(block).toContainText("32 room-nights booked by guests");
  await expect(block).toContainText("Unknown: no pickup report");
  await expect(block).toContainText("$6,064.00"); // if no one books: 32 × 189.50

  // The hotel's pickup report turns the possible charge into a figure.
  await block.getByRole("button", { name: "Pickup report" }).click();
  const pickup = page.getByRole("dialog", { name: "Hotel pickup report" });
  await pickup.getByLabel(/^Room-nights booked/).fill("41");
  await pickup.getByRole("button", { name: "Save report" }).click();
  await expect(pickup.getByText(/more than the 40 room-nights held/)).toBeVisible();
  await pickup.getByLabel(/^Room-nights booked/).fill("26");
  await pickup.getByRole("button", { name: "Save report" }).click();
  await expect(pickup).toBeHidden();
  await expect(block).toContainText("$1,137.00 (6 room-nights short)");

  // Where guests stay, without dragging.
  await page.getByRole("button", { name: "Set where guests stay" }).click();
  const stays = page.getByRole("dialog", { name: "Set where guests stay" });
  await stays.getByLabel(/^Staying at/).selectOption({ label: "Harbour Inn" });
  await stays.getByLabel("Ada Example").check();
  await stays.getByLabel("Bo Example").check();
  await stays.getByRole("button", { name: "Save for 2 guests" }).click();
  await expect(stays).toBeHidden();
  await expect(page.getByTestId("stay-summary")).toContainText("2 at Harbour Inn");
  await expect(hotel.getByTestId("hotel-guest-count")).toContainText("2 attending guests say");
  await checkPage(page, "lodging@390");
  const csv = await page.request.get(`/app/${f.w}/plan/lodging/export`);
  expect(csv.status()).toBe(200);
  const text = await csv.text();
  expect(text).toContain("Ada Example,,Harbour Inn,You");
  expect(text).not.toMatch(/SMITHWED|189|attrition/i);

  // Budget: beside the forecast, never in it.
  await page.goto(`/app/${f.w}/plan/budget`);
  const card = page.getByTestId("possible-costs");
  await expect(
    page.getByRole("heading", { name: "Possible costs, not in your forecast" }),
  ).toBeVisible();
  await expect(card).toContainText("Now: $1,137.00");
  await expect(card).toContainText("Accommodation");
  await checkPage(page, "budget-possible-costs@390");

  // Website: hotels shown, the rate hidden, never rooms or pickup.
  await page.goto(`/app/${f.w}/website`);
  await page.getByLabel(/^Title/).fill("Lodging Wedding");
  await page.getByLabel(/Show the hotels you marked for guests/).check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByLabel(/Show the hotels you marked for guests/)).toBeChecked();
  const slug = `lodging-${randomUUID().slice(0, 8)}`;
  await page.getByLabel(/^Web address/).fill(slug);
  await page.getByRole("checkbox", { name: /I've previewed the saved draft/ }).check();
  await page.getByRole("button", { name: "Publish website" }).click();
  await expect(page.getByText(/Published\. Your website is now public/)).toBeVisible();

  const visitor = await (
    await browser.newContext({ viewport: { width: 320, height: 800 } })
  ).newPage();
  await visitor.goto(`/w/${slug}`);
  const where = visitor.getByRole("region", { name: "Where to stay" });
  await expect(where).toContainText("Harbour Inn");
  await expect(where).toContainText("Booking code: SMITHWED");
  await expect(where).toContainText("Book by May 10, 2027");
  await expect(where).not.toContainText("189");
  await expect(where).not.toContainText(/room-nights|attrition|pickup/i);
  await checkPage(visitor, "site-hotels@320");

  // Showing the rate is a change in Lodging; the editor says the public page needs publishing again.
  await page.goto(`/app/${f.w}/plan/lodging`);
  await hotel.getByRole("button", { name: "Edit" }).first().click();
  const edit = page.getByRole("dialog", { name: "Edit hotel" });
  await edit.getByLabel(/Show the nightly rate to guests/).check();
  await edit.getByRole("button", { name: "Save hotel" }).click();
  await expect(edit).toBeHidden();
  await page.goto(`/app/${f.w}/website`);
  await expect(
    page.getByText(/Hotel details changed in Lodging since you last published/),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /I've previewed the saved draft/ }).check();
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByText(/Published\. Your website is now public/)).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByRole("region", { name: "Where to stay" })).toContainText(
    "Group rate $189.50 a night",
  );
});

test("a viewer sees the possible charge on the Budget page but not Lodging", async ({ page }) => {
  const f = await setup("lodging-viewer");
  const hotel = await rpc<string>(
    f.owner.client.rpc("add_lodging_hotel", { p_wedding: f.w, p_hotel: { name: "Harbour Inn" } }),
  );
  await rpc(
    f.owner.client.rpc("add_lodging_block", {
      p_wedding: f.w,
      p_hotel_id: hotel,
      p_block: {
        checkIn: "2027-06-11",
        checkOut: "2027-06-12",
        roomsPerNight: 10,
        nightlyRateMinor: 10_000,
        attritionAllowedBp: 0,
      },
    }),
  );
  const viewer = await appUser("lodging-viewer-2");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      f.w,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/budget`);
  await expect(page.getByTestId("possible-costs")).toContainText("If no one books: $1,000.00");
  await expect(page.getByRole("link", { name: "Update pickup reports in Lodging" })).toHaveCount(0);
  await page.goto(`/app/${f.w}/plan`);
  await expect(page.getByRole("link", { name: "Lodging", exact: true })).toHaveCount(0);
  await page.goto(`/app/${f.w}/plan/lodging`);
  await expect(page.getByText(/limited to people who manage guests/)).toBeVisible();
  await expect(page.getByText("Ada Example")).toHaveCount(0);
});

test("the Lodging page passes axe and reflows at 320 and 1280px", async ({ page }) => {
  const f = await setup("lodging-a11y");
  const hotel = await rpc<string>(
    f.owner.client.rpc("add_lodging_hotel", {
      p_wedding: f.w,
      p_hotel: { name: "A Rather Long Hotel Name By The Harbour And Gardens", showToGuests: true },
    }),
  );
  await rpc(
    f.owner.client.rpc("add_lodging_block", {
      p_wedding: f.w,
      p_hotel_id: hotel,
      p_block: {
        label: "King rooms",
        checkIn: "2027-06-11",
        checkOut: "2027-06-13",
        roomsPerNight: 12,
      },
    }),
  );
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/plan/lodging`);
    await expect(page.getByTestId("lodging-block")).toContainText(
      "Unknown: add the attrition terms",
    );
    await checkPage(page, `lodging-unknowns@${width}`);
  }
});
