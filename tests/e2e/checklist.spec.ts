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
  throw new Error("CI must provide the local Supabase stack for checklist specs");
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

async function taskCount(wedding: string, where = "true"): Promise<number> {
  return withSuperuser(async (db) => {
    const r = await db.query(
      `select count(*)::int n from public.tasks where wedding_id=$1 and archived_at is null and ${where}`,
      [wedding],
    );
    return r.rows[0].n as number;
  });
}

// A date far enough ahead that nothing is overdue, so the grouping is stable.
const FUTURE = "2031-06-15";

test("start the suggested checklist, once, and see it on the dashboard", async ({ page }) => {
  const owner = await appUser("chk-start");
  const wedding = await createWedding(owner, { name: "Start", date: FUTURE });
  await signInViaUi(page, owner);

  await page.goto(`/app/${wedding}`);
  await expect(page.getByRole("heading", { name: "Next steps" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start your checklist" })).toBeVisible();

  await page.getByRole("link", { name: "Start your checklist" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with a suggested checklist" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add the suggested checklist" }).click();
  await expect(page.getByRole("heading", { name: "Coming up" })).toBeVisible();
  const added = await taskCount(wedding);
  expect(added).toBeGreaterThan(15);
  await expect(page.getByText(`0 of ${added} done`)).toBeVisible();

  // Adding "missing" suggestions again is a no-op.
  await page.getByRole("button", { name: "Add any missing suggestions" }).click();
  await expect(page.getByText("Your checklist is already up to date.")).toBeVisible();
  expect(await taskCount(wedding)).toBe(added);

  await page.goto(`/app/${wedding}`);
  await expect(page.getByText(`0 of ${added} done`)).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Talk through your budget" }),
  ).toBeVisible();
});

test("without a date, suggested tasks are undated and the dashboard asks for one", async ({
  page,
}) => {
  const owner = await appUser("chk-nodate");
  const wedding = await createWedding(owner, { name: "No date" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);
  await page.getByRole("button", { name: "Add the suggested checklist" }).click();
  await expect(page.getByRole("heading", { name: /No date yet/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Needs attention/ })).toHaveCount(0);
  expect(await taskCount(wedding, "due_date is null")).toBe(await taskCount(wedding));
  await page.goto(`/app/${wedding}`);
  await expect(page.getByRole("link", { name: "Add your date" })).toBeVisible();
  await expect(page.getByText("Pick your wedding date")).toBeVisible();
});

test("add, complete, edit and remove tasks; edits to a date make a flexible task fixed", async ({
  page,
}) => {
  const owner = await appUser("chk-crud");
  const wedding = await createWedding(owner, { name: "Crud", date: FUTURE });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);

  await page.getByLabel(/^Task/).fill("Call the florist");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByText("Task added.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Call the florist" })).toBeVisible();

  // A second task right after the first must not be mistaken for a replay.
  await page.getByLabel(/^Task/).fill("Order the cake");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("link", { name: "Order the cake" })).toBeVisible();
  expect(await taskCount(wedding)).toBe(2);

  await page.getByRole("button", { name: 'Mark "Call the florist" done' }).click();
  await expect(page.getByText("1 of 2 done")).toBeVisible();
  await page.reload();
  await expect(page.getByText("1 of 2 done")).toBeVisible();
  await page.getByText(/^Done \(1\)/).click();
  await expect(page.getByRole("button", { name: 'Reopen "Call the florist"' })).toBeVisible();

  await page.getByRole("link", { name: "Order the cake" }).click();
  // The form's client chunk can finish loading just after a soft navigation and remount the
  // inputs; retry until the typed value survives that settling period.
  await expect(async () => {
    await page.getByLabel(/^Due date/).fill("2031-01-10");
    await page.getByLabel(/^Notes/).fill("Lemon, two tiers");
    await page.waitForTimeout(400);
    await expect(page.getByLabel(/^Due date/)).toHaveValue("2031-01-10");
    await expect(page.getByLabel(/^Notes/)).toHaveValue("Lemon, two tiers");
  }).toPass();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`**/app/${wedding}/plan`);
  await expect(page.getByText("Due Jan 10, 2031")).toBeVisible();

  await page.getByRole("link", { name: "Order the cake" }).click();
  await page.getByRole("button", { name: "Remove this task" }).click();
  await page.waitForURL(`**/app/${wedding}/plan`);
  await expect(page.getByRole("link", { name: "Order the cake" })).toHaveCount(0);
  expect(await taskCount(wedding)).toBe(1);
});

test("field errors keep the person's input", async ({ page }) => {
  const owner = await appUser("chk-err");
  const wedding = await createWedding(owner, { name: "Err", date: FUTURE });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);
  await page.getByLabel(/^Due date/).fill("2031-02-01");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByText("Give the task a name.")).toBeVisible();
  await expect(page.getByLabel(/^Due date/)).toHaveValue("2031-02-01");
  expect(await taskCount(wedding)).toBe(0);
});

test("changing the wedding date moves nothing until the preview is reviewed and applied (T13)", async ({
  page,
}) => {
  const owner = await appUser("chk-date");
  const wedding = await createWedding(owner, { name: "Date", date: FUTURE });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);
  await page.getByRole("button", { name: "Add the suggested checklist" }).click();
  await expect(page.getByRole("heading", { name: "Coming up" })).toBeVisible();
  // A task whose date the couple chose (e.g. a contract deadline) is fixed.
  await page.getByLabel(/^Task/).fill("Venue deposit due");
  await page.getByLabel(/^Due date/).fill("2030-11-01");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("link", { name: "Venue deposit due" })).toBeVisible();

  const snapshot = () =>
    withSuperuser(async (db) => {
      const r = await db.query(
        "select title, due_date::text d, date_kind from public.tasks where wedding_id=$1 order by title",
        [wedding],
      );
      return r.rows;
    });
  const before = await snapshot();

  await page.goto(`/app/${wedding}/settings/event`);
  await page.getByLabel(/^Wedding date/).fill("2031-09-20");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByText("Nothing has moved yet.")).toBeVisible();
  expect(await snapshot()).toEqual(before);

  await page.getByRole("link", { name: /^Review \d+ checklist dates$/ }).click();
  await expect(page.getByRole("heading", { name: "Review checklist dates" })).toBeVisible();
  await expect(page.getByText(/1 task with a date you chose/)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Venue deposit due" })).toHaveCount(0);
  expect(await snapshot()).toEqual(before);

  await page.getByRole("button", { name: /^Update \d+ dates$/ }).click();
  await page.waitForURL(`**/app/${wedding}/plan`);
  const after = await snapshot();
  expect(after.find((r) => r.title === "Venue deposit due")).toEqual(
    before.find((r) => r.title === "Venue deposit due"),
  );
  const finalCounts = after.find((r) => r.title === "Give final headcounts to your vendors");
  expect(finalCounts?.d).toBe("2031-09-06");
  await expect(page.getByText(/Your wedding date changed/)).toHaveCount(0);

  await page.goto(`/app/${wedding}/plan/review-dates`);
  await expect(page.getByText("Everything is up to date")).toBeVisible();
});

test("a viewer can read the checklist but not change it; a non-member gets a 404", async ({
  page,
}) => {
  const owner = await appUser("chk-owner");
  const viewer = await appUser("chk-viewer");
  const outsider = await appUser("chk-outsider");
  const wedding = await createWedding(owner, { name: "Private", date: FUTURE });
  await owner.client.rpc("create_task", { p_wedding: wedding, p_title: "Owner-only edit" });
  await withSuperuser(async (db) => {
    await db.query(
      "insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')",
      [wedding, viewer.id],
    );
  });
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/plan`);
  await expect(page.getByText("Owner-only edit")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add task" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: 'Mark "Owner-only edit" done' })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Owner-only edit" })).toHaveCount(0);

  await page.context().clearCookies();
  await signInViaUi(page, outsider);
  expect((await page.goto(`/app/${wedding}/plan`))?.status()).toBe(404);
  expect((await page.goto(`/app/${wedding}/plan/review-dates`))?.status()).toBe(404);
});

test("checklist pages pass axe and reflow at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("chk-a11y");
  const wedding = await createWedding(owner, { name: "A11y", date: FUTURE });
  await owner.client.rpc("generate_checklist", {
    p_wedding: wedding,
    p_items: [
      { key: "a", title: "A suggested task", phase: "final-weeks", offsetDays: -30 },
      { key: "b", title: "Another suggested task", phase: "final-weeks", offsetDays: -10 },
    ],
  });
  const { data: taskId } = await owner.client.rpc("create_task", {
    p_wedding: wedding,
    p_title: "A task of our own",
    p_due_date: "2020-01-01",
  });
  // Move the date so the review page has something to show.
  await owner.client.rpc("update_wedding_settings", {
    p_wedding: wedding,
    p_expected_version: 1,
    p_name: "A11y",
    p_timezone: "America/Chicago",
    p_base_currency: "USD",
    p_date: "2031-08-01",
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, name] of [
      [`/app/${wedding}/plan`, "plan"],
      [`/app/${wedding}/plan/tasks/${taskId}`, "plan-edit-task"],
      [`/app/${wedding}/plan/review-dates`, "plan-review-dates"],
      [`/app/${wedding}`, "dashboard"],
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
