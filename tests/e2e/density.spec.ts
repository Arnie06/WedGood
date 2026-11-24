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

// UX-18: list spacing. Planners (editor role) start compact, couples start comfortable, and anyone
// can switch. The choice is kept per workspace in this browser. Same components either way.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for density specs");
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

/** An owner's wedding with two guests, and an editor holding the Guests area. */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Density Wedding", tz: "America/New_York" });
  const guestIds: string[] = [];
  for (const name of ["Ada Example", "Bo Example"]) {
    guestIds.push(
      await rpc<string>(owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } })),
    );
  }
  const event = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  await rpc(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: event,
      p_groups: [{ guestIds, householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [sha(randomBytes(32).toString("base64url"))],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  const editor = await appUser(`${label}-editor`);
  const raw = randomBytes(32).toString("base64url");
  await rpc(
    owner.client.rpc("create_collaborator_invite", {
      p_wedding: w,
      p_email: editor.email,
      p_role: "editor",
      p_token_hash: sha(raw),
    }),
  );
  await rpc(editor.client.rpc("redeem_collaborator_invite", { p_token_hash: sha(raw) }));
  const members = await rpc<Array<{ membership_id: string; email: string; version: number }>>(
    owner.client.rpc("list_members", { p_wedding: w }),
  );
  const m = members.find((x) => x.email === editor.email)!;
  await rpc(
    owner.client.rpc("set_editor_grants", {
      p_membership: m.membership_id,
      p_areas: ["guests"],
      p_expected_version: m.version,
    }),
  );
  return { owner, editor, w, event };
}

const shell = (page: Page) => page.locator("[data-density]");
const spacing = (page: Page) => page.getByRole("group", { name: "Spacing" });

test("a planner starts compact, a couple starts comfortable, and each can switch", async ({
  page,
  browser,
}) => {
  const f = await setup("dens");

  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/guests`);
  await expect(shell(page)).toHaveAttribute("data-density", "comfortable");
  await expect(spacing(page).getByRole("button", { name: "Comfortable" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const ctx = await browser.newContext();
  const ep = await ctx.newPage();
  await signInViaUi(ep, f.editor);
  await ep.goto(`/app/${f.w}/guests`);
  await expect(ep.getByRole("link", { name: "Ada Example" })).toBeVisible();
  await expect(shell(ep)).toHaveAttribute("data-density", "compact");

  // The editor switches back; it holds across pages and a reload, and does not touch the owner.
  await spacing(ep).getByRole("button", { name: "Comfortable" }).click();
  await expect(shell(ep)).toHaveAttribute("data-density", "comfortable");
  await expect(spacing(ep).getByRole("button", { name: "Comfortable" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await ep.goto(`/app/${f.w}/plan/budget`);
  await expect(shell(ep)).toHaveAttribute("data-density", "comfortable");
  await ctx.close();

  await page.reload();
  await expect(shell(page)).toHaveAttribute("data-density", "comfortable");

  // The owner chooses compact: the guest rows get tighter, and the cookie stays on this wedding.
  const row = page.getByTestId("guest-row").filter({ hasText: "Ada Example" });
  const before = (await row.boundingBox())!.height;
  await spacing(page).getByRole("button", { name: "Compact" }).click();
  await expect(shell(page)).toHaveAttribute("data-density", "compact");
  const after = (await row.boundingBox())!.height;
  expect(after).toBeLessThan(before);
  const cookies = await page.context().cookies();
  const saved = cookies.find((c) => c.name === `wg-density-${f.w}`);
  expect(saved?.value).toBe("compact");
  expect(saved?.path).toBe(`/app/${f.w}`);
  expect(saved?.httpOnly).toBe(true);

  // Another wedding of the same person is unaffected.
  const other = await createWedding(f.owner, { name: "Second Wedding", tz: "Europe/London" });
  await page.goto(`/app/${other}/plan`);
  await expect(shell(page)).toHaveAttribute("data-density", "comfortable");
});

test("compact lists have no overflow, keep 44px targets and pass axe", async ({ page }) => {
  const f = await setup("dens-a11y");
  await signInViaUi(page, f.editor);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/guests?event=${f.event}`);
    await expect(shell(page)).toHaveAttribute("data-density", "compact");
    await expect(
      page.getByText("Answer", { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/screenshots/${width}/guests-compact.png`,
      fullPage: true,
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, `overflow at ${width}`).toBe(false);
    for (const name of ["Comfortable", "Compact"]) {
      const box = (await spacing(page).getByRole("button", { name }).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const link = (await page.getByRole("link", { name: "Ada Example" }).boundingBox())!;
    expect(link.height).toBeGreaterThanOrEqual(44);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, `axe at ${width}`).toEqual([]);
  }
  // Comfortable at the widest size, for comparison by eye.
  await spacing(page).getByRole("button", { name: "Comfortable" }).click();
  await expect(shell(page)).toHaveAttribute("data-density", "comfortable");
  await page.screenshot({
    path: "test-results/screenshots/1280/guests-comfortable.png",
    fullPage: true,
  });
});
