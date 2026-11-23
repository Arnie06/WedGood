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

// UX-03: the guest RSVP stepper against the real local stack (see rsvp.spec.ts).
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for RSVP specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

async function owner(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = "correct-horse-battery";
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

/** A two-person household invited to one event, with two meals and one plus-one place. */
async function invitation(label: string, opts: { meals?: boolean; plusOnes?: number } = {}) {
  const user = await owner(label);
  const wedding = await createWedding(user, { name: "Stepper (example)" });
  const imp = await user.client.rpc("commit_guest_import", {
    p_wedding: wedding,
    p_rows: [
      { name: "Ada Example", household: "The Examples" },
      { name: "Bo Example", household: "The Examples" },
    ],
    p_idempotency_key: `seed-${randomUUID()}`,
  });
  if (imp.error) throw new Error(imp.error.message);
  const ev = await user.client.rpc("create_event", {
    p_wedding: wedding,
    p_event: { name: "Reception", kind: "reception" },
  });
  if (ev.error) throw new Error(ev.error.message);
  const eventId = ev.data as string;
  if (opts.meals ?? true) {
    for (const name of ["Chicken", "Vegetarian plate"]) {
      const m = await user.client.rpc("add_meal_option", {
        p_wedding: wedding,
        p_event_id: eventId,
        p_name: name,
      });
      if (m.error) throw new Error(m.error.message);
    }
  }
  const guests = await withSuperuser(async (db) =>
    (await db.query("select id from public.guests where wedding_id=$1", [wedding])).rows.map(
      (r) => r.id as string,
    ),
  );
  const raw = randomBytes(32).toString("base64url");
  const inv = await user.client.rpc("create_invitations", {
    p_wedding: wedding,
    p_event_id: eventId,
    p_groups: [{ guestIds: guests, householdId: null }],
    p_plus_one_quota: opts.plusOnes ?? 1,
    p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    p_token_hashes: [createHash("sha256").update(raw).digest("hex")],
    p_idempotency_key: `key-${randomUUID()}`,
  });
  if (inv.error) throw new Error(inv.error.message);
  return { wedding, path: `/rsvp/${raw}` };
}

async function plusOneCount(wedding: string): Promise<number> {
  return withSuperuser(async (db) => {
    const r = await db.query(
      "select count(*)::int as n from public.invitation_members where wedding_id=$1 and is_plus_one",
      [wedding],
    );
    return r.rows[0].n as number;
  });
}

async function answerToReview(page: Page) {
  await page
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await page
    .getByRole("group", { name: "Bo Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("group", { name: "Ada Example" }).getByLabel("Chicken").check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click(); // optional notes: skipped
  await page.getByLabel("Yes, I'm bringing a guest").check();
  await page.getByLabel("Guest's full name").fill("Cy Example");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Check your reply/ })).toBeFocused();
}

test("a double click and a stale second tab never add a second plus-one", async ({ browser }) => {
  const { wedding, path } = await invitation("stepper-dup");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tab = await ctx.newPage();
  const stale = await ctx.newPage();
  await tab.goto(path);
  await stale.goto(path);
  await answerToReview(tab);
  await answerToReview(stale);

  await tab.getByRole("button", { name: "Send my reply" }).dblclick();
  await expect(tab.getByRole("heading", { name: "Thank you. Your reply is saved." })).toBeVisible();
  await expect(tab.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(await plusOneCount(wedding)).toBe(1);

  // The other tab still holds the old version: Send refreshes Review instead of saving twice.
  await stale.getByRole("button", { name: "Send my reply" }).click();
  await expect(stale.getByRole("main").getByRole("alert")).toContainText(
    "updated since you opened it",
  );
  await expect(stale.getByRole("heading", { level: 2, name: /Check your reply/ })).toBeFocused();
  await expect(
    stale.getByRole("listitem").filter({ hasText: "Cy Example (plus-one)" }),
  ).toBeVisible();
  await expect(stale.getByRole("button", { name: "Edit guest" })).toHaveCount(0);
  await stale.getByRole("button", { name: "Update my reply" }).click();
  await expect(
    stale.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();
  expect(await plusOneCount(wedding)).toBe(1);

  // Going back and forward through the browser and sending again changes nothing either.
  await tab.goto("about:blank");
  await tab.goBack();
  await expect(tab.getByRole("button", { name: /Update my reply|Change my reply/ })).toBeVisible();
  const change = tab.getByRole("button", { name: "Change my reply" });
  if (await change.isVisible()) await change.click();
  await tab.getByRole("button", { name: "Update my reply" }).click();
  await expect(tab.getByRole("heading", { name: "Thank you. Your reply is saved." })).toBeVisible();
  expect(await plusOneCount(wedding)).toBe(1);
  await ctx.close();
});

test("declining for everyone skips meals and the plus-one and says so", async ({ page }) => {
  const { path } = await invitation("stepper-skip");
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(path);
  // Until someone attends there are only two steps; meals and the plus-one join later.
  await expect(page.getByRole("heading", { level: 2 })).toContainText("Step 1 of 2");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Choose Attending or Not attending for at least one person.",
  );
  await expect(
    page.getByRole("group", { name: "Ada Example" }).getByLabel("Attending", { exact: true }),
  ).toBeFocused();
  for (const name of ["Ada Example", "Bo Example"]) {
    await page.getByRole("group", { name }).getByLabel("Not attending").check();
  }
  await page.getByRole("button", { name: "Next" }).click();
  const review = page.getByRole("heading", { level: 2, name: /Check your reply/ });
  await expect(review).toBeFocused();
  await expect(review).toContainText("Step 2 of 2");
  await expect(page.locator("[aria-live='polite']")).toContainText(
    "No one is attending, so there are no meals to choose.",
  );
  await expect(page.getByRole("button", { name: "Edit meals" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Who's coming/ })).toBeFocused();
  await expect(
    page.getByRole("group", { name: "Bo Example" }).getByLabel("Not attending"),
  ).toBeChecked();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Send my reply" }).click();
  await expect(
    page.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Change my reply" }).click();
  await expect(page.getByRole("button", { name: "Update my reply" })).toBeVisible();
});

test("a plus-one needs a name; after the reply date only a summary is shown", async ({ page }) => {
  const { wedding, path } = await invitation("stepper-closed", { meals: false });
  await page.goto(path);
  await page
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await page.getByRole("button", { name: "Next" }).click();
  // No meal choices on this event, so the optional notes are step 2 and the plus-one step 3.
  await expect(
    page.getByRole("heading", { level: 2, name: /Step 2 of 4: Anything we should know/ }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: /Step 3 of 4: Bringing a guest/ }),
  ).toBeFocused();
  await page.getByLabel("Yes, I'm bringing a guest").check();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByLabel("Guest's full name")).toBeFocused();
  await expect(page.getByText("Enter your guest's full name.")).toBeVisible();
  await page.getByLabel("Not bringing anyone").check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Send my reply" }).click();
  await expect(
    page.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();
  expect(await plusOneCount(wedding)).toBe(0);

  await withSuperuser((db) =>
    db.query(
      "update public.invitations set deadline = now() - interval '1 day' where wedding_id=$1",
      [wedding],
    ),
  );
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Your reply" })).toBeVisible();
  await expect(page.getByText(/reply date has passed/)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Ada Example" })).toContainText(
    "Attending",
  );
  await expect(page.getByRole("listitem").filter({ hasText: "Bo Example" })).toContainText(
    "No answer yet",
  );
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
});

test("every step passes axe and reflows at 320, 390 and 1280px", async ({ page }) => {
  test.slow(); // three viewports, every step, axe and a screenshot each
  for (const width of [320, 390, 1280]) {
    const { path } = await invitation(`stepper-a11y-${width}`);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    const check = async (name: string) => {
      await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((x) => `${name}@${width}: ${x.id}`)).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name}@${width} overflow`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `test-results/screenshots/${width}/rsvp-${name}.png`,
        fullPage: true,
      });
    };
    await page
      .getByRole("group", { name: "Ada Example" })
      .getByLabel("Attending", { exact: true })
      .check();
    await check("attendance");
    await page.getByRole("button", { name: "Next" }).click();
    await check("meals");
    await page.getByRole("button", { name: "Next" }).click();
    await check("details");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("Yes, I'm bringing a guest").check();
    await page.getByRole("button", { name: "Next" }).click();
    await check("plus-one-error");
    await page.getByLabel("Guest's full name").fill("Cy Example");
    await page.getByRole("button", { name: "Next" }).click();
    await check("review");
    await page.getByRole("button", { name: "Send my reply" }).click();
    await expect(
      page.getByRole("heading", { name: "Thank you. Your reply is saved." }),
    ).toBeVisible();
    await check("confirmation");
  }
});
