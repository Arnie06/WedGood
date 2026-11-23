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
  const wedding = await createWedding(owner, { name: "Calendar, Test", tz: "America/New_York" });
  const ev = await owner.client.rpc("create_event", {
    p_wedding: wedding,
    p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
  });
  if (ev.error) throw new Error(ev.error.message);
  const g = await owner.client.rpc("create_guest", {
    p_wedding: wedding,
    p_guest: { name: "Ada Example" },
  });
  if (g.error) throw new Error(g.error.message);
  const inv = await owner.client.rpc("create_invitations", {
    p_wedding: wedding,
    p_event_id: ev.data,
    p_groups: [{ guestIds: [g.data], householdId: null }],
    p_plus_one_quota: 0,
    p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    p_token_hashes: [randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")],
    p_idempotency_key: `key-${randomUUID()}`,
  });
  if (inv.error) throw new Error(inv.error.message);
  await withSuperuser(async (db) => {
    await db.query(
      "insert into public.timeline_items (wedding_id, event_id, title, starts_at, timezone, location, contact, notes) values ($1,$2,'Toasts','2027-06-12T23:00:00Z','America/New_York','Main hall; Floor 1','555-0100 SECRET-CONTACT','SECRET-NOTE'),($1,$2,'Dropped item','2027-06-12T20:00:00Z','America/New_York',null,null,null)",
      [wedding, ev.data],
    );
    await db.query(
      "update public.timeline_items set status='cancelled' where wedding_id=$1 and title='Dropped item'",
      [wedding],
    );
  });
  return { owner, wedding };
}

test("owner marks an invitation shared and the page never claims delivery", async ({ page }) => {
  const { owner, wedding } = await setup("deliv-mark");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests/invitations`);
  await expect(page.getByTestId("mail-status")).toContainText(
    "Email is in test mode and reaches no one",
  );
  await expect(page.getByText("Not shared yet")).toBeVisible();
  await page.getByRole("button", { name: /Mark as shared/ }).click();
  await expect(page.getByText(/Shared by you/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Mark as not shared/ })).toBeVisible();
  await expect(page.getByText(/Shared by you/)).not.toContainText(/deliver/i);
  await page.getByRole("button", { name: /Mark as not shared/ }).click();
  await expect(page.getByText("Not shared yet")).toBeVisible();
});

test("calendar download is a valid snapshot without private fields, and only for exporters", async ({
  page,
}) => {
  const { owner, wedding } = await setup("deliv-ics");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/day-of`);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: /Download calendar/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("wedding-calendar.ics");
  const path = await download.path();
  const text = (await import("node:fs")).readFileSync(path, "utf8");
  expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(text).toContain("X-WR-CALNAME:Calendar\\, Test");
  expect(text).toContain("DTSTART;VALUE=DATE:20270612");
  expect(text).toContain("SUMMARY:Reception");
  expect(text).toContain("DTSTART:20270612T230000Z");
  expect(text).toContain("LOCATION:Main hall\\; Floor 1");
  expect(text).not.toContain("Dropped item");
  expect(text).not.toContain("SECRET");

  const viewer = await appUser("deliv-viewer");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  const ctx = await page.context().browser()!.newContext();
  const vpage = await ctx.newPage();
  await signInViaUi(vpage, viewer);
  const res = await vpage.request.get(`/app/${wedding}/plan/calendar.ics`);
  expect(res.status()).toBe(404);
  await vpage.goto(`/app/${wedding}/plan/day-of`);
  await expect(vpage.getByRole("link", { name: /Download calendar/ })).toHaveCount(0);
  const anonCtx = await page.context().browser()!.newContext();
  const signedOut = await anonCtx.request.get(`/app/${wedding}/plan/calendar.ics`, {
    maxRedirects: 0,
  });
  expect(signedOut.status()).not.toBe(200);
  expect(await signedOut.text()).not.toContain("BEGIN:VCALENDAR");
  await anonCtx.close();
  await ctx.close();
});

test("invitations and calendar entry points have no axe violations or overflow", async ({
  page,
}) => {
  const { owner, wedding } = await setup("deliv-axe");
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [`/app/${wedding}/guests/invitations`, `/app/${wedding}/plan/day-of`]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations, `${path} @${width}`).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} @${width}`).toBeLessThanOrEqual(0);
    }
  }
});
