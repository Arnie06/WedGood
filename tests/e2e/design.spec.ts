import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
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
  throw new Error("CI must provide the local Supabase stack for design specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";
// A real 1x1 PNG so the browser can decode it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");

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

async function rpc<T>(user: TestUser, fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await user.client.rpc(fn, args);
  if (r.error) throw new Error(`${fn}: ${r.error.message}`);
  return r.data as T;
}

async function seedImage(owner: TestUser, wedding: string, board: string, title: string) {
  const id = await rpc<string>(owner, "create_design_image_intent", {
    p_wedding: wedding,
    p_board: board,
    p_title: title,
    p_rights: "own",
    p_mime: "image/png",
    p_bytes: PNG.byteLength,
  });
  await adminClient().storage.from("wedding-design").upload(`${wedding}/${id}`, PNG, {
    contentType: "image/png",
  });
  await adminClient().rpc("complete_design_image", {
    p_item: id,
    p_checksum: createHash("sha256").update(PNG).digest("hex"),
    p_bytes: PNG.byteLength,
  });
  return id;
}

async function titles(page: Page): Promise<string[]> {
  return page.locator("article h2").allTextContents();
}

test("build a board: palette, link, note, image, favourite, reorder, edit and remove", async ({
  page,
}) => {
  const owner = await appUser("design-flow");
  const wedding = await createWedding(owner, { name: "Design" });
  await rpc(owner, "create_candidate", {
    p_wedding: wedding,
    p_kind: "vendor",
    p_category: "florist",
    p_name: "Petal Co",
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/design`);
  await expect(page.getByRole("heading", { level: 1, name: "Design" })).toBeVisible();
  await expect(page.getByText("No boards yet")).toBeVisible();

  // An invalid palette is explained and the typed values stay.
  await page.getByLabel(/^Board name/).fill("Florals");
  await page.getByLabel(/^Palette/).fill("#D88C9A, blush");
  await page.getByRole("button", { name: "Create board" }).click();
  await expect(page.getByText(/blush isn't a colour/)).toBeVisible();
  await expect(page.getByLabel(/^Board name/)).toHaveValue("Florals");

  await page.getByLabel(/^Palette/).fill("#D88C9A #3d5a50 abc");
  await page.getByRole("button", { name: "Create board" }).click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Florals" })).toBeVisible();
  const palette = page.getByRole("list", { name: "Palette" });
  await expect(palette.getByRole("listitem")).toHaveText(["#d88c9a", "#3d5a50", "#aabbcc"]);

  // Links: unsafe schemes are refused; a good one is stored and rendered as a plain outbound link.
  const linkForm = page.getByRole("region", { name: "Save a link" });
  await linkForm.getByLabel(/^Link \(required\)/).fill("javascript:alert(1)");
  await linkForm.getByLabel(/^Title/).fill("Bad link");
  await linkForm.getByRole("button", { name: "Save link" }).click();
  await expect(linkForm.getByText(/Only web links/)).toBeVisible();
  await expect(page.getByText("Bad link")).toHaveCount(0);

  await linkForm.getByLabel(/^Link \(required\)/).fill("example.com/arch?ref=1");
  await linkForm.getByLabel(/^Title/).fill("Ceremony arch");
  await linkForm.getByLabel(/^Why you saved it/).fill("Love the wild greenery");
  await linkForm.getByLabel(/^Link to a vendor/).selectOption({ label: "Petal Co (florist)" });
  await linkForm.getByRole("button", { name: "Save link" }).click();
  const arch = page.locator("article").filter({ hasText: "Ceremony arch" });
  await expect(arch).toBeVisible();
  const anchor = arch.getByRole("link", { name: /Open example.com/ });
  await expect(anchor).toHaveAttribute("href", "https://example.com/arch?ref=1");
  await expect(anchor).toHaveAttribute("target", "_blank");
  await expect(anchor).toHaveAttribute("rel", /noopener/);
  await expect(anchor).toHaveAttribute("rel", /noreferrer/);
  await expect(arch.getByText("For Petal Co")).toBeVisible();

  // Notes.
  const noteForm = page.getByRole("region", { name: "Add a note" });
  await noteForm.getByLabel(/^Note title/).fill("Colour idea");
  await noteForm.getByRole("button", { name: "Add note" }).click();
  await expect(page.locator("article").filter({ hasText: "Colour idea" })).toBeVisible();

  // Images: validated from the bytes, rights required, shown through the authorized route.
  const imageForm = page.getByRole("region", { name: "Add an image" });
  await imageForm
    .getByLabel(/^Image/)
    .setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: PDF });
  await imageForm.getByLabel(/^Can you use this image/).selectOption("own");
  await imageForm.getByRole("button", { name: "Add image" }).click();
  await expect(imageForm.getByText(/Only JPEG, PNG and WebP/)).toBeVisible();

  await imageForm
    .getByLabel(/^Image/)
    .setInputFiles({ name: "bouquet.png", mimeType: "image/png", buffer: PNG });
  await imageForm.getByLabel(/^Can you use this image/).selectOption("");
  await imageForm.getByRole("button", { name: "Add image" }).click();
  await expect(imageForm.getByText(/Tell us whether you can use this image/)).toBeVisible();
  await imageForm
    .getByLabel(/^Image/)
    .setInputFiles({ name: "bouquet.png", mimeType: "image/png", buffer: PNG });
  await imageForm.getByLabel(/^Can you use this image/).selectOption("permission");
  await imageForm.getByRole("button", { name: "Add image" }).click();
  const bouquet = page.locator("article").filter({ hasText: "bouquet" });
  await expect(bouquet).toBeVisible();
  await expect(bouquet.getByText("Used with permission")).toBeVisible();
  const img = bouquet.getByRole("img", { name: "bouquet" });
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  const src = await img.getAttribute("src");
  const res = await page.request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["cache-control"]).toContain("private");
  expect((await res.body()).equals(PNG)).toBe(true);

  expect(await titles(page)).toEqual(["Ceremony arch", "Colour idea", "bouquet"]);

  // Reorder with buttons (no drag needed), then favourite.
  await page.getByRole("button", { name: "Move earlier: bouquet" }).click();
  await expect.poll(() => titles(page)).toEqual(["Ceremony arch", "bouquet", "Colour idea"]);
  await expect(page.getByRole("button", { name: "Move earlier: Ceremony arch" })).toBeDisabled();
  await page.getByRole("button", { name: "Mark as favourite: bouquet" }).click();
  await expect(
    page.getByRole("button", { name: "Remove from favourites: bouquet" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: /^Favourites \(1\)/ }).click();
  await expect.poll(() => titles(page)).toEqual(["bouquet"]);
  await page.getByRole("link", { name: /^All \(3\)/ }).click();

  // Edit, then confirm persistence across a reload.
  const note = page.locator("article").nth(2);
  await note.getByText("Edit or remove").click();
  await note.getByLabel(/^Title/).fill("Colour story");
  await note.getByRole("button", { name: "Save changes" }).click();
  await expect(note.getByText("Saved.")).toBeVisible();
  await page.reload();
  expect(await titles(page)).toEqual(["Ceremony arch", "bouquet", "Colour story"]);

  // Remove the image: the row and the object are gone.
  const again = page.locator("article").filter({ hasText: "bouquet" });
  await again.getByText("Edit or remove").click();
  await again.getByRole("button", { name: "Remove from board: bouquet" }).click();
  await expect(page.locator("article").filter({ hasText: "bouquet" })).toHaveCount(0);
  expect((await page.request.get(src!)).status()).toBe(404);
  const left = await withSuperuser(async (db) =>
    Number(
      (
        await db.query(
          "select count(*)::int as v from storage.objects where bucket_id='wedding-design' and name like $1",
          [`${wedding}/%`],
        )
      ).rows[0].v,
    ),
  );
  expect(left).toBe(0);

  // Archive the board.
  await page.getByRole("button", { name: "Archive this board" }).click();
  await page.waitForURL(`**/app/${wedding}/design`);
  await expect(page.getByText("No boards yet")).toBeVisible();
});

test("viewers can look but not change; non-members get a 404 for pages and images", async ({
  page,
  browser,
}) => {
  const owner = await appUser("design-roles");
  const wedding = await createWedding(owner);
  const board = await rpc<string>(owner, "create_design_board", {
    p_wedding: wedding,
    p_title: "Attire",
    p_palette: ["#ffffff"],
  });
  await rpc(owner, "add_design_item", {
    p_wedding: wedding,
    p_board: board,
    p_kind: "note",
    p_title: "Veil length",
  });
  const image = await seedImage(owner, wedding, board, "Dress");

  const viewer = await appUser("design-viewer");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/design/${board}`);
  await expect(page.getByRole("heading", { level: 1, name: "Attire" })).toBeVisible();
  await expect(page.getByText("Veil length")).toBeVisible();
  await expect(page.getByText(/Only the owner and partner can change it/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Add image|Save link|Add note|Create/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Move|favourite/i })).toHaveCount(0);
  expect((await page.request.get(`/app/${wedding}/design/${board}/image/${image}`)).status()).toBe(
    200,
  );

  const ctx = await browser.newContext();
  const outsider = await appUser("design-outsider");
  const op = await ctx.newPage();
  await signInViaUi(op, outsider);
  expect((await op.goto(`/app/${wedding}/design/${board}`))?.status()).toBe(404);
  expect((await op.request.get(`/app/${wedding}/design/${board}/image/${image}`)).status()).toBe(
    404,
  );
  await ctx.close();

  // Owner-only: a viewer's direct server-action style write is denied by the database too.
  const denied = await viewer.client.rpc("add_design_item", {
    p_wedding: wedding,
    p_board: board,
    p_kind: "note",
    p_title: "sneaky",
  });
  expect(denied.error?.code).toBe("42501");
});

test("design pages pass axe and reflow at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("design-a11y");
  const wedding = await createWedding(owner);
  const board = await rpc<string>(owner, "create_design_board", {
    p_wedding: wedding,
    p_title: "A board name that is long enough to need wrapping on a narrow phone screen",
    p_description: "Soft ivory, eucalyptus and blush with a touch of gold.",
    p_palette: ["#d88c9a", "#3d5a50", "#d4af37", "#1b1c1a", "#fbf9f5", "#8b4b58"],
  });
  await seedImage(
    owner,
    wedding,
    board,
    "Table setting with a long descriptive title for wrapping",
  );
  await rpc(owner, "add_design_item", {
    p_wedding: wedding,
    p_board: board,
    p_kind: "link",
    p_title: "Arch inspiration",
    p_url: `https://example.com/${"very-long-path-".repeat(8)}`,
    p_note: "Keep the greenery loose.",
  });
  await rpc(owner, "add_design_item", {
    p_wedding: wedding,
    p_board: board,
    p_kind: "note",
    p_title: "Linen colour",
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["design-index", `/app/${wedding}/design`],
      ["design-board", `/app/${wedding}/design/${board}`],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (name === "design-board") {
        await page.getByText("Edit or remove").first().click();
        await expect
          .poll(() =>
            page.evaluate(() =>
              [...document.images].every((i) => i.complete && i.naturalWidth > 0),
            ),
          )
          .toBe(true);
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
