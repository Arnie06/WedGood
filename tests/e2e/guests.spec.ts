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
  throw new Error("CI must provide the local Supabase stack for guest specs");
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

async function guestNames(wedding: string): Promise<string[]> {
  return withSuperuser(async (db) =>
    (
      await db.query<{ full_name: string }>(
        "select full_name from public.guests where wedding_id=$1 order by full_name",
        [wedding],
      )
    ).rows.map((r) => r.full_name),
  );
}

async function seedGuests(owner: TestUser, wedding: string, rows: Record<string, unknown>[]) {
  const r = await owner.client.rpc("commit_guest_import", {
    p_wedding: wedding,
    p_rows: rows,
    p_idempotency_key: `seed-${randomUUID()}`,
  });
  if (r.error) throw new Error(r.error.message);
}

test("add a guest, find it, edit it with private details, archive and restore it", async ({
  page,
}) => {
  const owner = await appUser("guest-flow");
  const wedding = await createWedding(owner, { name: "Guests" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests`);
  await expect(page.getByRole("heading", { level: 1, name: "Guest list" })).toBeVisible();
  await expect(page.getByText("No guests yet")).toBeVisible();

  await page.getByRole("button", { name: "Add a guest" }).click();
  await page.getByLabel(/^Name/).fill("Ada Example");
  await page.getByLabel("Household", { exact: false }).fill("The Examples");
  await page.getByText("More details").click();
  await page.getByLabel("Tags").fill("Family, College");
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(page.getByText("Added Ada Example.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "Ada Example" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The Examples" })).toBeVisible();
  await page.getByRole("button", { name: "Add a guest" }).click();

  // Validation keeps what was typed and says what is wrong.
  await page.getByText("More details").click();
  await page.getByLabel("Email", { exact: true }).fill("not-an-email");
  await page.getByLabel(/^Name/).fill("Bad Email");
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(page.getByText("That email address doesn't look right.")).toBeVisible();
  await expect(page.getByLabel(/^Name/)).toHaveValue("Bad Email");
  expect(await guestNames(wedding)).toEqual(["Ada Example"]);

  // The sheet is modal; close it to reach the list behind it.
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Ada Example" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ada Example" })).toBeVisible();
  await page.getByRole("button", { name: "Edit guest" }).click();
  const tray = page.getByRole("dialog", { name: "Edit guest" });
  await tray.getByLabel("Dietary needs or allergies").fill("Vegetarian");
  await tray.getByLabel("Phone").fill("+1 555 010 2000");
  await tray.getByRole("button", { name: "Save guest" }).click();
  await expect(tray).toBeHidden();
  await expect(page.getByText("Saved.").first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Vegetarian")).toBeVisible();
  await expect(page.getByText("+1 555 010 2000")).toBeVisible();

  await page.getByRole("button", { name: "Archive this guest" }).click();
  await page.getByRole("button", { name: "Archive Ada Example" }).click();
  await expect(page.getByRole("button", { name: "Restore this guest" })).toBeVisible();
  await page.goto(`/app/${wedding}/guests`);
  await expect(page.getByText("No guests yet")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Ada Example" })).toHaveCount(0);
  await page.getByRole("link", { name: /View 1 archived guest/ }).click();
  await page.getByRole("link", { name: "Ada Example" }).click();
  await page.getByRole("button", { name: "Restore this guest" }).click();
  await page.getByRole("button", { name: "Restore Ada Example" }).click();
  await expect(page.getByRole("button", { name: "Archive this guest" })).toBeVisible();
});

test("import a CSV: mapping, preview, duplicates, formulas stay text, export is safe", async ({
  page,
}) => {
  const owner = await appUser("guest-import");
  const wedding = await createWedding(owner, { name: "Import" });
  await seedGuests(owner, wedding, [{ name: "Existing Person", email: "existing@example.test" }]);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests/import`);

  const csv = [
    "Guest,E-mail,Party,Allergies,Mobile",
    'Cleo One,cleo@example.test,The Ones,"Nuts, shellfish",+1 555 010 3000',
    "Dan One,,the ones,,",
    '"=HYPERLINK(""http://example.test"")",,,,',
    "Existing Person,,,,",
    ",no-name@example.test,,,",
    "Eve Bad,not-an-email,,,",
  ].join("\n");
  await page.getByLabel(/^CSV file/).setInputFiles({
    name: "guests.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await expect(page.getByRole("heading", { name: "Match your columns" })).toBeVisible();
  await expect(page.getByLabel("Full name")).toHaveValue("0");
  await expect(page.getByLabel("Household")).toHaveValue("2");
  await expect(page.getByText("3 ready · 1 possible duplicates · 2 need fixing")).toBeVisible();
  await expect(page.getByText("Looks like a guest already on your list")).toBeVisible();
  await expect(page.getByText("Email: That email address doesn't look right.")).toBeVisible();

  // Nothing is stored yet, and importing needs the consent confirmation.
  expect(await guestNames(wedding)).toEqual(["Existing Person"]);
  const importButton = page.getByRole("button", { name: "Import 3 guests" });
  await expect(importButton).toBeDisabled();
  await page.getByLabel(/I have these guests/).check();
  await importButton.click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  await expect(page.getByText(/Added 3 guests\./)).toBeVisible();
  expect(await guestNames(wedding)).toEqual([
    "=HYPERLINK(" + '"http://example.test")',
    "Cleo One",
    "Dan One",
    "Existing Person",
  ]);
  const households = await withSuperuser(
    async (db) =>
      (
        await db.query("select count(*)::int as n from public.households where wedding_id=$1", [
          wedding,
        ])
      ).rows[0].n,
  );
  expect(households).toBe(1);

  // The formula is shown as inert text.
  await page.goto(`/app/${wedding}/guests`);
  await expect(page.getByRole("link", { name: /HYPERLINK/ })).toBeVisible();

  // Export: formulas are neutralized, private details and addresses are not included.
  const res = await page.request.get(`/app/${wedding}/guests/export`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  expect(res.headers()["content-disposition"]).toContain("attachment");
  const body = await res.text();
  expect(body).toContain("'=HYPERLINK");
  expect(body).not.toMatch(/(^|[\r\n,])"?=HYPERLINK/);
  expect(body).not.toContain("shellfish");
  expect(body).toContain("Cleo One");
});

test("search and filters narrow the list on a phone", async ({ page }) => {
  const owner = await appUser("guest-filter");
  const wedding = await createWedding(owner, { name: "Filter" });
  await seedGuests(owner, wedding, [
    { name: "Ada Adult", age_group: "adult", tags: ["Family"] },
    { name: "Kit Child", age_group: "child", tags: ["Family"] },
    { name: "Bo Friend", age_group: "adult", tags: ["Friends"] },
  ]);
  await page.setViewportSize({ width: 320, height: 800 });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests`);
  await expect(page.getByText("Showing 3 guests.")).toBeVisible();
  await page.getByLabel("Search by name or email").fill("kit");
  await expect(page.getByText("Showing 1 guest that match.")).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Showing 3 guests.")).toBeVisible();
  await page.getByRole("search").getByLabel("Tag").selectOption("Family");
  await page.getByRole("search").getByLabel("Adult or child").selectOption("adult");
  await expect(page.getByText("Showing 1 guest that match.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ada Adult" })).toBeVisible();
});

test("viewer and outsider cannot see guests or export them", async ({ page, browser }) => {
  const owner = await appUser("guest-owner");
  const wedding = await createWedding(owner, { name: "Private" });
  await seedGuests(owner, wedding, [{ name: "Private Pat", dietary: "Secret allergy" }]);
  const viewer = await appUser("guest-viewer");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/guests`);
  await expect(page.getByText(/limited to the workspace owner and partner/)).toBeVisible();
  await expect(page.getByText("Private Pat")).toHaveCount(0);
  expect((await page.request.get(`/app/${wedding}/guests/export`)).status()).toBe(404);
  const imp = await page.goto(`/app/${wedding}/guests/import`);
  await expect(page.getByText(/limited to the workspace owner and partner/)).toBeVisible();
  expect(imp?.status()).toBe(200);
  await expect(page.getByLabel(/^CSV file/)).toHaveCount(0);

  const ctx = await browser.newContext();
  const outsider = await appUser("guest-outsider");
  const op = await ctx.newPage();
  await signInViaUi(op, outsider);
  expect((await op.goto(`/app/${wedding}/guests`))?.status()).toBe(404);
  expect((await op.request.get(`/app/${wedding}/guests/export`)).status()).toBe(404);
  await ctx.close();
});

test("guest pages pass axe and reflow at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("guest-a11y");
  const wedding = await createWedding(owner, { name: "A11y" });
  await seedGuests(owner, wedding, [
    {
      name: "A guest with a very long name that has to wrap neatly on a narrow phone screen",
      household: "A household name that is also fairly long to check wrapping",
      email: "long.address.for.testing@example.test",
      tags: ["Family", "College friends"],
      age_group: "adult",
    },
    { name: "Second Guest" },
  ]);
  const first = await withSuperuser(
    async (db) =>
      (
        await db.query(
          "select id from public.guests where wedding_id=$1 order by full_name limit 1",
          [wedding],
        )
      ).rows[0].id as string,
  );
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["guests", `/app/${wedding}/guests`],
      ["guest-detail", `/app/${wedding}/guests/${first}`],
      ["guest-import", `/app/${wedding}/guests/import`],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (name === "guest-import") {
        await page.getByLabel(/^CSV file/).setInputFiles({
          name: "g.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("Name,Email\nNew Person,new@example.test\nBad,nope\n"),
        });
        await expect(page.getByRole("heading", { name: "Review before importing" })).toBeVisible();
      }
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((x) => `${name}@${width}: ${x.id}`)).toEqual([]);
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

test("quick add keeps the sheet open, refocuses Name, confirms and can undo", async ({ page }) => {
  const owner = await appUser("guest-quick");
  const wedding = await createWedding(owner, { name: "Quick Guests" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests`);

  await page.getByRole("button", { name: "Add a guest" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a guest" });
  await expect(page.getByLabel(/^Name/)).toBeFocused();
  // Only name and household are visible up front.
  await expect(dialog.getByLabel("Email", { exact: true })).toBeHidden();

  await page.getByLabel(/^Name/).fill("Quinn One");
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(dialog.getByText("Added Quinn One.")).toBeVisible();
  await expect(page.getByLabel(/^Name/)).toBeFocused();
  await expect(page.getByLabel(/^Name/)).toHaveValue("");

  await page.getByLabel(/^Name/).fill("Quinn Two");
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(dialog.getByText("Added Quinn Two.")).toBeVisible();
  expect((await guestNames(wedding)).sort()).toEqual(["Quinn One", "Quinn Two"]);

  await dialog.getByRole("button", { name: "Undo" }).click();
  await expect(dialog.getByText(/Removed/)).toBeVisible();
  const active = await withSuperuser((db) =>
    db.query("select full_name from public.guests where wedding_id=$1 and archived_at is null", [
      wedding,
    ]),
  );
  expect(active.rows.map((r) => r.full_name)).toEqual(["Quinn One"]);
});

test("an error in More details opens it and focuses the field", async ({ page }) => {
  const owner = await appUser("guest-more");
  const wedding = await createWedding(owner, { name: "More Guests" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests`);
  await page.getByRole("button", { name: "Add a guest" }).click();
  await page.getByLabel(/^Name/).fill("Bad Email");
  await page.getByText("More details").click();
  await page.getByLabel("Email", { exact: true }).fill("nope");
  await page.getByText("Fewer details").click();
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  expect(await guestNames(wedding)).toEqual([]);
});

test("filters apply as you type, with no apply button", async ({ page }) => {
  const owner = await appUser("guest-filter");
  const wedding = await createWedding(owner, { name: "Filter Guests" });
  await seedGuests(owner, wedding, [{ name: "Ada Adult" }, { name: "Kit Child" }]);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests`);
  await expect(page.getByRole("button", { name: "Apply filters" })).toHaveCount(0);
  await page.getByLabel("Search by name or email").fill("kit");
  await expect(page.getByText("Showing 1 guest that match.")).toBeVisible();
  await expect(page.getByLabel("Search by name or email")).toBeFocused();
  await page.getByLabel("Search by name or email").fill("");
  await expect(page.getByText("Showing 2 guests.")).toBeVisible();
});
