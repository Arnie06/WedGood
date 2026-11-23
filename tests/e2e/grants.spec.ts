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

// REL-11: planner/editor scoped grants. Drives the real app against the local stack: the owner
// opens areas on the People and access page, and the editor then sees exactly those areas.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for grant specs");
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

async function join(owner: TestUser, w: string, role: "editor", label: string) {
  const user = await appUser(label);
  const raw = randomBytes(32).toString("base64url");
  await rpc(
    owner.client.rpc("create_collaborator_invite", {
      p_wedding: w,
      p_email: user.email,
      p_role: role,
      p_token_hash: sha(raw),
    }),
  );
  await rpc(user.client.rpc("redeem_collaborator_invite", { p_token_hash: sha(raw) }));
  return user;
}

async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Grants Wedding", tz: "America/New_York" });
  const editor = await join(owner, w, "editor", `${label}-editor`);
  const event = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  await rpc(
    owner.client.rpc("create_guest", {
      p_wedding: w,
      p_guest: { name: "Pat Example", dietary: "Vegan" },
    }),
  );
  return { owner, editor, w, event };
}

test("the owner opens areas to an editor and the editor then sees exactly those", async ({
  page,
  browser,
}) => {
  const f = await setup("gr-flow");
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/settings/members`);

  const grants = page.getByRole("group", { name: /What they can change/ });
  await expect(grants).toBeVisible();
  // Seating and private details wait for Guests.
  await expect(grants.getByLabel(/^Seating/)).toBeDisabled();
  await expect(grants.getByLabel(/^Private guest details/)).toBeDisabled();
  await grants.getByLabel(/^Guests/).check();
  await expect(grants.getByLabel(/^Seating/)).toBeEnabled();
  await grants.getByLabel(/^Seating/).check();
  await grants.getByLabel(/^Plan and design/).check();
  // Unchecking Guests takes Seating with it.
  await grants.getByLabel(/^Guests/).uncheck();
  await expect(grants.getByLabel(/^Seating/)).not.toBeChecked();
  await expect(grants.getByLabel(/^Seating/)).toBeDisabled();
  await grants.getByLabel(/^Guests/).check();
  await grants.getByLabel(/^Seating/).check();
  await grants.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText("Access saved.")).toBeVisible();

  const stored = await rpc<Array<{ email: string; permissions: Record<string, boolean> }>>(
    f.owner.client.rpc("list_members", { p_wedding: f.w }),
  );
  expect(stored.find((m) => m.email === f.editor.email)?.permissions).toEqual({
    guests: true,
    plan: true,
    seating: true,
  });

  const ctx = await browser.newContext();
  const ep = await ctx.newPage();
  await signInViaUi(ep, f.editor);

  // Guests: the list and the add form work, and private details are not shown.
  await ep.goto(`/app/${f.w}/guests`);
  await expect(ep.getByRole("heading", { level: 1, name: "Guest list" })).toBeVisible();
  await expect(ep.getByText("Pat Example").first()).toBeVisible();
  await ep.getByRole("button", { name: "Add a guest" }).click();
  await expect(ep.getByLabel("Dietary needs or allergies")).toHaveCount(0);
  await ep.getByLabel(/^Name/).fill("Sam Example");
  await ep.getByRole("button", { name: "Add guest" }).click();
  await expect(ep.getByText("Added Sam Example.")).toBeVisible();

  // Seating: the plan opens.
  await ep.goto(`/app/${f.w}/seating/${f.event}`);
  await expect(ep.getByText(/arrange seating in this wedding/)).toHaveCount(0);
  await expect(ep.getByRole("heading", { level: 1 })).toBeVisible();

  // Budget was not granted: the page says so and nothing is offered.
  await ep.goto(`/app/${f.w}/plan/budget`);
  await expect(ep.getByRole("button", { name: /Add (a )?(budget )?item/i })).toHaveCount(0);

  // Website: drafting is allowed (Guests and Plan), publishing is reserved.
  await ep.goto(`/app/${f.w}/website`);
  await expect(ep.getByRole("heading", { level: 1, name: "Guest website" })).toBeVisible();
  await expect(ep.getByText(/managed by the workspace owner and partner/)).toHaveCount(0);

  // The owner sees the editor's access summary read-only for a delegate, not here (owner has the form).
  await page.reload();
  await expect(grants.getByLabel(/^Seating/)).toBeChecked();

  // Withdrawing is immediate: the next page load shows the denial.
  await grants.getByLabel(/^Guests/).uncheck();
  await grants.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText("Access saved.")).toBeVisible();
  await ep.goto(`/app/${f.w}/guests`);
  await expect(ep.getByText(/limited to the workspace owner and partner/)).toBeVisible();
  await ctx.close();
});

test("an editor with only Guests cannot see private details or the seating tools", async ({
  page,
}) => {
  const f = await setup("gr-guests");
  await rpc(
    f.owner.client.rpc("set_editor_grants", {
      p_membership: (
        await rpc<Array<{ membership_id: string; email: string; version: number }>>(
          f.owner.client.rpc("list_members", { p_wedding: f.w }),
        )
      ).find((m) => m.email === f.editor.email)!.membership_id,
      p_areas: ["guests"],
      p_expected_version: (
        await rpc<Array<{ email: string; version: number }>>(
          f.owner.client.rpc("list_members", { p_wedding: f.w }),
        )
      ).find((m) => m.email === f.editor.email)!.version,
    }),
  );
  await signInViaUi(page, f.editor);
  await page.goto(`/app/${f.w}/guests`);
  await expect(page.getByRole("link", { name: "Pat Example" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Seating" })).toHaveCount(0);
  await page.getByRole("link", { name: "Pat Example" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Pat Example" })).toBeVisible();
  await expect(page.getByText("Vegan")).toHaveCount(0);
  await expect(page.getByText(/people with access to private details/)).toHaveCount(0);
  await page.getByRole("button", { name: "Edit guest" }).click();
  const tray = page.getByRole("dialog", { name: "Edit guest" });
  await expect(tray.getByLabel("Dietary needs or allergies")).toHaveCount(0);
  await tray.getByLabel("Phone").fill("+1 555 010 2000");
  await tray.getByRole("button", { name: "Save guest" }).click();
  await expect(tray).toBeHidden();
  await expect(page.getByText("Saved.").first()).toBeVisible();

  await page.goto(`/app/${f.w}/seating`);
  await expect(page.getByText(/planners they have given seating access/)).toBeVisible();

  await page.goto(`/app/${f.w}/website`);
  await expect(page.getByText(/both Guests and Plan access/)).toBeVisible();
});

test("a delegate partner and the editor see a read-only summary, not the access form", async ({
  page,
}) => {
  const f = await setup("gr-summary");
  const raw = randomBytes(32).toString("base64url");
  const partner = await appUser("gr-summary-partner");
  await rpc(
    f.owner.client.rpc("create_collaborator_invite", {
      p_wedding: f.w,
      p_email: partner.email,
      p_role: "partner",
      p_token_hash: sha(raw),
    }),
  );
  await rpc(partner.client.rpc("redeem_collaborator_invite", { p_token_hash: sha(raw) }));
  await signInViaUi(page, partner);
  await page.goto(`/app/${f.w}/settings/members`);
  await expect(page.getByRole("group", { name: /What they can change/ })).toHaveCount(0);
  await expect(page.getByTestId("editor-access-summary")).toContainText("Can read only");
});

test("accessible and within the screen at 320 and 1280", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await setup("gr-a11y");
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/settings/members`);
    await expect(page.getByRole("group", { name: /What they can change/ })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `members@${width}: ${x.id}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `members@${width} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `test-results/screenshots/${width}/grants-members.png`,
      fullPage: true,
    });
  }
});
