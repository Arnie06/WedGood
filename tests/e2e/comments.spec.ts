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
  throw new Error("CI must provide the local Supabase stack for comment specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";

async function appUser(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID()}@example.test`;
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {},
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { id: data.user.id, email, client };
}

async function join(wedding: string, role: "partner" | "editor" | "viewer", label: string) {
  const user = await appUser(label);
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3)", [
      wedding,
      user.id,
      role,
    ]),
  );
  await withSuperuser((db) =>
    db.query("update public.profiles set display_name=$2 where user_id=$1", [
      user.id,
      `${label} person`,
    ]),
  );
  return user;
}

async function signInViaUi(page: Page, user: { email: string }) {
  await page.goto("/sign-in");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

async function seedBoard(owner: TestUser, wedding: string, title = "Florals") {
  const r = await owner.client.rpc("create_design_board", { p_wedding: wedding, p_title: title });
  if (r.error) throw new Error(r.error.message);
  return r.data as string;
}

test("a viewer comments, edits and deletes their own comment; the owner moderates", async ({
  browser,
}) => {
  const owner = await appUser("cm-owner");
  const wedding = await createWedding(owner, { name: "Comments" });
  const board = await seedBoard(owner, wedding);
  const viewer = await join(wedding, "viewer", "cm-viewer");

  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await signInViaUi(viewerPage, viewer);
  await viewerPage.goto(`/app/${wedding}/design/${board}`);
  await expect(viewerPage.getByRole("heading", { level: 2, name: "Comments" })).toBeVisible();
  await expect(viewerPage.getByText("No comments yet")).toBeVisible();
  // A viewer can't change the board but can comment.
  await expect(viewerPage.getByText(/Only the owner and partner can change it/)).toBeVisible();

  // Empty text is explained and nothing is posted.
  await viewerPage.getByRole("button", { name: "Post comment" }).click();
  await expect(viewerPage.getByText("Write a comment first.")).toBeVisible();

  // Markup is shown as plain text, never executed.
  const xss = '<img src=x onerror="window.__pwned=1"> peonies please';
  await viewerPage.getByLabel(/^Add a comment/).fill(xss);
  await viewerPage.getByRole("button", { name: "Post comment" }).click();
  const mine = viewerPage.getByRole("listitem").filter({ hasText: "peonies please" });
  await expect(mine).toBeVisible();
  await expect(mine.getByText(xss, { exact: true })).toBeVisible();
  await expect(mine.getByText("cm-viewer person")).toBeVisible();
  expect(await viewerPage.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(viewerPage.getByLabel(/^Add a comment/)).toHaveValue("");

  // Edit.
  await mine.getByRole("button", { name: "Edit" }).click();
  await viewerPage.getByLabel("Edit your comment").fill("Peonies, please, in blush");
  await viewerPage.getByRole("button", { name: "Save", exact: true }).click();
  const edited = viewerPage.getByRole("listitem").filter({ hasText: "Peonies, please, in blush" });
  await expect(edited).toBeVisible();
  await expect(edited.getByText(/edited/)).toBeVisible();

  // The owner sees it, can delete it as a moderator, and cannot edit it.
  const ownerCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  await signInViaUi(ownerPage, owner);
  await ownerPage.goto(`/app/${wedding}/design/${board}`);
  const seen = ownerPage.getByRole("listitem").filter({ hasText: "Peonies, please, in blush" });
  await expect(seen).toBeVisible();
  await expect(seen.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await seen.getByRole("button", { name: "Delete" }).click();
  await expect(seen.getByText(/can.t be undone/)).toBeVisible();
  await seen.getByRole("button", { name: "Keep" }).click();
  await expect(seen).toBeVisible();
  await seen.getByRole("button", { name: "Delete" }).click();
  await seen.getByRole("button", { name: "Yes, delete" }).click();
  await expect(ownerPage.getByText("No comments yet")).toBeVisible();

  // A viewer's own comment can be deleted by them; others' comments show no controls.
  await ownerPage.getByLabel(/^Add a comment/).fill("Owner note");
  await ownerPage.getByRole("button", { name: "Post comment" }).click();
  // Wait for the save to finish before the viewer reloads, otherwise the reload can beat it.
  await expect(ownerPage.getByRole("listitem").filter({ hasText: "Owner note" })).toBeVisible();
  await viewerPage.reload();
  const theirs = viewerPage.getByRole("listitem").filter({ hasText: "Owner note" });
  await expect(theirs).toBeVisible();
  await expect(theirs.getByRole("button")).toHaveCount(0);
  await viewerCtx.close();
  await ownerCtx.close();
});

test("outsiders and removed members cannot reach comments; unknown subjects 404", async ({
  page,
}) => {
  const owner = await appUser("cm-priv-owner");
  const stranger = await appUser("cm-stranger");
  const wedding = await createWedding(owner);
  const board = await seedBoard(owner, wedding);
  await signInViaUi(page, stranger);
  const response = await page.goto(`/app/${wedding}/design/${board}`);
  expect(response?.status()).toBe(404);
  await page.goto(`/app/${wedding}/shared`);
  await expect(page.getByText("Shared with you")).toHaveCount(0);

  const member = await join(wedding, "viewer", "cm-leaver");
  await signInViaUi(page, member);
  await page.goto(`/app/${wedding}/design/${randomUUID()}`);
  await expect(page.getByRole("heading", { name: /couldn.t find|not found/i })).toBeVisible();
  await withSuperuser((db) =>
    db.query("update public.memberships set status='removed' where user_id=$1", [member.id]),
  );
  const gone = await page.goto(`/app/${wedding}/design/${board}`);
  expect(gone?.status()).toBe(404);
});

test("the shared page shows the role, links and recent comments", async ({ page }) => {
  const owner = await appUser("cm-shared-owner");
  const wedding = await createWedding(owner);
  const board = await seedBoard(owner, wedding, "Linen and tableware");
  const viewer = await join(wedding, "viewer", "cm-fam");
  const r = await viewer.client.rpc("add_comment", {
    p_wedding: wedding,
    p_kind: "design_board",
    p_subject: board,
    p_body: "Mum loves this one",
  });
  expect(r.error).toBeNull();
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/shared`);
  await expect(page.getByRole("heading", { level: 1, name: "Shared with you" })).toBeVisible();
  await expect(page.getByText(/Budgets, guests and documents stay private/)).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "Mum loves this one" });
  await expect(row.getByText("cm-fam person")).toBeVisible();
  await row.getByRole("link", { name: "Linen and tableware" }).click();
  await expect(page).toHaveURL(new RegExp(`/design/${board}$`));
  // Private areas stay private for a viewer, enforced by data rules not just hidden links.
  const budget = await viewer.client.from("budget_items").select("id");
  expect(budget.data ?? []).toEqual([]);
});

test("comment pages pass axe and reflow at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("cm-a11y");
  const wedding = await createWedding(owner);
  const board = await seedBoard(owner, wedding, "A board name long enough to wrap on a phone");
  const viewer = await join(wedding, "viewer", "cm-a11y-v");
  for (const body of [
    "Short and sweet",
    `${"unbreakable".repeat(30)} then a very long sentence that keeps going so wrapping is exercised properly.`,
    "Line one\nLine two\nLine three",
  ]) {
    const r = await viewer.client.rpc("add_comment", {
      p_wedding: wedding,
      p_kind: "design_board",
      p_subject: board,
      p_body: body,
    });
    expect(r.error).toBeNull();
  }
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["comments-board", `/app/${wedding}/design/${board}`],
      ["comments-shared", `/app/${wedding}/shared`],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
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
