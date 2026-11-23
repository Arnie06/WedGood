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

// UX-07: guests tell the couple about dietary needs and accessibility through their RSVP link.
// Real local stack (see rsvp-stepper.spec.ts). Every sentinel is synthetic.
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
const DIET = "SENTINEL-diet no peanuts";
const ACCESS = "SENTINEL-access step-free route";

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

/** The Examples (Ada, Bo) invited to Ceremony and Reception; Reception has one plus-one place. */
async function seed(label: string) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, { name: "Notes (example)" });
  await ok(
    owner.client.rpc("commit_guest_import", {
      p_wedding: wedding,
      p_rows: [
        { name: "Ada Example", household: "The Examples" },
        { name: "Bo Example", household: "The Examples" },
      ],
      p_idempotency_key: `seed-${randomUUID()}`,
    }),
  );
  const { guests, household, ada } = await withSuperuser(async (db) => ({
    guests: (
      await db.query("select id from public.guests where wedding_id=$1", [wedding])
    ).rows.map((r) => r.id as string),
    household: (await db.query("select id from public.households where wedding_id=$1", [wedding]))
      .rows[0].id as string,
    ada: (
      await db.query(
        "select id from public.guests where wedding_id=$1 and full_name='Ada Example'",
        [wedding],
      )
    ).rows[0].id as string,
  }));
  const links: Record<string, { path: string; raw: string; hash: string }> = {};
  const invitationIds: string[] = [];
  for (const [name, quota] of [
    ["Ceremony", 0],
    ["Reception", 1],
  ] as const) {
    const eventId = (await ok(
      owner.client.rpc("create_event", {
        p_wedding: wedding,
        p_event: { name, kind: name.toLowerCase(), localDate: "2027-06-12" },
      }),
    )) as string;
    const raw = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(raw).digest("hex");
    const rows = (await ok(
      owner.client.rpc("create_invitations", {
        p_wedding: wedding,
        p_event_id: eventId,
        p_groups: [{ guestIds: guests, householdId: household }],
        p_plus_one_quota: quota,
        p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        p_token_hashes: [hash],
        p_idempotency_key: `key-${randomUUID()}`,
      }),
    )) as { o_invitation_id: string }[];
    invitationIds.push(rows[0]!.o_invitation_id);
    links[name] = { path: `/rsvp/${raw}`, raw, hash };
  }
  const partyRaw = randomBytes(32).toString("base64url");
  await ok(
    owner.client.rpc("create_party_link", {
      p_wedding: wedding,
      p_invitation_ids: invitationIds,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hash: createHash("sha256").update(partyRaw).digest("hex"),
      p_idempotency_key: `party-${randomUUID()}`,
    }),
  );
  return { owner, wedding, ada, links, partyPath: `/rsvp/party/${partyRaw}` };
}

/** UX-08: what the database recorded about this wedding's guest sends (counts and a fingerprint). */
const sends = (weddingId: string) =>
  withSuperuser(
    async (db) =>
      (
        await db.query(
          "select accepted_count, declined_count, details_count, party_id is not null as party, payload_hash from public.rsvp_submissions where wedding_id=$1 order by submitted_at, id",
          [weddingId],
        )
      ).rows as {
        accepted_count: number;
        declined_count: number;
        details_count: number;
        party: boolean;
        payload_hash: string;
      }[],
  );

const stored = (guestId: string) =>
  withSuperuser(
    async (db) =>
      (
        await db.query(
          "select dietary, accessibility, guest_answered_at is not null as by_guest from public.guest_private_details where guest_id=$1",
          [guestId],
        )
      ).rows,
  );

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

/** Nothing the guest typed may be anywhere on the page: not as text, not in a field. */
async function expectNoSentinel(page: Page) {
  expect(await page.content()).not.toContain("SENTINEL");
  const values = await page
    .locator("input, textarea")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(values.filter((v) => v.includes("SENTINEL"))).toEqual([]);
}

test("a guest tells the couple about food and access; it is saved, never shown again, and the couple can read it", async ({
  page,
  browser,
}) => {
  const { owner, wedding, ada, links } = await seed("details-single");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await ctx.newPage();
  await guest.goto(links["Reception"]!.path);

  // Only people who are attending are asked.
  await guest
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await guest.getByRole("group", { name: "Bo Example" }).getByLabel("Not attending").check();
  await guest.getByRole("button", { name: "Next" }).click();
  await expect(
    guest.getByRole("heading", { level: 2, name: /Step 2 of 4: Anything we should know/ }),
  ).toBeFocused();
  await expect(guest.getByText(/Only the couple can read this/)).toBeVisible();
  await expect(guest.getByRole("group", { name: "Bo Example" })).toHaveCount(0);
  await checkPage(guest, "details-step@390");

  await guest.getByLabel("Food allergies or dietary needs").fill(DIET);
  await guest.getByLabel("Accessibility needs").fill(ACCESS);
  await guest.getByRole("button", { name: "Next" }).click(); // plus-one step
  await guest.getByRole("button", { name: "Next" }).click(); // review

  // Review shows what is about to be sent, in the guest's own words.
  await expect(guest.getByRole("heading", { level: 2, name: /Check your reply/ })).toBeFocused();
  await expect(guest.getByText(`Food: ${DIET} · Access: ${ACCESS}`)).toBeVisible();
  expect(await stored(ada)).toEqual([]);
  await guest.getByRole("button", { name: "Send my reply" }).dblclick();
  await expect(
    guest.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();

  // Saved, and from here on only the fact is shown.
  await expect(
    guest.getByText("Notes for the couple are saved. Only they can read them."),
  ).toBeVisible();
  await expectNoSentinel(guest);
  expect(await stored(ada)).toEqual([{ dietary: DIET, accessibility: ACCESS, by_guest: true }]);
  // UX-08: the double-click was one send, recorded once, with counts and no text.
  const first = await sends(wedding);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    accepted_count: 1,
    declined_count: 1,
    details_count: 1,
    party: false,
  });

  // Coming back to the link: still saved, still hidden, fields empty, and a replacement is possible.
  await guest.reload();
  await expect(
    guest.getByText("Notes for the couple are saved. Only they can read them."),
  ).toBeVisible();
  await expectNoSentinel(guest);
  await guest.getByRole("button", { name: "Edit notes" }).click();
  await expect(guest.getByText(/saved and aren't shown here/)).toBeVisible();
  await expect(guest.getByLabel("Food allergies or dietary needs")).toHaveValue("");
  await expectNoSentinel(guest);
  await guest.getByLabel("Food allergies or dietary needs").fill("SENTINEL-diet only vegan now");
  await guest.getByRole("button", { name: "Next" }).click(); // plus-one
  await guest.getByRole("button", { name: "Next" }).click(); // review
  await guest.getByRole("button", { name: "Update my reply" }).click();
  await expect(
    guest.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();
  await expectNoSentinel(guest);
  expect(await stored(ada)).toEqual([
    { dietary: "SENTINEL-diet only vegan now", accessibility: ACCESS, by_guest: true },
  ]);
  // A notes-only change is a second send; the earlier one is untouched.
  const both = await sends(wedding);
  expect(both).toHaveLength(2);
  expect(both[0]).toEqual(first[0]);
  expect(both[1]!.payload_hash).not.toBe(first[0]!.payload_hash);

  // The couple can read it, and see that the guest wrote it.
  await signInViaUi(page, owner);
  // UX-08: the planner sees both sends on the invitation, with no names or notes in them.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/app/${wedding}/guests/invitations`);
  await page.getByRole("button", { name: /^Sent 2 times by the guest/ }).click();
  const tray = page.getByRole("dialog", { name: "What the guest sent" });
  await expect(tray.getByRole("listitem")).toHaveCount(2);
  await expect(tray).toContainText("1 accepted · 1 declined · notes saved for 1 person");
  await expect(tray).toContainText("Standard form");
  expect(await tray.innerText()).not.toContain("SENTINEL");
  await checkPage(page, "submissions-tray@390");
  await page.keyboard.press("Escape");
  await page.goto(`/app/${wedding}/guests/${ada}`);
  await expect(page.getByText("SENTINEL-diet only vegan now")).toBeVisible();
  await expect(page.getByText(ACCESS)).toBeVisible();
  await expect(page.getByText(/The guest added dietary or accessibility notes/)).toBeVisible();
  await ctx.close();
});

test("the notes step passes axe and reflows at 320 and 1280px, with the new guest's notes too", async ({
  page,
}) => {
  for (const width of [320, 1280]) {
    const { links } = await seed(`details-a11y-${width}`);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(links["Reception"]!.path);
    await page
      .getByRole("group", { name: "Ada Example" })
      .getByLabel("Attending", { exact: true })
      .check();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toContainText("Anything we should know");
    await checkPage(page, `details-step@${width}`);
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("Yes, I'm bringing a guest").check();
    await page.getByLabel("Guest's full name").fill("Cy Example");
    await expect(page.getByLabel("Accessibility needs")).toBeVisible();
    await checkPage(page, `details-plus-one@${width}`);
  }
});

test("a party link asks each person once, saves for the person, and hides it from the next person to open the link", async ({
  browser,
}) => {
  const { ada, partyPath } = await seed("details-party");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await ctx.newPage();
  await guest.goto(partyPath);
  const cer = guest.getByRole("group", { name: /^Ceremony/ });
  const rec = guest.getByRole("group", { name: /^Reception/ });
  for (const g of [cer, rec]) {
    await g
      .getByRole("group", { name: "Ada Example" })
      .getByLabel("Attending", { exact: true })
      .check();
  }
  await rec.getByRole("group", { name: "Bo Example" }).getByLabel("Not attending").check();
  await guest.getByRole("button", { name: "Next" }).click(); // no meals on either event
  await expect(
    guest.getByRole("heading", { level: 2, name: /Anything we should know/ }),
  ).toBeFocused();
  // Ada is attending two events and is asked once.
  await expect(guest.getByRole("group", { name: "Ada Example" })).toHaveCount(1);
  await expect(guest.getByRole("group", { name: "Bo Example" })).toHaveCount(0);
  await checkPage(guest, "party-details@390");
  await guest.getByLabel("Food allergies or dietary needs").fill(DIET);
  await guest.getByRole("button", { name: "Next" }).click(); // plus-one
  await guest.getByRole("button", { name: "Next" }).click(); // review

  // Review shows her notes once, under the first event.
  await expect(guest.getByText(`Food: ${DIET}`)).toHaveCount(1);
  await guest.getByRole("button", { name: "Send my reply" }).click();
  await expect(
    guest.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();
  await expectNoSentinel(guest);
  expect(await stored(ada)).toEqual([{ dietary: DIET, accessibility: null, by_guest: true }]);

  // Whoever opens the shared link next sees "saved" and nothing else.
  const other = await (
    await browser.newContext({ viewport: { width: 390, height: 844 } })
  ).newPage();
  await other.goto(partyPath);
  await expect(
    other.getByText("Notes for the couple are saved. Only they can read them."),
  ).toBeVisible();
  await expectNoSentinel(other);
  await other.getByRole("button", { name: "Edit notes" }).click();
  await expectNoSentinel(other);
});
