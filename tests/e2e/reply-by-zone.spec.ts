import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { endOfLocalDay, instantToLocal } from "../../src/domain/timeline/zoned";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  withSuperuser,
  type TestUser,
} from "../integration/helpers";

// UX-04: a reply-by date closes at the end of that day in the event's zone, and both pages show it
// on that clock, naming the zone for a viewer who is elsewhere.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for RSVP specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";
const ZONE = "Asia/Tokyo";

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

async function toReview(page: Page, path: string) {
  await page.goto(path);
  await page
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await page.getByRole("button", { name: "Next" }).click();
  // UX-07: the optional notes step comes next for anyone attending; skip it.
  await expect(
    page.getByRole("heading", { level: 2, name: /Anything we should know/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Check your reply/ })).toBeVisible();
}

test("reply-by closes at the end of the day in the event's zone and is shown on that clock", async ({
  browser,
}) => {
  const owner = await appUser("reply-zone");
  const wedding = await createWedding(owner, { name: "Alex & Morgan (example)" });
  const guestRes = await owner.client.rpc("create_guest", {
    p_wedding: wedding,
    p_guest: { name: "Ada Example" },
  });
  if (guestRes.error) throw new Error(guestRes.error.message);
  const eventRes = await owner.client.rpc("create_event", {
    p_wedding: wedding,
    p_event: { name: "Reception", kind: "reception" },
  });
  if (eventRes.error) throw new Error(eventRes.error.message);
  const eventId = eventRes.data as string;
  // The wedding stays on its default zone; only the event is in Tokyo.
  await withSuperuser((db) =>
    db.query("update public.events set time_zone = $1 where id = $2", [ZONE, eventId]),
  );

  const replyBy = instantToLocal(new Date(Date.now() + 20 * 86_400_000), ZONE).date;
  const expected = endOfLocalDay(replyBy, ZONE)!;
  const shown = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(expected);
  const shownLong = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(expected);

  // The planner is in Tokyo too, so the zone is not repeated next to the date.
  const plannerCtx = await browser.newContext({ timezoneId: ZONE });
  const page = await plannerCtx.newPage();
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests/invitations`);
  await page.getByRole("button", { name: "Invite guests", exact: true }).click();
  await expect(page.getByText(/Closes at the end of that day, Japan/)).toBeVisible();
  await page.getByLabel("Ada Example").check();
  await page.getByLabel("Reply by").fill(replyBy);
  await page.getByRole("button", { name: "Create invitation links" }).click();
  await expect(page.getByText(/Nothing has been sent/)).toBeVisible();
  const link = await page.getByLabel(/^Private link for/).inputValue();
  const path = new URL(link).pathname;

  const stored = await withSuperuser(
    async (db) =>
      (await db.query("select deadline from public.invitations where event_id = $1", [eventId]))
        .rows[0].deadline as Date,
  );
  expect(stored.toISOString()).toBe(expected.toISOString());

  await page.keyboard.press("Escape");
  await page.reload();
  const summary = page.getByText(/Link works until/);
  await expect(summary).toContainText(`reply by ${shown}`);
  await expect(summary).not.toContainText("Japan");

  // A guest in London sees Tokyo's date and is told whose clock it is.
  const londonCtx = await browser.newContext({ timezoneId: "Europe/London" });
  const london = await londonCtx.newPage();
  await toReview(london, path);
  await expect(london.getByText(/^Please reply by/)).toHaveText(
    new RegExp(`^Please reply by ${shownLong} \\(Japan[^)]*Time\\)\\.$`),
  );

  // A guest in Tokyo sees the same date without the zone.
  const tokyoCtx = await browser.newContext({ timezoneId: ZONE });
  const tokyo = await tokyoCtx.newPage();
  await toReview(tokyo, path);
  await expect(tokyo.getByText(/^Please reply by/)).toHaveText(`Please reply by ${shownLong}.`);

  await Promise.all([plannerCtx.close(), londonCtx.close(), tokyoCtx.close()]);
});
