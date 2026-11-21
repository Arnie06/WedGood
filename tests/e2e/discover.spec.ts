import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  withSuperuser,
  type TestUser,
} from "../integration/helpers";

// Drives the real app against the real local Supabase stack (see membership.spec.ts).
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for discover specs");
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

async function count(wedding: string, where = "true"): Promise<number> {
  return withSuperuser(async (db) => {
    const r = await db.query(
      `select count(*)::int n from public.candidates where wedding_id=$1 and archived_at is null and ${where}`,
      [wedding],
    );
    return r.rows[0].n as number;
  });
}

async function seed(owner: TestUser, wedding: string) {
  const mk = (extra: Record<string, unknown>) =>
    owner.client.rpc("create_candidate", { p_wedding: wedding, ...extra });
  await mk({
    p_kind: "venue",
    p_category: "venue",
    p_name: "Vineyard Estate",
    p_location: "Napa",
    p_price_minor: 850000,
    p_price_basis: "total",
    p_seated_capacity: 180,
  });
  await mk({
    p_kind: "venue",
    p_category: "venue",
    p_name: "Coastal Terrace",
    p_price_minor: 1200000,
    p_price_basis: "total",
    p_seated_capacity: 150,
  });
  await mk({
    p_kind: "venue",
    p_category: "venue",
    p_name: "Garden House",
    p_price_minor: 650000,
    p_price_basis: "total",
    p_seated_capacity: 120,
  });
  await mk({ p_kind: "venue", p_category: "venue", p_name: "Mystery Barn" });
  await mk({ p_kind: "vendor", p_category: "photographer", p_name: "Lantern Photography" });
}

test("empty state, then add a venue and a vendor by hand", async ({ page }) => {
  const owner = await appUser("disc-add");
  const wedding = await createWedding(owner, { name: "Add" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover`);
  await expect(
    page.getByRole("heading", { name: "Save a venue or vendor you love" }),
  ).toBeVisible();
  await expect(page.getByRole("search")).toHaveCount(0);

  await page.getByRole("button", { name: "Add a venue" }).click();
  await page.getByLabel(/^Name/).fill("Garden House");
  await page.getByLabel(/^Seated capacity/).fill("120");
  await page.getByLabel(/^Amount/).fill("6,500");
  await page.getByLabel(/^How is that priced/).selectOption("total");
  await page.getByLabel(/^Source link/).fill("https://example.com/garden");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add a venue" })).toBeHidden();
  const card = page.getByRole("listitem").filter({ hasText: "Garden House" });
  await expect(card).toContainText("$6,500.00 for the whole event");
  await expect(card).toContainText("Seats 120");
  await expect(card).toContainText("Entered by you · source not checked yet");
  await expect(card.getByRole("link", { name: /example\.com/ })).toHaveAttribute("rel", /noopener/);

  await page.getByRole("button", { name: "Add a vendor" }).click();
  await page.getByLabel(/^Name/).fill("Lantern Photography");
  await page.getByLabel(/^What do they do/).selectOption("photographer");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add a vendor" })).toBeHidden();
  const vendor = page.getByRole("listitem").filter({ hasText: "Lantern Photography" });
  await expect(vendor).toContainText("Price not entered yet");
  await expect(vendor).not.toContainText("$0");
  await expect(vendor).not.toContainText("Capacity");
  expect(await count(wedding)).toBe(2);
});

test("field errors keep the person's input and save nothing", async ({ page }) => {
  const owner = await appUser("disc-err");
  const wedding = await createWedding(owner, { name: "Err" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover?addVenue=1`);
  await page.getByLabel(/^Source link/).fill("javascript:alert(1)");
  await page.getByLabel(/^Amount/).fill("5000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Give it a name.")).toBeVisible();
  await expect(page.getByText(/web address starting with https/)).toBeVisible();
  await expect(page.getByText(/whole event or per guest/)).toBeVisible();
  await expect(page.getByLabel(/^Amount/)).toHaveValue("5000");
  await expect(page.getByLabel(/^Source link/)).toHaveValue("javascript:alert(1)");
  expect(await count(wedding)).toBe(0);
});

test("search, filter, favorites; unknowns are counted, not silently dropped", async ({ page }) => {
  const owner = await appUser("disc-filter");
  const wedding = await createWedding(owner, { name: "Filter" });
  await seed(owner, wedding);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover`);
  const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3 }) });
  await expect(cards).toHaveCount(5);

  await page.getByLabel(/^Search/).fill("napa");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Vineyard Estate");

  await page.goto(`/app/${wedding}/discover?seated=150`);
  await expect(cards).toHaveCount(2);
  await expect(page.getByText(/1 more has no price or capacity/)).toBeVisible();
  await expect(page.getByText("Mystery Barn")).toHaveCount(0);
  await page.getByRole("link", { name: "Show it anyway" }).click();
  await expect(cards).toHaveCount(3); // the photographer has no capacity, so it never matches
  await expect(page.getByText("Mystery Barn")).toBeVisible();

  await page.goto(`/app/${wedding}/discover?price=9000&unknown=1`);
  await expect(cards.filter({ hasText: "Garden House" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "Vineyard Estate" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "Coastal Terrace" })).toHaveCount(0);

  await page.goto(`/app/${wedding}/discover?category=photographer`);
  await expect(cards).toHaveCount(1);
  await page.goto(`/app/${wedding}/discover?q=zzzz`);
  await expect(page.getByText("Nothing matches those filters.")).toBeVisible();

  await page.goto(`/app/${wedding}/discover`);
  await page.getByRole("button", { name: "Add Garden House to favorites" }).click();
  await expect(
    page.getByRole("button", { name: "Remove Garden House from favorites" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Remove Garden House from favorites" }),
  ).toBeVisible();
  await page.goto(`/app/${wedding}/discover?favorites=1`);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Garden House");
});

test("edit details, clear a price back to unknown, then remove", async ({ page }) => {
  const owner = await appUser("disc-edit");
  const wedding = await createWedding(owner, { name: "Edit" });
  await seed(owner, wedding);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover`);
  await page.getByRole("link", { name: "Garden House" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Garden House" })).toBeVisible();
  await page.getByRole("button", { name: "Edit details" }).click();
  await expect(page.getByLabel(/^Amount/)).toHaveValue("6500");
  await expect(async () => {
    await page.getByLabel(/^Location/).fill("Sonoma");
    await page.getByLabel(/^Amount/).fill("");
    await page.waitForTimeout(400);
    await expect(page.getByLabel(/^Location/)).toHaveValue("Sonoma");
    await expect(page.getByLabel(/^Amount/)).toHaveValue("");
  }).toPass();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog", { name: /Edit Garden House/ })).toBeHidden();
  await page.goto(`/app/${wedding}/discover`);
  const card = page.getByRole("listitem").filter({ hasText: "Garden House" });
  await expect(card).toContainText("Sonoma");
  await expect(card).toContainText("Price not entered yet");

  await page.getByRole("link", { name: "Garden House" }).click();
  await page.getByRole("button", { name: "Edit details" }).click();
  await page.getByRole("button", { name: "Remove from my list" }).click();
  await page.waitForURL(`**/app/${wedding}/discover`);
  await expect(page.getByRole("link", { name: "Garden House" })).toHaveCount(0);
  expect(await count(wedding)).toBe(4);
});

test("a viewer can read the list but not change it; a non-member gets a 404", async ({ page }) => {
  const owner = await appUser("disc-owner");
  const viewer = await appUser("disc-viewer");
  const outsider = await appUser("disc-outsider");
  const wedding = await createWedding(owner, { name: "Private" });
  const { data: id } = await owner.client.rpc("create_candidate", {
    p_wedding: wedding,
    p_kind: "venue",
    p_category: "venue",
    p_name: "Owner Venue",
    p_notes: "Ask about parking",
  });
  await withSuperuser(async (db) => {
    await db.query(
      "insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')",
      [wedding, viewer.id],
    );
  });
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/discover`);
  await expect(page.getByText("Owner Venue")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a venue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add Owner Venue to favorites" })).toBeDisabled();
  expect((await page.goto(`/app/${wedding}/discover/new`))?.status()).toBe(404);
  await page.goto(`/app/${wedding}/discover/${id}`);
  await expect(page.getByRole("heading", { name: "Owner Venue" })).toBeVisible();
  await expect(page.getByText("Ask about parking")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);

  await page.context().clearCookies();
  await signInViaUi(page, outsider);
  expect((await page.goto(`/app/${wedding}/discover`))?.status()).toBe(404);
  expect((await page.goto(`/app/${wedding}/discover/${id}`))?.status()).toBe(404);
  expect((await page.goto(`/app/${wedding}/discover/new`))?.status()).toBe(404);
});

test("discover pages pass axe and reflow at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("disc-a11y");
  const wedding = await createWedding(owner, { name: "A11y" });
  await seed(owner, wedding);
  const { data: id } = await owner.client.rpc("create_candidate", {
    p_wedding: wedding,
    p_kind: "venue",
    p_category: "venue",
    p_name: "A venue with a rather long name that must wrap nicely on a narrow phone screen",
    p_location: "A long location, with several parts, in a very pretty region of the country",
    p_source_url: "https://example.com/a/very/long/path/that/should/not/overflow/the/card/at/all",
    p_source_checked_on: "2026-11-01",
    p_price_minor: 1234500,
    p_price_basis: "total",
    p_seated_capacity: 200,
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, name] of [
      [`/app/${wedding}/discover`, "discover"],
      [`/app/${wedding}/discover?seated=150&q=a`, "discover-filtered"],
      [`/app/${wedding}/discover/${id}`, "discover-edit"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((v) => `${name}@${width}: ${v.id}`)).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name}@${width} overflow`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `test-results/screenshots/${width}/${name}.png`,
        fullPage: true,
      });
    }
  }
});

test("paste a link: bad and unreadable addresses give honest messages and keep what was typed", async ({
  page,
}) => {
  const owner = await appUser("disc-link");
  const wedding = await createWedding(owner, { name: "Link Lookup" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover/new`);

  const lookup = page.getByRole("button", { name: "Look up this page" });
  await expect(lookup).toBeDisabled();

  await page.getByLabel(/^Name/).fill("My own name");
  await page.getByLabel("Paste a link").fill("not a web address at all");
  await lookup.click();
  await expect(page.getByText("Paste a full web address")).toBeVisible();

  // Addresses on the inside of the network are never read, and the message says nothing about why.
  for (const target of [
    "http://127.0.0.1/",
    "http://localhost:3000/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "ftp://example.com/file",
  ]) {
    await page.getByLabel("Paste a link").fill(target);
    await lookup.click();
    await expect(page.getByText("That address can't be read")).toBeVisible();
  }

  // Pressing Enter in the link box looks it up; it does not submit (save) the form.
  await page.getByLabel("Paste a link").fill("http://127.0.0.1/");
  await page.getByLabel("Paste a link").press("Enter");
  await expect(page).toHaveURL(/\/discover/);
  await expect(page.getByLabel(/^Name/)).toHaveValue("My own name");
  const saved = await withSuperuser((db) =>
    db.query("select count(*)::int n from public.candidates where wedding_id=$1", [wedding]),
  );
  expect(saved.rows[0].n).toBe(0);
});

test("paste a link is not offered to a viewer, and the add page is not reachable", async ({
  page,
}) => {
  const owner = await appUser("disc-link-o");
  const viewer = await appUser("disc-link-v");
  const wedding = await createWedding(owner, { name: "Link Viewer" });
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  const response = await page.goto(`/app/${wedding}/discover/new`);
  expect(response?.status()).toBe(404);
});
