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

// REL-04: comparisons start from an event's planning number and can be repriced as a copy.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for comparison count specs");
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

/** A Reception with three invited guests who have not answered, and two open venue quotes. */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Compare Wedding", guests: 100 });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception" },
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
  const reply = (i: number, status: "accepted" | "declined") =>
    rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: members.find((m) => m.guest_id === guests[i])!.id,
        p_status: status,
        p_reason: "test",
      }),
    );
  const quotes: string[] = [];
  for (const name of ["Garden House", "Tiny Barn"]) {
    const candidate = await rpc<string>(
      owner.client.rpc("create_candidate", {
        p_wedding: w,
        p_kind: "venue",
        p_category: "venue",
        p_name: name,
      }),
    );
    quotes.push(
      await rpc<string>(
        owner.client.rpc("create_proposal", {
          p_wedding: w,
          p_candidate: candidate,
          p_title: "Saturday package",
        }),
      ),
    );
  }
  return { owner, w, reception, reply, quotes };
}

async function startComparison(page: Page, w: string, name: string) {
  await page.goto(`/app/${w}/discover/compare/new`);
  await page.getByLabel(/^Name/).fill(name);
  await page.getByRole("checkbox", { name: /Garden House/ }).check();
  await page.getByRole("checkbox", { name: /Tiny Barn/ }).check();
}

test("a comparison starts from the reception's planning number; replies later offer a copy, never a change", async ({
  page,
}) => {
  const f = await setup("cmp-count");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);

  await startComparison(page, f.w, "Venues");
  // The reception is the default and its number fills the field (3 invited, none answered).
  await expect(page.getByLabel(/^Start the guest count from/)).toHaveValue(f.reception);
  await expect(page.getByLabel(/^Guests to price for/)).toHaveValue("3");
  await expect(page.getByText("Taken from replies to Reception today.")).toBeVisible();
  await page.getByRole("button", { name: "Start comparing" }).click();
  await page.waitForURL(/\/discover\/compare\/[0-9a-f-]{36}$/);
  const original = page.url();
  await expect(page.getByText(/priced for 3 guests/)).toBeVisible();
  await expect(page.getByText("The count started from replies to Reception.")).toBeVisible();
  // Nothing has moved yet, so no suggestion.
  await expect(page.getByRole("heading", { name: /Replies now suggest/ })).toHaveCount(0);

  // One guest declines: the saved comparison does not change, but we offer a copy.
  await f.reply(0, "declined");
  await page.reload();
  await expect(page.getByText(/priced for 3 guests/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Replies now suggest 2 guests" })).toBeVisible();
  await page.getByRole("button", { name: "Reprice for 2 guests" }).click();

  await page.waitForURL(
    (url) => url.toString() !== original && /compare\/[0-9a-f-]{36}$/.test(url.pathname),
  );
  await expect(page.getByRole("heading", { name: "Venues (for 2 guests)" })).toBeVisible();
  await expect(page.getByText(/priced for 2 guests/)).toBeVisible();
  // The copy matches the replies, so it asks for nothing.
  await expect(page.getByRole("heading", { name: /Replies now suggest/ })).toHaveCount(0);

  // The original is exactly as it was, and still offers a copy.
  await page.goto(original);
  await expect(page.getByRole("heading", { name: "Venues", exact: true })).toBeVisible();
  await expect(page.getByText(/priced for 3 guests/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Replies now suggest 2 guests" })).toBeVisible();
});

test("a number typed over the event's is the couple's own and never nags", async ({ page }) => {
  const f = await setup("cmp-override");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);

  await startComparison(page, f.w, "Fixed headcount");
  await page.getByLabel(/^Guests to price for/).fill("150");
  await expect(page.getByText(/You changed the number/)).toBeVisible();
  await page.getByRole("button", { name: "Start comparing" }).click();
  await page.waitForURL(/\/discover\/compare\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/priced for 150 guests/)).toBeVisible();
  await expect(page.getByText(/The count started from replies/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Replies now suggest/ })).toHaveCount(0);

  // The guest target is still on offer as a plain number.
  await page.goto(`/app/${f.w}/discover/compare/new`);
  await page
    .getByLabel(/^Start the guest count from/)
    .selectOption({ label: "Your guest target (100)" });
  await expect(page.getByLabel(/^Guests to price for/)).toHaveValue("100");
});

test("an event nobody is invited to cannot be a starting point", async ({ page }) => {
  const f = await setup("cmp-empty");
  await rpc(
    f.owner.client.rpc("create_event", {
      p_wedding: f.w,
      p_event: { name: "Brunch", kind: "other" },
    }),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/discover/compare/new`);
  await expect(page.getByRole("option", { name: "Brunch: no replies yet" })).toBeDisabled();
});

test("collaborators see the suggestion only when guest totals are shared, and never the button", async ({
  page,
}) => {
  const f = await setup("cmp-share");
  const [a, b] = f.quotes;
  const cmp = await rpc<string>(
    f.owner.client.rpc("create_comparison", {
      p_wedding: f.w,
      p_title: "Venues",
      p_guest_count: 3,
      p_proposals: [a, b],
      p_criteria: [{ id: "style", label: "Style", weight: 5 }],
      p_count_event: f.reception,
    }),
  );
  await f.reply(0, "declined");
  const editor = await appUser("cmp-editor");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'editor')", [
      f.w,
      editor.id,
    ]),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, editor);

  await page.goto(`/app/${f.w}/discover/compare/${cmp}`);
  await expect(page.getByRole("heading", { name: "Venues", exact: true })).toBeVisible();
  await expect(page.getByText(/priced for 3 guests/)).toBeVisible();
  await expect(page.getByText(/Replies now suggest/)).toHaveCount(0);
  await expect(page.getByText(/started from replies/)).toHaveCount(0);

  await rpc(f.owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Replies now suggest 2 guests" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Reprice/ })).toHaveCount(0);
});

for (const width of [320, 1280]) {
  test(`setup and a comparison with a suggestion have no violations or overflow at ${width}px`, async ({
    page,
  }) => {
    const f = await setup(`cmp-a11y-${width}`);
    await page.setViewportSize({ width, height: 900 });
    await signInViaUi(page, f.owner);
    const check = async (name: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations, `${name}@${width}`).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name}@${width} overflow`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `test-results/screenshots/${width}/comparison-count-${name}.png`,
        fullPage: true,
      });
    };

    await startComparison(page, f.w, "Venues");
    await check("setup");
    await page.getByRole("button", { name: "Start comparing" }).click();
    await page.waitForURL(/\/discover\/compare\/[0-9a-f-]{36}$/);
    await f.reply(0, "declined");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Replies now suggest 2 guests" })).toBeVisible();
    await check("suggestion");
  });
}
