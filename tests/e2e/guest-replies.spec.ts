import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  type TestUser,
} from "../integration/helpers";

// UX-01: per-event answer, meal and seat on the guest list. Drives the real app against the local
// Supabase stack (see membership.spec.ts).
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for guest reply specs");
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

/** Reception: Ada attending with a meal and a seat, Bo attending with neither, Cy waiting; Dee not invited. */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Replies Wedding", tz: "America/New_York" });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  const meal = await rpc<string>(
    owner.client.rpc("add_meal_option", { p_wedding: w, p_event_id: reception, p_name: "Fish" }),
  );
  const ids: Record<string, string> = {};
  for (const name of ["Ada Example", "Bo Example", "Cy Example", "Dee Example"]) {
    ids[name] = await rpc<string>(
      owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } }),
    );
  }
  const invited = ["Ada Example", "Bo Example", "Cy Example"].map((n) => ids[n]!);
  const created = await rpc<{ o_invitation_id: string }[]>(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: reception,
      p_groups: [{ guestIds: invited, householdId: null }],
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
  const memberOf = (g: string) => members.find((m) => m.guest_id === g)!.id;
  for (const [name, withMeal] of [
    ["Ada Example", true],
    ["Bo Example", false],
  ] as const) {
    await rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: memberOf(ids[name]!),
        p_status: "accepted",
        p_reason: "test",
        ...(withMeal && { p_meal_option_id: meal }),
      }),
    );
  }
  const layout = await rpc<string>(
    owner.client.rpc("ensure_seating_layout", { p_wedding: w, p_event_id: reception }),
  );
  const table = await rpc<string>(
    owner.client.rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: "Table 6",
      p_capacity: 8,
    }),
  );
  await rpc(
    owner.client.rpc("assign_guest_seat", {
      p_wedding: w,
      p_layout: layout,
      p_guest: ids["Ada Example"]!,
      p_table: table,
    }),
  );
  return { owner, w, reception };
}

test("pick an event to see each guest's answer, meal and seat, and filter to what needs doing", async ({
  page,
}) => {
  const { owner, w, reception } = await setup("replies-owner");
  await page.setViewportSize({ width: 320, height: 900 });
  await signInViaUi(page, owner);
  await page.goto(`/app/${w}/guests`);
  await expect(page.getByText("Showing 4 guests.")).toBeVisible();
  // No event chosen: the list is as before.
  await expect(page.getByText("Answer", { exact: true })).toHaveCount(0);

  await page.getByLabel("Show replies for").selectOption({ label: "Reception" });
  await page.waitForURL((u) => u.searchParams.get("event") === reception);
  await expect(
    page.getByText("Reception: 2 attending · 1 waiting · 0 not attending · 1 not invited"),
  ).toBeVisible();
  const row = (name: string) => page.getByRole("listitem").filter({ hasText: name }).last();
  await expect(row("Ada Example")).toContainText("Attending");
  await expect(row("Ada Example")).toContainText("Fish");
  await expect(row("Ada Example")).toContainText("Table 6");
  await expect(row("Bo Example")).toContainText("Not chosen");
  await expect(row("Bo Example")).toContainText("Not seated");
  await expect(row("Cy Example")).toContainText("Waiting");
  await expect(row("Dee Example")).toContainText("Not invited");

  await page.getByLabel("Reply").selectOption({ label: "Attending, not seated" });
  await expect(page.getByText("Showing 1 guest that match.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Bo Example" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ada Example" })).toHaveCount(0);

  // The shortcut links set the same filter.
  await page.getByLabel("Reply").selectOption({ label: "Any reply" });
  await expect(page.getByText("Showing 4 guests.")).toBeVisible();
  await page.getByRole("link", { name: "1 attending without a meal" }).click();
  await expect(page.getByText("Showing 1 guest that match.")).toBeVisible();
  await expect(page.getByLabel("Reply")).toHaveValue("no_meal");

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Showing 4 guests.")).toBeVisible();
  await expect(page.getByLabel("Show replies for")).toHaveValue("");
});

test("a viewer never sees reply columns, even with the event in the address", async ({ page }) => {
  const { w, reception } = await setup("replies-viewer");
  const viewer = await appUser("replies-viewer-user");
  await rpc(
    adminClient().from("memberships").insert({ wedding_id: w, user_id: viewer.id, role: "viewer" }),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${w}/guests?event=${reception}&reply=yes`);
  await expect(page.getByText(/limited to the workspace owner and partner/)).toBeVisible();
  await expect(page.getByText("Ada Example")).toHaveCount(0);
  await expect(page.getByText("Answer", { exact: true })).toHaveCount(0);
});

test("the reply view passes axe and reflows at 320, 390 and 1280", async ({ page }) => {
  const { owner, w, reception } = await setup("replies-a11y");
  await signInViaUi(page, owner);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${w}/guests?event=${reception}`);
    await expect(page.getByText(/^Reception: 2 attending/)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `guest-replies@${width}: ${x.id}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `guest-replies@${width} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `test-results/screenshots/${width}/guest-replies.png`,
      fullPage: true,
    });
  }
});
