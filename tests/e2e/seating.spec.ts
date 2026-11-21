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

// Drives the real app against the real local Supabase stack (see membership.spec.ts).
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for seating specs");
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

const NAMES = ["Ada Example", "Bo Example", "Cy Example", "Di Example"];

/** One event with two meals and four guests: three attending (two with meals), one declined. */
async function seed(owner: TestUser) {
  const w = await createWedding(owner, { name: "Alex & Morgan (example)" });
  const rpc = async <T>(fn: string, args: Record<string, unknown>) => {
    const r = await owner.client.rpc(fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.data as T;
  };
  const event = await rpc<string>("create_event", {
    p_wedding: w,
    p_event: { name: "Reception", kind: "reception" },
  });
  const chicken = await rpc<string>("add_meal_option", {
    p_wedding: w,
    p_event_id: event,
    p_name: "Chicken",
  });
  await rpc<string>("add_meal_option", {
    p_wedding: w,
    p_event_id: event,
    p_name: "Vegetarian plate",
  });
  const guests: string[] = [];
  for (const name of NAMES) {
    guests.push(await rpc<string>("create_guest", { p_wedding: w, p_guest: { name } }));
  }
  const raw = randomBytes(32).toString("base64url");
  const created = await rpc<{ o_invitation_id: string }[]>("create_invitations", {
    p_wedding: w,
    p_event_id: event,
    p_groups: [{ guestIds: guests, householdId: null }],
    p_plus_one_quota: 0,
    p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    p_token_hashes: [createHash("sha256").update(raw).digest("hex")],
    p_idempotency_key: `key-${randomUUID()}`,
  });
  const members = await withSuperuser(
    async (db) =>
      (
        await db.query(
          "select id, guest_id from public.invitation_members where invitation_id = $1",
          [created[0]!.o_invitation_id],
        )
      ).rows,
  );
  const memberOf = (i: number) => members.find((m) => m.guest_id === guests[i])!.id as string;
  const answer = (i: number, status: string, meal?: string) =>
    rpc("override_rsvp_response", {
      p_wedding: w,
      p_member_id: memberOf(i),
      p_status: status,
      p_reason: "e2e",
      ...(meal && { p_meal_option_id: meal }),
    });
  await answer(0, "accepted", chicken);
  await answer(1, "accepted", chicken);
  await answer(2, "accepted");
  await answer(3, "declined");
  return { w, event, answer, memberOf };
}

test("owner builds a plan: tables, capacity, queue, meals, finalize, stale after a decline", async ({
  page,
}) => {
  const owner = await appUser("seat-flow");
  const { w, event, answer } = await seed(owner);
  await signInViaUi(page, owner);

  // Entry points: the guest list links to seating, the index lists the event.
  await page.goto(`/app/${w}/guests`);
  await page.getByRole("link", { name: "Seating", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Seating" })).toBeVisible();
  await expect(page.getByText(/3 attending/)).toBeVisible();
  await page.getByRole("link", { name: /Open the seating plan/ }).click();

  await expect(page.getByText("No seating plan yet.")).toBeVisible();
  await page.getByRole("button", { name: "Start the seating plan" }).click();
  await expect(page.getByRole("heading", { name: "Guests to seat (3)" })).toBeVisible();

  // The declined guest is never offered a seat.
  await expect(page.getByText("Di Example")).toHaveCount(0);

  // Not enough seats is stated, not hidden.
  const addForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add table" }) });
  await addForm.getByLabel("Table name").fill("Table 1");
  await addForm.getByLabel("Seats").fill("2");
  await page.getByRole("button", { name: "Add table" }).click();
  await expect(page.getByRole("heading", { name: "Tables (1)" })).toBeVisible();
  await expect(page.getByText(/You need 1 more seat/)).toBeVisible();

  // Validation keeps the entered values and explains.
  await addForm.getByLabel("Table name").fill("Table 1");
  await addForm.getByLabel("Seats").fill("0");
  await page.getByRole("button", { name: "Add table" }).click();
  await expect(page.getByText("Enter a whole number of seats from 1 to 50.")).toBeVisible();
  await addForm.getByLabel("Seats").fill("1");
  await page.getByRole("button", { name: "Add table" }).click();
  await expect(page.getByText("You already have a table with that name.")).toBeVisible();
  await addForm.getByLabel("Table name").fill("Table 2");
  await page.getByRole("button", { name: "Add table" }).click();
  await expect(page.getByRole("heading", { name: "Tables (2)" })).toBeVisible();
  await expect(page.getByText(/You need/)).toHaveCount(0);

  // Seat with the keyboard only: focus the select, choose by typing, tab to the button, press it.
  const ada = page
    .getByRole("listitem")
    .filter({ hasText: "Ada Example" })
    .filter({ has: page.getByRole("button", { name: /^Seat/ }) });
  const adaSelect = ada.getByLabel("Table for Ada Example");
  await adaSelect.focus();
  await page.keyboard.type("Table 1");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Guests to seat (2)" })).toBeVisible();

  // Fill Table 1; a full table is disabled in the picker.
  const bo = page
    .getByRole("listitem")
    .filter({ hasText: "Bo Example" })
    .filter({ has: page.getByRole("button", { name: /^Seat/ }) });
  await bo.getByLabel("Table for Bo Example").selectOption({ label: "Table 1 (1 open)" });
  await bo.getByRole("button", { name: "Seat Bo Example" }).click();
  await expect(page.getByRole("heading", { name: "Guests to seat (1)" })).toBeVisible();
  const cy = page
    .getByRole("listitem")
    .filter({ hasText: "Cy Example" })
    .filter({ has: page.getByRole("button", { name: /^Seat/ }) });
  await expect(cy.getByRole("option", { name: "Table 1 (full)" })).toBeDisabled();
  await cy.getByLabel("Table for Cy Example").selectOption({ label: "Table 2 (1 open)" });
  await cy.getByRole("button", { name: "Seat Cy Example" }).click();
  await expect(page.getByText("Everyone who is attending has a seat.")).toBeVisible();
  await expect(page.getByText("Table 1").first()).toBeVisible();
  await expect(page.getByText("2 of 2 seats")).toBeVisible();

  // Meal report: counted once each, with the missing choice called out.
  const meals = page.getByRole("table", { name: "Meal choices of guests who are attending" });
  await expect(meals.getByRole("row", { name: /Chicken\s+2/ })).toBeVisible();
  await expect(meals.getByRole("row", { name: /No choice yet\s+1/ })).toBeVisible();
  await expect(meals.getByRole("row", { name: /Total attending\s+3/ })).toBeVisible();
  await expect(page.getByText("1 guest hasn't chosen a meal yet.")).toBeVisible();

  // Finalize, then a decline makes it out of date and removes the seat.
  await expect(page.getByText("Not finalized.")).toBeVisible();
  await page.getByRole("button", { name: "Finalize this plan" }).click();
  await expect(page.getByText(/The plan hasn.t changed since/)).toBeVisible();
  await answer(0, "declined");
  await page.reload();
  await expect(page.getByText("Out of date")).toBeVisible();
  await expect(page.getByText("Ada Example")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Guests to seat (0)" })).toBeVisible();
  await expect(page.getByText("The frozen copy had 3 attending and 3 seated.")).toBeVisible();
  await page.getByRole("button", { name: "Finalize again" }).click();
  await expect(page.getByText(/The plan hasn.t changed since/)).toBeVisible();

  // Move and remove, and shrinking a full table is refused with an explanation.
  await page.getByRole("button", { name: "Remove Bo Example from the table" }).click();
  await expect(page.getByRole("heading", { name: "Guests to seat (1)" })).toBeVisible();
  const t2 = page.locator("details").filter({ hasText: "Edit or remove Table 2" });
  await t2.getByText("Edit or remove Table 2").click();
  await t2.getByLabel("Seats").fill("1");
  await t2.getByRole("button", { name: "Save Table 2" }).click();
  await expect(page.getByText("2 of 2 seats")).toBeHidden();
  await expect(page.getByText(/1 of 1 seats/)).toBeVisible();

  // CSV downloads carry names, tables and meals only, behind the same session.
  const res = await page.request.get(`/app/${w}/seating/${event}/export?view=seating`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  expect(res.headers()["cache-control"]).toBe("no-store");
  const csv = await res.text();
  expect(csv).toContain("Cy Example");
  expect(csv).not.toContain("Ada Example,Seated");
  const mealsCsv = await (
    await page.request.get(`/app/${w}/seating/${event}/export?view=meals`)
  ).text();
  expect(mealsCsv).toContain("Total attending,2");
});

test("outsiders and signed-out visitors cannot reach a plan or its exports", async ({
  page,
  browser,
}) => {
  const owner = await appUser("seat-owner");
  const { w, event } = await seed(owner);
  const stranger = await appUser("seat-stranger");
  await signInViaUi(page, stranger);
  expect((await page.goto(`/app/${w}/seating/${event}`))?.status()).toBe(404);
  expect((await page.request.get(`/app/${w}/seating/${event}/export?view=seating`)).status()).toBe(
    404,
  );
  const anon = await browser.newContext();
  const res = await anon.request.get(`/app/${w}/seating/${event}/export?view=seating`, {
    maxRedirects: 0,
  });
  expect(res.status()).not.toBe(200);
  expect(await res.text()).not.toContain("Example");
  await anon.close();
});

test("seating pages pass axe and do not overflow at 320 and 1280", async ({ page }) => {
  const owner = await appUser("seat-a11y");
  const { w, event } = await seed(owner);
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const r = await owner.client.rpc(fn, args);
    if (r.error) throw new Error(r.error.message);
    return r.data;
  };
  const layout = (await rpc("ensure_seating_layout", {
    p_wedding: w,
    p_event_id: event,
  })) as string;
  await rpc("add_seating_table", {
    p_wedding: w,
    p_layout: layout,
    p_label: "Head table",
    p_capacity: 2,
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["seating-index", `/app/${w}/seating`],
      ["seating", `/app/${w}/seating/${event}`],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      for (const s of await page.locator("summary").all()) await s.click();
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
