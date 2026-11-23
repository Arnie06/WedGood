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

// UX-13: the Home "Replies" strip, from event_demand. Drives the real app against the local stack.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for reply strip specs");
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
 * A Reception (12 Jun 2027) with three guests, reply by 1 May 2027 (Chicago): one attending, one
 * not, one waiting. A Ceremony nobody is invited to, which the strip leaves out.
 */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Replies Wedding", tz: "America/Chicago" });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Ceremony", kind: "ceremony", localDate: "2027-06-12" },
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
      p_expires_at: "2027-06-01T05:00:00Z",
      p_deadline: "2027-05-02T04:59:59Z",
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
  for (const [i, status] of [
    [0, "accepted"],
    [1, "declined"],
  ] as const) {
    await rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: members.find((m) => m.guest_id === guests[i])!.id,
        p_status: status,
        p_reason: "test",
      }),
    );
  }
  return { owner, w, reception };
}

test("the owner sees replies per event with the reply date and can open who is waiting", async ({
  page,
}) => {
  const f = await setup("strip-owner");
  await page.setViewportSize({ width: 390, height: 900 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}`);

  const card = page.getByRole("region", { name: "Replies" });
  await expect(card).toBeVisible();
  const bar = card.getByRole("progressbar", { name: "Reception" });
  await expect(bar).toHaveAttribute("aria-valuetext", "2 of 3 replied");
  await expect(bar).toHaveAttribute("aria-valuenow", "2");
  await expect(bar).toHaveAttribute("aria-valuemax", "3");
  await expect(card.getByText(/^1 waiting · reply by May 1, 2027/)).toBeVisible();
  // Nobody is invited to the Ceremony, so it has no row.
  await expect(card.getByRole("progressbar", { name: "Ceremony" })).toHaveCount(0);

  await card.getByRole("link", { name: "See who's waiting for Reception" }).click();
  await page.waitForURL(/\/guests\?event=.*&reply=waiting/);
  await expect(page.getByText("Cy Example")).toBeVisible();
  await expect(page.getByText("Ada Example")).toHaveCount(0);
  await expect(page.getByText("Bo Example")).toHaveCount(0);
});

test("a viewer sees no strip until the owner shares guest totals, then counts without dates", async ({
  page,
}) => {
  const f = await setup("strip-viewer");
  const viewer = await appUser("strip-viewer-member");
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
  await page.goto(`/app/${f.w}`);
  await expect(page.getByRole("heading", { name: "Replies Wedding" })).toBeVisible();
  await expect(page.getByTestId("home-replies")).toHaveCount(0);

  await rpc(f.owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
  await page.reload();
  const card = page.getByRole("region", { name: "Replies" });
  await expect(card.getByRole("progressbar", { name: "Reception" })).toHaveAttribute(
    "aria-valuetext",
    "2 of 3 replied",
  );
  await expect(card.getByText(/^1 waiting$/)).toBeVisible();
  // Reply dates live on invitations, which only the owner and partner can read.
  await expect(card.getByText(/reply by/)).toHaveCount(0);
  // The guest list is private, so the row leads to the event page instead.
  await expect(card.getByRole("link", { name: /See who's waiting/ })).toHaveCount(0);
  await card.getByRole("link", { name: "Open the event page for Reception" }).click();
  await page.waitForURL(new RegExp(`/plan/events/${f.reception}$`));
});

test("the strip has no accessibility violations and fits at 320, 390 and 1280", async ({
  page,
}) => {
  const f = await setup("strip-a11y");
  const longName = "A Rather Long Welcome Drinks Evening By The Harbour";
  await rpc(adminClient().from("events").update({ name: longName }).eq("id", f.reception));
  await signInViaUi(page, f.owner);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}`);
    await expect(page.getByRole("progressbar", { name: longName })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('[data-testid="home-replies"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
