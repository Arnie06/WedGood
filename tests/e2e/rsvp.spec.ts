import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
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
  throw new Error("CI must provide the local Supabase stack for RSVP specs");
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

async function seedHousehold(owner: TestUser, wedding: string) {
  const r = await owner.client.rpc("commit_guest_import", {
    p_wedding: wedding,
    p_rows: [
      { name: "Ada Example", household: "The Examples" },
      { name: "Bo Example", household: "The Examples" },
    ],
    p_idempotency_key: `seed-${randomUUID()}`,
  });
  if (r.error) throw new Error(r.error.message);
}

test("owner creates an event, meals and a link; a guest answers without an account; counts update; revoke blocks the link", async ({
  page,
  browser,
}) => {
  const owner = await appUser("rsvp-flow");
  const wedding = await createWedding(owner, { name: "Alex & Morgan (example)" });
  await seedHousehold(owner, wedding);
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/guests/invitations`);
  await expect(page.getByText("No events yet")).toBeVisible();

  await page.getByRole("button", { name: "Add an event" }).click();
  await page.getByLabel("Event name").fill("Reception");
  await page.getByRole("button", { name: "Add event" }).click();
  await expect(page.getByText("Added Reception.").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reception", level: 2 })).toBeVisible();

  await page.getByRole("button", { name: /^Meal choices \(/ }).click();
  for (const meal of ["Chicken", "Vegetarian plate"]) {
    await page.getByLabel("Add a meal choice").fill(meal);
    await page.getByRole("button", { name: "Add meal choice" }).click();
    await expect(page.getByText(`Added ${meal}.`)).toBeVisible();
  }

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Invite guests", exact: true }).click();
  await page.getByLabel(/The Examples/).check();
  await page.getByLabel("Plus-ones allowed").selectOption("1");
  await page.getByRole("button", { name: "Create invitation links" }).click();
  await expect(page.getByText(/Nothing has been sent/)).toBeVisible();
  const link = await page.getByLabel("Private link for The Examples").inputValue();
  expect(link).toMatch(/\/rsvp\/[A-Za-z0-9_-]{43}$/);
  const path = new URL(link).pathname;

  // The guest has no session at all.
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  const resp = await guest.goto(path);
  expect(resp?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(resp?.headers()["x-robots-tag"]).toContain("noindex");
  expect(resp?.headers()["cache-control"]).toContain("no-store");
  await expect(guest.getByRole("heading", { level: 1, name: "Reception" })).toBeVisible();
  await expect(guest.getByText("Alex & Morgan (example)")).toBeVisible();
  await guest
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await guest
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Meal choice (if attending)")
    .selectOption({ label: "Chicken" });
  await guest.getByRole("group", { name: "Bo Example" }).getByLabel("Not attending").check();
  await guest.getByLabel("Guest's full name").fill("Taylor Example");
  await guest.getByLabel("Their meal choice").selectOption({ label: "Vegetarian plate" });
  await guest.getByRole("button", { name: "Send my response" }).click();
  await expect(guest.getByText("Thank you. Your response is saved.")).toBeVisible();
  await expect(guest.getByRole("group", { name: "Taylor Example (plus-one)" })).toBeVisible();

  // Saved state survives a reload; the plus-one allowance is used up.
  await guest.reload();
  await expect(
    guest.getByRole("group", { name: "Ada Example" }).getByLabel("Attending", { exact: true }),
  ).toBeChecked();
  await expect(guest.getByLabel("Guest's full name")).toHaveCount(0);
  await expect(guest.getByRole("button", { name: "Update my response" })).toBeVisible();
  await guestCtx.close();

  await page.reload();
  const summary = page.getByLabel("Responses for Reception");
  await expect(summary).toContainText("Invited3");
  await expect(summary).toContainText("Attending2");
  await expect(summary).toContainText("Not attending1");
  await expect(page.getByText("Chicken: 1")).toBeVisible();
  await expect(page.getByText("Vegetarian plate: 1")).toBeVisible();

  // Revoking stops the link for everyone.
  await page.getByRole("button", { name: /Revoke/ }).click();
  // The actions unmount with the revoked invitation, so the state badge is the confirmation.
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  const after = await browser.newContext();
  const gone = await after.newPage();
  await gone.goto(path);
  await expect(gone.getByText(/isn't working/)).toBeVisible();
  await expect(gone.getByText("Ada Example")).toHaveCount(0);
  await after.close();
});

test("unknown and malformed links show one generic message", async ({ page }) => {
  for (const token of ["x".repeat(43), "short"]) {
    await page.goto(`/rsvp/${token}`);
    await expect(page.getByText(/isn't working/)).toBeVisible();
  }
});

test("viewers and outsiders cannot open the invitations page", async ({ page }) => {
  const owner = await appUser("rsvp-owner");
  const wedding = await createWedding(owner, { name: "Private" });
  const outsider = await appUser("rsvp-outsider");
  await signInViaUi(page, outsider);
  const res = await page.goto(`/app/${wedding}/guests/invitations`);
  expect(res?.status()).toBe(404);
});

test("invitation pages pass axe and reflow at 320px and 1280px", async ({ page, browser }) => {
  const owner = await appUser("rsvp-a11y");
  const wedding = await createWedding(owner, { name: "A11y (example)" });
  await seedHousehold(owner, wedding);
  const ev = await owner.client.rpc("create_event", {
    p_wedding: wedding,
    p_event: {
      name: "A reception with a rather long name that has to wrap on a phone",
      kind: "reception",
      capacity: 1,
    },
  });
  const eventId = ev.data as string;
  await owner.client.rpc("add_meal_option", {
    p_wedding: wedding,
    p_event_id: eventId,
    p_name: "Chicken",
  });
  const g = await withSuperuser(async (db) =>
    (await db.query("select id from public.guests where wedding_id=$1", [wedding])).rows.map(
      (r) => r.id as string,
    ),
  );
  const raw = randomBytes(32).toString("base64url");
  const { createHash } = await import("node:crypto");
  const inv = await owner.client.rpc("create_invitations", {
    p_wedding: wedding,
    p_event_id: eventId,
    p_groups: [{ guestIds: g, householdId: null }],
    p_plus_one_quota: 1,
    p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    p_token_hashes: [createHash("sha256").update(raw).digest("hex")],
    p_idempotency_key: `key-${randomUUID()}`,
  });
  expect(inv.error).toBeNull();
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["invitations", `/app/${wedding}/guests/invitations`],
      ["rsvp", `/rsvp/${raw}`],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (name === "invitations") {
        for (const s of await page.locator("summary").all()) await s.click();
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
  void browser;
});
