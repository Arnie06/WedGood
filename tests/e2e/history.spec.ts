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

// REL-05: reply history on the guest page and finalized versions on the seating page.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for history specs");
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

async function seed(owner: TestUser) {
  const w = await createWedding(owner, { name: "Alex & Morgan (example)" });
  const rpc = async <T>(fn: string, args: Record<string, unknown>) => {
    const r = await owner.client.rpc(fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.data as T;
  };
  const event = await rpc<string>("create_event", {
    p_wedding: w,
    p_event: { name: "Reception", kind: "reception" },
  });
  const chicken = await rpc<string>("add_meal_option", {
    p_wedding: w,
    p_event_id: event,
    p_name: "Chicken",
  });
  const fish = await rpc<string>("add_meal_option", {
    p_wedding: w,
    p_event_id: event,
    p_name: "Fish",
  });
  const ada = await rpc<string>("create_guest", { p_wedding: w, p_guest: { name: "Ada Example" } });
  const raw = randomBytes(32).toString("base64url");
  const created = await rpc<{ o_invitation_id: string }[]>("create_invitations", {
    p_wedding: w,
    p_event_id: event,
    p_groups: [{ guestIds: [ada], householdId: null }],
    p_plus_one_quota: 0,
    p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    p_token_hashes: [createHash("sha256").update(raw).digest("hex")],
    p_idempotency_key: `key-${randomUUID()}`,
  });
  const member = (
    await withSuperuser(
      async (db) =>
        (
          await db.query("select id from public.invitation_members where invitation_id = $1", [
            created[0]!.o_invitation_id,
          ])
        ).rows[0],
    )
  ).id as string;
  const answer = (status: string, reason: string, meal?: string) =>
    rpc("override_rsvp_response", {
      p_wedding: w,
      p_member_id: member,
      p_status: status,
      p_reason: reason,
      ...(meal && { p_meal_option_id: meal }),
    });
  const layout = await rpc<string>("ensure_seating_layout", { p_wedding: w, p_event_id: event });
  const table = await rpc<string>("add_seating_table", {
    p_wedding: w,
    p_layout: layout,
    p_label: "Table 1",
    p_capacity: 4,
  });
  const finalize = async () => {
    const rev = (
      await withSuperuser(
        async (db) =>
          (await db.query("select revision from public.seating_layouts where id = $1", [layout]))
            .rows[0],
      )
    ).revision as number;
    await rpc("finalize_seating_layout", {
      p_wedding: w,
      p_layout: layout,
      p_expected_revision: rev,
    });
  };
  const seat = () =>
    rpc("assign_guest_seat", { p_wedding: w, p_layout: layout, p_guest: ada, p_table: table });
  return { w, event, ada, chicken, fish, answer, finalize, seat };
}

test("the guest page lists each change of answer, newest first, with where it came from", async ({
  page,
}) => {
  const owner = await appUser("hist-guest");
  const s = await seed(owner);
  await s.answer("accepted", "Phoned us on Sunday", s.chicken);
  await s.answer("accepted", "Switched meal", s.fish);
  await s.answer("declined", "Can no longer come");
  await signInViaUi(page, owner);

  await page.goto(`/app/${s.w}/guests/${s.ada}`);
  const section = page.getByRole("region", { name: "Reply history" });
  await expect(section.getByRole("heading", { name: "Reception" })).toBeVisible();
  const items = section.getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("Attending → Not attending");
  await expect(items.nth(0)).toContainText("Entered by you or your partner: Can no longer come");
  await expect(items.nth(1)).toContainText("Meal: Chicken → Fish");
  await expect(items.nth(2)).toContainText("No answer → Attending (Chicken)");
  await expect(items.nth(2)).toContainText("Phoned us on Sunday");

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
});

test("a guest with no changes sees an honest empty state", async ({ page }) => {
  const owner = await appUser("hist-empty");
  const s = await seed(owner);
  await signInViaUi(page, owner);
  await page.goto(`/app/${s.w}/guests/${s.ada}`);
  await expect(page.getByText("No answers have changed yet.")).toBeVisible();
});

test("seating keeps each finalized version and shows it as it was", async ({ page }) => {
  const owner = await appUser("hist-seat");
  const s = await seed(owner);
  await s.answer("accepted", "e2e", s.chicken);
  await s.seat();
  await s.finalize();
  await s.answer("accepted", "e2e", s.fish);
  await s.finalize();
  await signInViaUi(page, owner);

  await page.goto(`/app/${s.w}/seating/${s.event}`);
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Finalized versions (2)" })).toBeVisible();
  const views = page.getByRole("link", { name: "View", exact: true });
  await expect(views).toHaveCount(2);

  // Newest first: the second copy has Fish, the first has Chicken.
  await views.nth(1).click();
  await expect(page.getByText("Older version")).toBeVisible();
  await expect(page.getByText("Ada Example")).toBeVisible();
  await expect(page.getByText("Chicken")).toBeVisible();
  await expect(page.getByText("Fish")).toHaveCount(0);

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 800 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole("link", { name: "Back to the seating plan" }).click();
  await page.getByRole("link", { name: "View", exact: true }).first().click();
  await expect(page.getByText("Fish")).toBeVisible();
  await expect(page.getByText("Chicken")).toHaveCount(0);
});

test("a viewer cannot open a version or see reply history", async ({ page }) => {
  const owner = await appUser("hist-owner");
  const s = await seed(owner);
  await s.answer("accepted", "e2e", s.chicken);
  await s.seat();
  await s.finalize();
  const snapshot = (
    await withSuperuser(
      async (db) =>
        (await db.query("select id from public.seating_snapshots where event_id = $1", [s.event]))
          .rows[0],
    )
  ).id as string;
  const viewer = await appUser("hist-viewer");
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  await owner.client.rpc("create_collaborator_invite", {
    p_wedding: s.w,
    p_email: viewer.email,
    p_role: "viewer",
    p_token_hash: hash,
  });
  await viewer.client.rpc("redeem_collaborator_invite", { p_token_hash: hash });
  await signInViaUi(page, viewer);

  const version = await page.goto(`/app/${s.w}/seating/${s.event}/versions/${snapshot}`);
  expect(version?.status()).toBe(404);
  const guest = await page.goto(`/app/${s.w}/guests/${s.ada}`);
  expect(guest?.status()).toBe(404);
});
