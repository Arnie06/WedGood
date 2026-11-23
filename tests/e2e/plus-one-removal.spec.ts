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

// UX-09: a guest can remove a plus-one they added. Real local stack (see rsvp-stepper.spec.ts).
// Every name is synthetic.
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

async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

/** Ada alone, invited to Reception with one plus-one place. */
async function seed(label: string) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, { name: "Removal (example)" });
  await ok(
    owner.client.rpc("commit_guest_import", {
      p_wedding: wedding,
      p_rows: [{ name: "Ada Example", household: "The Examples" }],
      p_idempotency_key: `seed-${randomUUID()}`,
    }),
  );
  const { guests, household } = await withSuperuser(async (db) => ({
    guests: (
      await db.query("select id from public.guests where wedding_id=$1", [wedding])
    ).rows.map((r) => r.id as string),
    household: (await db.query("select id from public.households where wedding_id=$1", [wedding]))
      .rows[0].id as string,
  }));
  const eventId = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: wedding,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  )) as string;
  const raw = randomBytes(32).toString("base64url");
  const rows = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: wedding,
      p_event_id: eventId,
      p_groups: [{ guestIds: guests, householdId: household }],
      p_plus_one_quota: 1,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [createHash("sha256").update(raw).digest("hex")],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  return { owner, wedding, invitationId: rows[0]!.o_invitation_id, path: `/rsvp/${raw}` };
}

const state = (invitationId: string) =>
  withSuperuser(async (db) => {
    const inv = (
      await db.query("select plus_ones_used from public.invitations where id=$1", [invitationId])
    ).rows[0] as { plus_ones_used: number };
    const plus = (
      await db.query(
        "select im.active, im.rsvp_status, g.archived_at is not null as archived from public.invitation_members im join public.guests g on g.id = im.guest_id where im.invitation_id=$1 and im.is_plus_one",
        [invitationId],
      )
    ).rows as { active: boolean; rsvp_status: string; archived: boolean }[];
    return { used: inv.plus_ones_used, plus };
  });

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

/** Ada attends and names Cy as her guest; one Send. */
async function addCy(guest: Page) {
  await guest
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await guest.getByRole("button", { name: "Next" }).click(); // notes
  await guest.getByRole("button", { name: "Next" }).click(); // plus-one
  await guest.getByLabel("Yes, I'm bringing a guest").check();
  await guest.getByLabel("Guest's full name").fill("Cy Example");
  await guest.getByRole("button", { name: "Next" }).click(); // review
  await guest.getByRole("button", { name: "Send my reply" }).click();
  await expect(
    guest.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();
}

test("a guest removes the plus-one they added; the place is free, and the couple can see it", async ({
  page,
  browser,
}) => {
  const { owner, wedding, invitationId, path } = await seed("remove-flow");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await ctx.newPage();
  await guest.goto(path);
  await addCy(guest);
  expect(await state(invitationId)).toEqual({
    used: 1,
    plus: [{ active: true, rsvp_status: "accepted", archived: false }],
  });

  // Back to the answers: Cy is offered "Remove this guest", Ada is not.
  await guest.getByRole("button", { name: "Change my reply" }).click();
  await guest.getByRole("button", { name: "Edit answers" }).click();
  const cy = guest.getByRole("group", { name: "Cy Example (plus-one)" });
  await expect(cy.getByLabel("Remove this guest")).toBeVisible();
  await expect(
    cy.getByText("You added this guest. Removing them frees their place."),
  ).toBeVisible();
  await expect(
    guest.getByRole("group", { name: "Ada Example" }).getByLabel("Not attending"),
  ).toBeVisible();
  await checkPage(guest, "plus-one-remove@390");

  await cy.getByLabel("Remove this guest").check();
  await guest.getByRole("button", { name: "Next" }).click(); // notes for Ada
  await guest.getByRole("button", { name: "Next" }).click(); // a place is free again, so the guest step shows
  await expect(guest.getByText("You may bring 1 guest with you.")).toBeVisible();
  await guest.getByRole("button", { name: "Next" }).click(); // review

  // Review says what will happen before anything is sent.
  await expect(guest.getByText("Cy Example (plus-one)")).toBeVisible();
  await expect(guest.getByText("Will be removed")).toBeVisible();
  expect((await state(invitationId)).used).toBe(1);
  await checkPage(guest, "plus-one-remove-review@390");
  await guest.getByRole("button", { name: "Update my reply" }).dblclick();

  await expect(
    guest.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();
  await expect(guest.getByText("Cy Example was removed from your reply.")).toBeVisible();
  await expect(guest.getByText(/Their place is free/)).toBeVisible();
  await expect(guest.getByText("Cy Example (plus-one)")).toHaveCount(0);
  // The double-click was one send: one place freed, one guest archived.
  expect(await state(invitationId)).toEqual({
    used: 0,
    plus: [{ active: false, rsvp_status: "declined", archived: true }],
  });

  // From the link, the guest is gone and the place is offered again.
  await guest.reload();
  await expect(guest.getByText("Cy Example")).toHaveCount(0);
  await guest.getByRole("button", { name: "Edit guest" }).click();
  await expect(guest.getByText("You may bring 1 guest with you.")).toBeVisible();
  await ctx.close();

  // The couple sees the removal in what the guest sent, with no names.
  await signInViaUi(page, owner);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/app/${wedding}/guests/invitations`);
  await page.getByRole("button", { name: /^Sent 2 times by the guest/ }).click();
  const tray = page.getByRole("dialog", { name: "What the guest sent" });
  await expect(tray).toContainText("1 plus-one removed");
  expect(await tray.innerText()).not.toContain("Cy Example");
  await checkPage(page, "plus-one-removed-tray@390");
});

test("the remove choice reflows and passes axe at 320 and 1280px", async ({ page }) => {
  for (const width of [320, 1280]) {
    const { path } = await seed(`remove-a11y-${width}`);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    await addCy(page);
    await page.getByRole("button", { name: "Change my reply" }).click();
    await page.getByRole("button", { name: "Edit answers" }).click();
    await expect(
      page.getByRole("group", { name: "Cy Example (plus-one)" }).getByLabel("Remove this guest"),
    ).toBeVisible();
    await checkPage(page, `plus-one-remove@${width}`);
  }
});
