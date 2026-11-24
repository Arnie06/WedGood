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

// UX-17 lodging, L2: a guest says where they are staying on a single-event link and on a party
// link, at phone width; the couple sees the answer in Lodging without it replacing their own
// choice. GUEST_LODGING=on in the E2E env. Synthetic names only.
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

/** Ada and Bo invited to the given events; Harbour Inn offered to guests. */
async function setup(label: string, events: string[]) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Stay Wedding" });
  const guest = (name: string) =>
    rpc<string>(
      owner.client.rpc("create_guest", {
        p_wedding: w,
        p_guest: { name },
      }),
    );
  const ada = await guest("Ada Example");
  const bo = await guest("Bo Example");
  const invitations: string[] = [];
  const raws: string[] = [];
  for (const name of events) {
    const e = await rpc<string>(
      owner.client.rpc("create_event", {
        p_wedding: w,
        p_event: { name, kind: "other", localDate: "2027-06-12" },
      }),
    );
    const raw = randomBytes(32).toString("base64url");
    raws.push(raw);
    const rows = await rpc<{ o_invitation_id: string }[]>(
      owner.client.rpc("create_invitations", {
        p_wedding: w,
        p_event_id: e,
        p_groups: [{ guestIds: [ada, bo], householdId: null }],
        p_plus_one_quota: 0,
        p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        p_token_hashes: [sha(raw)],
        p_idempotency_key: `key-${randomUUID()}`,
      }),
    );
    invitations.push(rows[0]!.o_invitation_id);
  }
  const hotel = await rpc<string>(
    owner.client.rpc("add_lodging_hotel", {
      p_wedding: w,
      p_hotel: { name: "Harbour Inn", showToGuests: true },
    }),
  );
  await rpc(
    owner.client.rpc("add_lodging_block", {
      p_wedding: w,
      p_hotel_id: hotel,
      p_block: {
        checkIn: "2027-06-11",
        checkOut: "2027-06-13",
        roomsPerNight: 10,
        cutoffDate: "2027-05-10",
      },
    }),
  );
  return { owner, w, ada, bo, invitations, raws };
}

test("a guest says where they're staying on their link, and the couple sees it", async ({
  page,
  browser,
}) => {
  const f = await setup("stay-single", ["Reception"]);
  const ctx = await browser.newContext({ viewport: { width: 320, height: 800 } });
  const guest = await ctx.newPage();
  await guest.goto(`/rsvp/${f.raws[0]}`);
  await guest
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await guest.getByRole("group", { name: "Bo Example" }).getByLabel("Not attending").check();
  await guest.getByRole("button", { name: "Next" }).click();
  // Notes for the couple (UX-07), then where they're staying.
  await guest.getByRole("button", { name: "Next" }).click();
  await expect(
    guest.getByRole("heading", { level: 2, name: /Where are you staying\?/ }),
  ).toBeFocused();
  await expect(guest.getByText("Book by May 10, 2027 for the group rate")).toBeVisible();
  await checkPage(guest, "rsvp-stay@320");
  await guest.getByLabel(/^Harbour Inn/).check();
  await guest.getByRole("button", { name: "Next" }).click();
  await expect(guest.getByText("Staying at Harbour Inn")).toBeVisible();
  await guest.getByRole("button", { name: "Send my reply" }).click();
  await expect(
    guest.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();
  // Reopening the link shows the guest's own saved choice, which they can change.
  await guest.reload();
  await expect(guest.getByText("Staying at Harbour Inn")).toBeVisible();
  await ctx.close();

  // The guest's answer shows in Lodging, marked as theirs.
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/lodging`);
  const ada = page.getByRole("listitem").filter({ hasText: "Ada Example" }).last();
  await expect(ada).toContainText("Harbour Inn");
  await expect(ada).toContainText("From the guest's RSVP");
  await expect(page.getByTestId("hotel-guest-count")).toContainText("1 attending guest says");

  // The couple's own choice wins and the guest's answer is still shown beside it.
  await page.getByRole("button", { name: "Set where guests stay" }).click();
  const tray = page.getByRole("dialog", { name: "Set where guests stay" });
  await tray.getByLabel(/^Staying at/).selectOption("not_staying");
  await tray.getByLabel("Ada Example").check();
  await tray.getByRole("button", { name: "Save for 1 guest" }).click();
  await expect(tray).toBeHidden();
  await expect(ada).toContainText("Not staying overnight");
  await expect(ada).toContainText("Guest said: Harbour Inn");
});

test("a party link asks once for everyone and every event", async ({ browser }) => {
  const f = await setup("stay-party", ["Ceremony", "Reception"]);
  const raw = randomBytes(32).toString("base64url");
  await rpc(
    f.owner.client.rpc("create_party_link", {
      p_wedding: f.w,
      p_invitation_ids: f.invitations,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hash: sha(raw),
      p_idempotency_key: `party-${randomUUID()}`,
    }),
  );
  const ctx = await browser.newContext({ viewport: { width: 320, height: 800 } });
  const guest = await ctx.newPage();
  await guest.goto(`/rsvp/party/${raw}`);
  for (const ev of ["Ceremony", "Reception"]) {
    for (const who of ["Ada Example", "Bo Example"]) {
      await guest
        .getByRole("group", { name: new RegExp(`^${ev}`) })
        .getByRole("group", { name: who })
        .getByLabel("Attending", { exact: true })
        .check();
    }
  }
  await guest.getByRole("button", { name: "Next" }).click();
  await guest.getByRole("button", { name: "Next" }).click(); // notes
  await expect(
    guest.getByRole("heading", { level: 2, name: /Where are you staying\?/ }),
  ).toBeFocused();
  await expect(guest.getByRole("radio")).toHaveCount(4);
  await guest.getByLabel("Somewhere else").check();
  await guest.getByRole("button", { name: "Next" }).click();
  // Shown once per person, not under every event.
  await expect(guest.getByText("Staying elsewhere")).toHaveCount(2);
  await checkPage(guest, "party-stay-review@320");
  await guest.getByRole("button", { name: "Send my reply" }).click();
  await expect(guest.getByRole("heading", { name: /Thank you/ })).toBeVisible();
  await ctx.close();
  const rows = await rpc<{ guest_kind: string }[]>(
    adminClient().from("lodging_stays").select("guest_kind").eq("wedding_id", f.w),
  );
  expect(rows.map((r) => r.guest_kind)).toEqual(["elsewhere", "elsewhere"]);
});
