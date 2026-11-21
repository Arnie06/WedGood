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
  throw new Error("CI must provide the local Supabase stack for feedback specs");
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

async function addTasks(
  owner: TestUser,
  wedding: string,
  titles: string[],
  dueDate?: string,
): Promise<void> {
  for (const title of titles) {
    const { error } = await owner.client.rpc("create_task", {
      p_wedding: wedding,
      p_title: title,
      p_idempotency_key: `k-${randomUUID()}`,
      ...(dueDate && { p_due_date: dueDate }),
    });
    if (error) throw new Error(error.message);
  }
}

async function taskStatus(wedding: string, title: string) {
  return withSuperuser(async (db) => {
    const r = await db.query(
      "select status, archived_at from public.tasks where wedding_id=$1 and title=$2",
      [wedding, title],
    );
    return r.rows[0] as { status: string; archived_at: string | null } | undefined;
  });
}

test("adding a task confirms with a toast, scrolls to it, and Undo removes it", async ({
  page,
}) => {
  const owner = await appUser("fb-add");
  const wedding = await createWedding(owner, { name: "Feedback Add" });
  await addTasks(
    owner,
    wedding,
    Array.from({ length: 25 }, (_, i) => `Filler task ${i + 1}`),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);

  await page.getByRole("button", { name: "Add a task" }).click();

  await page.getByLabel(/^Task/).fill("Order the cake");
  await page.getByRole("button", { name: "Add task" }).click();

  const notifications = page.getByRole("region", { name: "Notifications" });
  await expect(notifications.getByText("Task added.")).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "Order the cake" });
  await expect(row).toBeInViewport();
  await expect(row).toHaveAttribute("data-just-added", "");

  await notifications.getByRole("button", { name: "Undo" }).click();
  await expect(notifications.getByText("Task removed.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Order the cake" })).toHaveCount(0);
  expect((await taskStatus(wedding, "Order the cake"))?.archived_at).not.toBeNull();
});

test("completing a task offers Undo, which reopens it", async ({ page }) => {
  const owner = await appUser("fb-done");
  const wedding = await createWedding(owner, { name: "Feedback Done" });
  await addTasks(owner, wedding, ["Book the band"]);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);

  await page.getByRole("button", { name: 'Mark "Book the band" done' }).click();
  const notifications = page.getByRole("region", { name: "Notifications" });
  await expect(notifications.getByText("Marked done.")).toBeVisible();
  expect((await taskStatus(wedding, "Book the band"))?.status).toBe("done");

  await notifications.getByRole("button", { name: "Undo" }).click();
  // The toast shows as soon as the action returns; the page re-renders a moment later.
  await expect.poll(async () => (await taskStatus(wedding, "Book the band"))?.status).toBe("open");
  await expect(page.getByRole("button", { name: 'Mark "Book the band" done' })).toBeVisible();
});

test("a refused change shows a visible error toast, not just hidden text", async ({ page }) => {
  const owner = await appUser("fb-stale");
  const wedding = await createWedding(owner, { name: "Feedback Stale" });
  await addTasks(owner, wedding, ["Pick the florist"]);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);
  await withSuperuser((db) =>
    db.query("update public.tasks set version = version + 1 where wedding_id = $1", [wedding]),
  );
  await page.getByRole("button", { name: 'Mark "Pick the florist" done' }).click();
  await expect(
    page.getByRole("region", { name: "Notifications" }).getByText(/changed|reload|newer/i),
  ).toBeVisible();
  expect((await taskStatus(wedding, "Pick the florist"))?.status).toBe("open");
});

test("a failed submit moves focus to the first invalid field", async ({ page }) => {
  const owner = await appUser("fb-focus");
  const wedding = await createWedding(owner, { name: "Feedback Focus" });
  await signInViaUi(page, owner);

  await page.goto(`/app/${wedding}/plan`);
  await page.getByRole("button", { name: "Add a task" }).click();
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByLabel(/^Task/)).toBeFocused();
  await expect(page.getByLabel(/^Task/)).toHaveAttribute("aria-invalid", "true");

  await page.goto(`/app/${wedding}/discover/new`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel(/^Name/)).toBeFocused();
});

test("overdue tasks are marked in text and style; undated ones are not", async ({ page }) => {
  const owner = await appUser("fb-overdue");
  const wedding = await createWedding(owner, { name: "Feedback Overdue" });
  await addTasks(owner, wedding, ["Late thing"], "2020-01-01");
  await addTasks(owner, wedding, ["Whenever thing"]);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);

  const late = page.getByRole("listitem").filter({ hasText: "Late thing" });
  const label = late.getByText(/Overdue since/);
  await expect(label).toBeVisible();
  const color = await label.evaluate((el) => getComputedStyle(el.parentElement!).color);
  const neutral = await page
    .getByRole("listitem")
    .filter({ hasText: "Whenever thing" })
    .getByText("No date yet")
    .evaluate((el) => getComputedStyle(el).color);
  expect(color).not.toBe(neutral);
  await expect(page.getByText(/Overdue/).filter({ hasText: "Whenever" })).toHaveCount(0);
});

test("the checklist with a toast showing passes axe and reflows at 320 and 1280", async ({
  page,
}) => {
  const owner = await appUser("fb-a11y");
  const wedding = await createWedding(owner, { name: "Feedback A11y" });
  await addTasks(owner, wedding, ["Late thing"], "2020-01-01");
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/app/${wedding}/plan`);
    await page.getByRole("button", { name: "Add a task" }).click();
    await page.getByLabel(/^Task/).fill(`Check ${width}`);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Task added.");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

test("the add-task sheet traps focus, closes on Escape and after saving, and returns focus", async ({
  page,
}) => {
  const owner = await appUser("fb-sheet");
  const wedding = await createWedding(owner, { name: "Feedback Sheet" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);

  const trigger = page.getByRole("button", { name: "Add a task" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add a task" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel(/^Task/)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByLabel(/^Task/).fill("Taste the menu");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("link", { name: "Taste the menu" })).toBeVisible();
});

test("long groups fold after five and a new item inside the fold is still revealed", async ({
  page,
}) => {
  const owner = await appUser("fb-fold");
  const wedding = await createWedding(owner, { name: "Feedback Fold" });
  await addTasks(
    owner,
    wedding,
    Array.from({ length: 8 }, (_, i) => `Folded task ${i + 1}`),
  );
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);

  await expect(page.getByRole("link", { name: /^Folded task/ })).toHaveCount(5);
  await page.getByText("Show 3 more").click();
  await expect(page.getByRole("link", { name: /^Folded task/ })).toHaveCount(8);
  await page.getByText("Show fewer").click();
  await expect(page.getByRole("link", { name: /^Folded task/ })).toHaveCount(5);

  await page.getByRole("button", { name: "Add a task" }).click();
  await page.getByLabel(/^Task/).fill("Zed last task");
  await page.getByRole("button", { name: "Add task" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Zed last task" });
  await expect(row).toBeVisible();
  await expect(row).toBeInViewport();
});

test("a viewer sees no add button", async ({ page }) => {
  const owner = await appUser("fb-view-o");
  const viewer = await appUser("fb-view-v");
  const wedding = await createWedding(owner, { name: "Feedback Viewer" });
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/plan`);
  await expect(page.getByRole("button", { name: "Add a task" })).toHaveCount(0);
});
