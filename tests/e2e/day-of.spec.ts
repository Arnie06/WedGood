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
  throw new Error("CI must provide the local Supabase stack for day-of specs");
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

async function setup(label: string) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, { name: "Day Of", tz: "America/New_York" });
  const { data, error } = await owner.client.rpc("create_event", {
    p_wedding: wedding,
    p_event: { name: "Reception", kind: "reception" },
  });
  if (error) throw new Error(error.message);
  return { owner, wedding, event: data as string };
}

async function addItem(
  page: Page,
  f: { title: string; date: string; start: string; end?: string; endDate?: string; who?: string },
) {
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add to agenda" }) });
  await expect(async () => {
    await form.getByLabel(/^What happens/).fill(f.title);
    await form.getByLabel(/^Date/).first().fill(f.date);
    await form.getByLabel(/^Starts/).fill(f.start);
    if (f.end) await form.getByLabel(/^Ends/).fill(f.end);
    if (f.endDate) await form.getByLabel(/^End date/).fill(f.endDate);
    if (f.who) await form.getByLabel(/^Someone else in charge/).fill(f.who);
    await page.waitForTimeout(300);
    await expect(form.getByLabel(/^What happens/)).toHaveValue(f.title);
  }).toPass();
  await form.getByRole("button", { name: "Add to agenda" }).click();
}

test("build an agenda in the wedding's time zone, in order, with a resource-conflict heads-up", async ({
  page,
}) => {
  const { owner, wedding, event } = await setup("dayof-build");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/day-of`);
  await page.getByRole("link", { name: /Open the agenda/ }).click();
  await expect(page.getByRole("heading", { name: "Reception", level: 1 })).toBeVisible();
  await expect(page.getByText(/Nothing on this agenda yet/)).toBeVisible();

  // Added out of order; the agenda sorts chronologically.
  await addItem(page, {
    title: "Cake cutting",
    date: "2027-06-12",
    start: "19:30",
    who: "Maid of Honor",
  });
  await expect(page.getByRole("heading", { name: "Cake cutting" })).toBeVisible({ timeout: 15000 });
  await addItem(page, {
    title: "Toasts",
    date: "2027-06-12",
    start: "19:00",
    end: "20:00",
    who: "maid of honor",
  });
  await expect(page.getByRole("heading", { name: "Toasts" })).toBeVisible();
  const titles = await page
    .getByRole("listitem")
    .getByRole("heading", { level: 3 })
    .allTextContents();
  expect(titles.slice(0, 2)).toEqual(["Toasts", "Cake cutting"]);
  await expect(page.getByText("7:00 PM – 8:00 PM")).toBeVisible();
  // Same named person at the same time: a note, not a block.
  await expect(page.getByRole("note").first()).toContainText("overlaps");

  // Stored as the instant for 19:00 Eastern daylight time.
  const stored = await withSuperuser(async (db) => {
    const r = await db.query(
      "select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc, timezone from public.timeline_items where wedding_id=$1 and title='Toasts'",
      [wedding],
    );
    return r.rows[0] as { utc: string; timezone: string };
  });
  expect(stored.timezone).toBe("America/New_York");
  expect(stored.utc).toBe("2027-06-12 23:00");

  // Cross-midnight with an explicit end date.
  await addItem(page, {
    title: "After party",
    date: "2027-06-12",
    start: "22:30",
    end: "01:00",
    endDate: "2027-06-13",
  });
  await expect(page.getByRole("heading", { name: "After party" })).toBeVisible();
  await expect(page.getByText(/10:30 PM – Sun 1:00 AM/)).toBeVisible();
  expect(event).toBeTruthy();
});

test("explains invalid times instead of guessing", async ({ page }) => {
  const { owner, wedding, event } = await setup("dayof-invalid");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/day-of/${event}`);

  await addItem(page, { title: "Gap", date: "2027-03-14", start: "02:30" });
  await expect(page.getByText(/doesn't exist on this date/)).toBeVisible();
  await expect(page.getByLabel(/^What happens/)).toHaveValue("Gap");

  await addItem(page, { title: "Backwards", date: "2027-06-12", start: "22:00", end: "01:00" });
  await expect(page.getByText(/end can't be before the start/)).toBeVisible();
  const n = await withSuperuser(
    async (db) =>
      (
        await db.query("select count(*)::int n from public.timeline_items where wedding_id=$1", [
          wedding,
        ])
      ).rows[0].n,
  );
  expect(n).toBe(0);
});

test("edit and remove an item; a stale edit is refused", async ({ page }) => {
  const { owner, wedding, event } = await setup("dayof-edit");
  await owner.client.rpc("create_timeline_item", {
    p_wedding: wedding,
    p_event: event,
    p_title: "Ceremony",
    p_starts_at: "2027-06-12T20:00:00Z",
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/day-of/${event}`);
  await expect(page.getByText("4:00 PM").first()).toBeVisible();

  await page.getByText(/^Edit/).click();
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Save changes" }) });
  await expect(form.getByLabel(/^Starts/)).toHaveValue("16:00");
  await expect(async () => {
    await form.getByLabel(/^What happens/).fill("Vows");
    await page.waitForTimeout(300);
    await expect(form.getByLabel(/^What happens/)).toHaveValue("Vows");
  }).toPass();

  // Someone else saves first.
  await withSuperuser((db) =>
    db.query("update public.timeline_items set version = version + 1 where wedding_id=$1", [
      wedding,
    ]),
  );
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Someone changed this item/)).toBeVisible();

  await page.reload();
  await page.getByText(/^Edit/).click();
  const edit = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Save changes" }) });
  await expect(async () => {
    await edit.getByLabel(/^What happens/).fill("Vows");
    await page.waitForTimeout(300);
    await expect(edit.getByLabel(/^What happens/)).toHaveValue("Vows");
  }).toPass();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: "Vows" })).toBeVisible();

  await page.getByRole("button", { name: "Remove from agenda" }).click();
  await expect(page.getByText(/Nothing on this agenda yet/)).toBeVisible();
});

test("a viewer reads the agenda and handoff but gets no edit controls", async ({ page }) => {
  const { owner, wedding, event } = await setup("dayof-viewer");
  await owner.client.rpc("create_timeline_item", {
    p_wedding: wedding,
    p_event: event,
    p_title: "Ceremony",
    p_starts_at: "2027-06-12T20:00:00Z",
    p_contact: "Coordinator Sam",
  });
  const viewer = await appUser("dayof-viewer-b");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/plan/day-of/${event}`);
  await expect(page.getByRole("heading", { name: "Ceremony" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to agenda" })).toHaveCount(0);
  await expect(page.getByText(/^Edit/)).toHaveCount(0);

  await page.getByRole("link", { name: "Printable coordinator handoff" }).click();
  await expect(page.getByRole("heading", { name: /Day Of: Reception/ })).toBeVisible();
  await expect(page.getByText(/Contact: Coordinator Sam/)).toBeVisible();
  await expect(page.getByText(/not live status/)).toBeVisible();
});

test("agenda pages pass axe and do not overflow at 320 and 1280px", async ({ page }) => {
  const { owner, wedding, event } = await setup("dayof-a11y");
  await owner.client.rpc("create_timeline_item", {
    p_wedding: wedding,
    p_event: event,
    p_title:
      "A very long agenda item title that needs to wrap on small screens without breaking layout",
    p_starts_at: "2027-06-12T20:00:00Z",
    p_ends_at: "2027-06-12T21:00:00Z",
    p_location: "The Long-Named Garden Pavilion and Terrace",
    p_contact: "Coordinator with a long name 555-0100 coordinator@example.test",
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, name] of [
      [`/app/${wedding}/plan/day-of`, "day-of"],
      [`/app/${wedding}/plan/day-of/${event}`, "day-of-agenda"],
      [`/app/${wedding}/plan/day-of/${event}/handoff`, "day-of-handoff"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((v) => `${name}@${width}: ${v.id}`)).toEqual([]);
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
