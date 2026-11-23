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

// UX-06: one link for every event a household is invited to, against the real local stack.
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

/** The Examples (Ada, Bo) invited to Ceremony and Reception; Reception has meals and one plus-one. */
async function seed(label: string) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, { name: "Party link (example)" });
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
  const { guests, household } = await withSuperuser(async (db) => ({
    guests: (
      await db.query("select id from public.guests where wedding_id=$1", [wedding])
    ).rows.map((r) => r.id as string),
    household: (await db.query("select id from public.households where wedding_id=$1", [wedding]))
      .rows[0].id as string,
  }));
  const singleLinks: Record<string, string> = {};
  for (const [name, date, quota] of [
    ["Ceremony", "2027-06-12", 0],
    ["Reception", "2027-06-12", 1],
  ] as const) {
    const eventId = (await ok(
      owner.client.rpc("create_event", {
        p_wedding: wedding,
        p_event: { name, kind: name.toLowerCase(), localDate: date },
      }),
    )) as string;
    if (name === "Reception") {
      for (const meal of ["Chicken", "Vegetarian plate"]) {
        await ok(
          owner.client.rpc("add_meal_option", {
            p_wedding: wedding,
            p_event_id: eventId,
            p_name: meal,
          }),
        );
      }
    }
    const raw = randomBytes(32).toString("base64url");
    await ok(
      owner.client.rpc("create_invitations", {
        p_wedding: wedding,
        p_event_id: eventId,
        p_groups: [{ guestIds: guests, householdId: household }],
        p_plus_one_quota: quota,
        p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        p_token_hashes: [createHash("sha256").update(raw).digest("hex")],
        p_idempotency_key: `key-${randomUUID()}`,
      }),
    );
    singleLinks[name] = `/rsvp/${raw}`;
  }
  return { owner, wedding, singleLinks };
}

async function answers(wedding: string) {
  return withSuperuser(async (db) =>
    (
      await db.query(
        `select e.name ev, g.full_name who, im.rsvp_status st, coalesce(mo.name, '') meal
           from public.invitation_members im
           join public.events e on e.id = im.event_id
           join public.guests g on g.id = im.guest_id
           left join public.meal_options mo on mo.id = im.meal_option_id
          where im.wedding_id = $1 and im.active order by e.name, g.full_name`,
        [wedding],
      )
    ).rows.map((r) => `${r.ev}|${r.who}|${r.st}|${r.meal}`),
  );
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

test("planner makes one link; the household answers both events in one send; the per-event link agrees", async ({
  page,
  browser,
}) => {
  const { owner, wedding, singleLinks } = await seed("party-flow");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests/invitations`);
  const section = page.getByRole("region", { name: "One link for all events" });
  await expect(section).toContainText("Would cover Ceremony, Reception");
  await section.getByRole("button", { name: "Make one link for The Examples" }).click();
  await expect(section.getByText(/Link created for all their events/)).toBeVisible();
  // The link stays visible after the page refreshes with the new link.
  await expect(section.getByText("Link made")).toBeVisible();
  const link = await section.getByLabel("Private link for The Examples").inputValue();
  expect(link).toMatch(/\/rsvp\/party\/[A-Za-z0-9_-]{43}$/);
  const path = new URL(link).pathname;
  await expect(page.getByText("Also answered through the link for all events.")).toHaveCount(2);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await checkPage(page, `party-planner@${width}`);
  }

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await ctx.newPage();
  const resp = await guest.goto(path);
  expect(resp?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(resp?.headers()["x-robots-tag"]).toContain("noindex");
  await expect(guest.getByRole("heading", { level: 1, name: "Your invitation" })).toBeVisible();
  await expect(guest.getByText("Invitation for The Examples")).toBeVisible();
  await checkPage(guest, "party-guest-attendance@390");

  const cer = guest.getByRole("group", { name: /^Ceremony/ });
  const rec = guest.getByRole("group", { name: /^Reception/ });
  // Until someone attends the reception, there are only two steps.
  await expect(guest.getByRole("heading", { level: 2 })).toContainText("Step 1 of 2");
  for (const who of ["Ada Example", "Bo Example"]) {
    await cer.getByRole("group", { name: who }).getByLabel("Attending", { exact: true }).check();
  }
  await rec
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await rec.getByRole("group", { name: "Bo Example" }).getByLabel("Not attending").check();
  await guest.getByRole("button", { name: "Next" }).click();

  // Meals: only the reception, only Ada.
  await expect(guest.getByRole("heading", { level: 2, name: /Meal choices/ })).toBeFocused();
  await expect(guest.getByRole("group", { name: /^Ceremony/ })).toHaveCount(0);
  await expect(guest.getByText("Bo Example isn't attending, so no meal is needed.")).toBeVisible();
  await rec.getByRole("group", { name: "Ada Example" }).getByLabel("Chicken").check();
  await guest.getByRole("button", { name: "Next" }).click();

  // Optional notes: Ada is asked once, although she is attending two events. Skipped here.
  await expect(
    guest.getByRole("heading", { level: 2, name: /Anything we should know/ }),
  ).toBeFocused();
  await expect(guest.getByRole("group", { name: "Ada Example" })).toHaveCount(1);
  await guest.getByRole("button", { name: "Next" }).click();

  // The plus-one needs a name; the error is announced and focused.
  await expect(guest.getByRole("heading", { level: 2, name: /Bringing a guest/ })).toBeFocused();
  await rec.getByLabel("Yes, I'm bringing a guest").check();
  await guest.getByRole("button", { name: "Next" }).click();
  await expect(rec.getByLabel("Guest's full name")).toBeFocused();
  await rec.getByLabel("Guest's full name").fill("Cy Example");
  await rec.getByLabel("Their meal choice").selectOption({ label: "Vegetarian plate" });
  await guest.getByRole("button", { name: "Next" }).click();

  await expect(guest.getByRole("heading", { level: 2, name: /Check your reply/ })).toBeFocused();
  const reviewRec = guest.getByRole("region", { name: "Reception" });
  await expect(reviewRec.getByRole("listitem").filter({ hasText: "Ada Example" })).toContainText(
    "Attending · Chicken",
  );
  await expect(reviewRec.getByRole("listitem").filter({ hasText: "Cy Example" })).toContainText(
    "Attending · Vegetarian plate",
  );
  await expect(
    guest
      .getByRole("region", { name: "Ceremony" })
      .getByRole("listitem")
      .filter({ hasText: "Bo Example" }),
  ).toContainText("Attending");
  await checkPage(guest, "party-guest-review@390");
  // Nothing is saved until Send.
  expect((await answers(wedding)).filter((a) => a.includes("|pending|"))).toHaveLength(4);

  await guest.getByRole("button", { name: "Send my reply" }).dblclick();
  await expect(
    guest.getByRole("heading", { level: 2, name: "Thank you. Your reply is saved." }),
  ).toBeFocused();
  expect(await answers(wedding)).toEqual([
    "Ceremony|Ada Example|accepted|",
    "Ceremony|Bo Example|accepted|",
    "Reception|Ada Example|accepted|Chicken",
    "Reception|Bo Example|declined|",
    "Reception|Cy Example|accepted|Vegetarian plate",
  ]);
  await guest.setViewportSize({ width: 320, height: 800 });
  await checkPage(guest, "party-guest-confirmation@320");

  // The reception's own link shows the same saved answers.
  await guest.goto(singleLinks.Reception!);
  await expect(guest.getByRole("heading", { level: 2, name: /Check your reply/ })).toBeVisible();
  await expect(guest.getByRole("listitem").filter({ hasText: "Bo Example" })).toContainText(
    "Not attending",
  );

  // The planner sees the answers on the invitations page, then revokes the party link only.
  await page.reload();
  await expect(page.getByText("Cy Example (plus-one): Attending · Vegetarian plate")).toBeVisible();
  await section
    .getByRole("button", { name: "Revoke the link for all events for The Examples" })
    .click();
  await expect(section.getByText(/stops working now/)).toBeVisible();
  // Checked through the RPC with its own client key: a failed lookup from the browser would count
  // against the shared localhost throttle key and slow other specs. The generic page for a dead
  // link is covered by rsvp.spec.ts.
  const token = path.split("/").pop() ?? "";
  const dead = await adminClient().rpc("rsvp_party_view", {
    p_token_hash: createHash("sha256").update(token).digest("hex"),
    p_client: `e2e-${randomUUID().slice(0, 12)}`,
  });
  expect([dead.data, dead.error]).toEqual([null, null]);
  await guest.goto(singleLinks.Ceremony!);
  await expect(guest.getByRole("heading", { level: 1, name: "Ceremony" })).toBeVisible();
  await ctx.close();
});

test("a stale second tab is shown the latest answers instead of saving over them", async ({
  browser,
}) => {
  const { owner, wedding } = await seed("party-stale");
  const ids = await withSuperuser(async (db) =>
    (await db.query("select id from public.invitations where wedding_id=$1", [wedding])).rows.map(
      (r) => r.id as string,
    ),
  );
  const raw = randomBytes(32).toString("base64url");
  await ok(
    owner.client.rpc("create_party_link", {
      p_wedding: wedding,
      p_invitation_ids: ids,
      p_expires_at: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      p_token_hash: createHash("sha256").update(raw).digest("hex"),
      p_idempotency_key: `party-${randomUUID()}`,
    }),
  );
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  for (const p of [a, b]) await p.goto(`/rsvp/party/${raw}`);
  const declineAll = async (p: Page) => {
    for (const ev of [/^Ceremony/, /^Reception/]) {
      for (const who of ["Ada Example", "Bo Example"]) {
        await p
          .getByRole("group", { name: ev })
          .getByRole("group", { name: who })
          .getByLabel("Not attending")
          .check();
      }
    }
    await p.getByRole("button", { name: "Next" }).click();
  };
  await declineAll(a);
  await a.getByRole("button", { name: "Send my reply" }).click();
  await expect(a.getByRole("heading", { name: "Thank you. Your reply is saved." })).toBeVisible();

  await b
    .getByRole("group", { name: /^Ceremony/ })
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await b.getByRole("button", { name: "Next" }).click();
  await b.getByRole("button", { name: "Next" }).click(); // optional notes: skipped
  await b.getByRole("button", { name: "Send my reply" }).click();
  await expect(b.getByRole("main").getByRole("alert")).toContainText("updated since you opened it");
  await expect(b.getByRole("heading", { level: 2, name: /Check your reply/ })).toBeFocused();
  expect(
    (await answers(wedding)).every((x) => x.endsWith("|declined|")),
    "nothing from the stale tab was saved",
  ).toBe(true);
  await ctx.close();
});
