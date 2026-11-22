import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
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

/** A floor-plan table or seat opens a small card first; its Edit button opens the full tray. */
async function openTrayFromCard(page: Page, target: Locator, edit: RegExp) {
  await target.click();
  await page.getByRole("dialog").getByRole("button", { name: edit }).click();
}
const openTableTray = (page: Page, table: Locator) => openTrayFromCard(page, table, /^Edit table/);

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
  // The floor plan is the default view; this flow works through the list of tables.
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(page).toHaveURL(/view=list/);

  // The declined guest is never offered a seat.
  await expect(page.getByText("Di Example")).toHaveCount(0);

  // Not enough seats is stated, not hidden. Adding a table happens in a tray.
  const tray = page.getByRole("dialog");
  const openAdd = () => page.getByRole("button", { name: "Add a table" }).click();
  await openAdd();
  await tray.getByLabel("Table name").fill("Table 1");
  await tray.getByLabel("Seats").fill("2");
  await tray.getByRole("button", { name: "Add table" }).click();
  await expect(page.getByRole("heading", { name: "Tables (1)" })).toBeVisible();
  await expect(page.getByText(/You need 1 more seat/)).toBeVisible();

  // Validation keeps the entered values and explains.
  await openAdd();
  await tray.getByLabel("Table name").fill("Table 1");
  await tray.getByLabel("Seats").fill("0");
  await tray.getByRole("button", { name: "Add table" }).click();
  await expect(tray.getByText("Enter a whole number of seats from 1 to 50.")).toBeVisible();
  await tray.getByLabel("Seats").fill("1");
  await tray.getByRole("button", { name: "Add table" }).click();
  await expect(tray.getByText("You already have a table with that name.")).toBeVisible();
  await tray.getByLabel("Table name").fill("Table 2");
  await tray.getByRole("button", { name: "Add table" }).click();
  await expect(page.getByRole("heading", { name: "Tables (2)" })).toBeVisible();
  await expect(page.getByText(/You need/)).toHaveCount(0);
  // The tray gives focus back to its button as it finishes closing; wait for that before typing.
  await expect(tray).toBeHidden();

  // Seat with the keyboard only: focus the select, choose by typing, tab to the button, press it.
  const ada = page
    .getByRole("listitem")
    .filter({ hasText: "Ada Example" })
    .filter({ has: page.getByRole("button", { name: /^Seat/ }) })
    .filter({ hasNot: page.getByRole("button", { name: /^Seat together/ }) });
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
    .filter({ has: page.getByRole("button", { name: /^Seat/ }) })
    .filter({ hasNot: page.getByRole("button", { name: /^Seat together/ }) });
  await bo.getByLabel("Table for Bo Example").selectOption({ label: "Table 1 (1 open)" });
  await bo.getByRole("button", { name: "Seat Bo Example" }).click();
  await expect(page.getByRole("heading", { name: "Guests to seat (1)" })).toBeVisible();
  const cy = page
    .getByRole("listitem")
    .filter({ hasText: "Cy Example" })
    .filter({ has: page.getByRole("button", { name: /^Seat/ }) })
    .filter({ hasNot: page.getByRole("button", { name: /^Seat together/ }) });
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
  await page.getByRole("button", { name: "Details and edit for Table 2" }).click();
  await tray.getByLabel("Seats").fill("1");
  await tray.getByRole("button", { name: "Save Table 2" }).click();
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

test("table and guest trays show answers, notes and captain; a household seats together", async ({
  page,
}) => {
  const owner = await appUser("seat-details");
  const { w, event, answer } = await seed(owner);
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const r = await owner.client.rpc(fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.data;
  };
  const { data: ada } = await owner.client
    .from("guests")
    .select("id, version")
    .eq("wedding_id", w)
    .eq("full_name", "Ada Example")
    .single();
  await rpc("update_guest", {
    p_wedding: w,
    p_guest_id: ada!.id,
    p_expected_version: ada!.version,
    p_guest: { name: "Ada Example", dietary: "Vegetarian" },
  });
  const layout = (await rpc("ensure_seating_layout", {
    p_wedding: w,
    p_event_id: event,
  })) as string;
  for (const [label, capacity] of [
    ["Garden", 3],
    ["Small", 2],
  ] as const) {
    await rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: label,
      p_capacity: capacity,
    });
  }
  await signInViaUi(page, owner);
  await page.goto(`/app/${w}/seating/${event}?view=list`);

  // The three attending guests share an invitation, so they can be seated together. Small is too small.
  const group = page
    .getByRole("listitem")
    .filter({ hasText: "Ada Example, Bo Example, Cy Example" });
  await expect(group.getByRole("option", { name: "Small (needs 3 seats)" })).toBeDisabled();
  await group.getByLabel(/^Table/).selectOption({ label: "Garden (3 open)" });
  await group.getByRole("button", { name: /^Seat together/ }).click();
  await expect(page.getByRole("heading", { name: "Guests to seat (0)" })).toBeVisible();
  await expect(page.getByText("3 of 3 seats (full)")).toBeVisible();

  // Tap the table: answers, dietary notes and a captain.
  const tray = page.getByRole("dialog");
  await page.getByRole("button", { name: "Details and edit for Garden" }).click();
  await expect(tray.getByText("3 attending")).toBeVisible();
  await expect(tray.getByText("Vegetarian")).toBeVisible();
  await tray.getByLabel("Table captain").selectOption({ label: "Bo Example" });
  await tray.getByRole("button", { name: /^Save captain/ }).click();
  await expect(tray).toBeHidden();
  await expect(page.getByText(/Captain: Bo Example/)).toBeVisible();

  // Tap a guest: private notes, seat, and the rest of the invitation.
  await page.getByRole("button", { name: "Ada Example details" }).click();
  await expect(tray.getByRole("heading", { name: "Private notes" })).toBeVisible();
  await expect(tray.getByText("Vegetarian")).toBeVisible();
  await expect(tray.getByText("Bo Example", { exact: false }).first()).toBeVisible();
  await expect(tray.getByRole("definition").filter({ hasText: "Garden" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tray).toBeHidden();

  // A decline removes the guest and clears a captain who is no longer there.
  await answer(1, "declined");
  await page.reload();
  await expect(page.getByText(/Captain:/)).toHaveCount(0);
  await expect(page.getByText("2 of 3 seats")).toBeVisible();

  // Downloads never include private notes.
  const csv = await (
    await page.request.get(`/app/${w}/seating/${event}/export?view=seating`)
  ).text();
  expect(csv).not.toContain("Vegetarian");

  // Print: the PDFs hold names but never the private notes. pdf-lib deflates each content stream
  // and writes text as WinAnsi hex strings, so inflating and searching is a real check, with a
  // positive control.
  const hex = (text: string) => Buffer.from(text, "latin1").toString("hex").toUpperCase();
  const inflated = (pdf: Buffer): string => {
    const raw = pdf.toString("latin1");
    const parts = [raw];
    for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      try {
        parts.push(inflateSync(Buffer.from(m[1] ?? "", "latin1")).toString("latin1"));
      } catch {
        // Not a deflated stream (fonts here are built in); nothing to search.
      }
    }
    return parts.join("\n");
  };
  for (const doc of ["table-list", "cards"]) {
    const res = await page.request.get(
      `/app/${w}/seating/${event}/export/pdf?doc=${doc}&paper=letter&meals=1`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["content-disposition"]).toContain(".pdf");
    const bytes = await res.body();
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const body = inflated(bytes);
    expect(body).toContain(hex("Example"));
    expect(body).not.toContain(hex("Vegetarian"));
    expect(body).not.toContain("Vegetarian");
  }
  expect(
    (await page.request.get(`/app/${w}/seating/${event}/export/pdf?paper=legal`)).status(),
  ).toBe(400);

  // The Print form downloads the chosen document.
  await page.getByLabel("Document").selectOption("cards");
  await page.getByLabel("Paper").selectOption("letter");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PDF" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("escort-cards.pdf");
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
  expect((await page.request.get(`/app/${w}/seating/${event}/export/pdf`)).status()).toBe(404);
  const anon = await browser.newContext();
  const res = await anon.request.get(`/app/${w}/seating/${event}/export?view=seating`, {
    maxRedirects: 0,
  });
  expect(res.status()).not.toBe(200);
  expect(await res.text()).not.toContain("Example");
  const pdfRes = await anon.request.get(`/app/${w}/seating/${event}/export/pdf`, {
    maxRedirects: 0,
  });
  expect(pdfRes.status()).not.toBe(200);
  expect(pdfRes.headers()["content-type"] ?? "").not.toContain("application/pdf");
  await anon.close();
});

test("seating pages pass axe and do not overflow at 320 and 1280", async ({ page }) => {
  test.setTimeout(120_000);
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
  await rpc("add_seating_element", {
    p_wedding: w,
    p_layout: layout,
    p_kind: "dance_floor",
    p_label: "Dance floor",
    p_x: 60,
    p_y: 30,
    p_w: 20,
    p_h: 20,
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["seating-index", `/app/${w}/seating`],
      ["seating", `/app/${w}/seating/${event}`],
      ["seating-list", `/app/${w}/seating/${event}?view=list`],
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

    // The table, guest and room-item trays, open, at this width.
    for (const [name, path, trigger] of [
      [
        "seating-table-tray",
        `/app/${w}/seating/${event}?view=list`,
        "Details and edit for Head table",
      ],
      ["seating-guest-tray", `/app/${w}/seating/${event}?view=list`, "Ada Example details"],
      ["seating-floor-table-card", `/app/${w}/seating/${event}`, /^Head table, 0 of 2 seats/],
      ["seating-floor-table-tray", `/app/${w}/seating/${event}`, /^Head table, 0 of 2 seats/],
      ["seating-floor-item-tray", `/app/${w}/seating/${event}`, /^Dance floor, room item/],
    ] as const) {
      await page.goto(path);
      if (name === "seating-floor-table-tray") {
        await openTableTray(page, page.getByRole("button", { name: trigger }));
      } else {
        await page.getByRole("button", { name: trigger }).click();
      }
      const tray = page.getByRole("dialog");
      await expect(tray).toBeVisible();
      await expect(tray.getByRole("heading", { level: 2 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((x) => `${name}@${width}: ${x.id}`)).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name}@${width} overflow`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/screenshots/${width}/${name}.png` });
      await page.keyboard.press("Escape");
      await expect(tray).toBeHidden();
    }
  }
});

test("floor plan: drag and keyboard move, zoom, trays, room items, list fallback", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const owner = await appUser("seat-floor");
  const { w, event } = await seed(owner);
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const r = await owner.client.rpc(fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.data;
  };
  const layout = (await rpc("ensure_seating_layout", {
    p_wedding: w,
    p_event_id: event,
  })) as string;
  const tableIds: Record<string, string> = {};
  for (const [label, capacity] of [
    ["Garden", 8],
    ["Orchard", 8],
  ] as const) {
    tableIds[label] = (await rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: label,
      p_capacity: capacity,
    })) as string;
  }
  const position = async (label: string) => {
    const { data } = await owner.client
      .from("seating_tables")
      .select("pos_x, pos_y")
      .eq("id", tableIds[label]!)
      .single();
    return data;
  };
  await signInViaUi(page, owner);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/app/${w}/seating/${event}`);

  // Unplaced tables open on a tidy layout, with the honest "not to scale" note, and nothing is saved yet.
  const plan = page.getByTestId("floor-plan");
  await expect(plan).toBeVisible();
  await expect(plan).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByText(/not to scale and is not a safety/)).toBeVisible();
  const garden = page.getByRole("button", { name: /^Garden, 0 of 8 seats/ });
  const orchard = page.getByRole("button", { name: /^Orchard, 0 of 8 seats/ });
  await expect(garden).toBeVisible();
  expect(await position("Garden")).toEqual({ pos_x: null, pos_y: null });
  // Mouse coordinates are viewport coordinates, so bring the item into view before measuring it.
  const measure = async (target: typeof garden) => {
    await target.scrollIntoViewIfNeeded();
    return (await target.boundingBox())!;
  };
  const before = await measure(garden);
  const planBox = (await plan.boundingBox())!;

  // Drag with the mouse; the move is saved and survives a reload.
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 120, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await position("Garden"))?.pos_x).not.toBeNull();
  const saved = (await position("Garden"))!;
  const unit = planBox.width / 120;
  const startUnits = {
    x: (before.x + before.width / 2 - planBox.x) / unit,
    y: (before.y + before.height / 2 - planBox.y) / unit,
  };
  expect(Math.abs(saved.pos_x! - (startUnits.x + 60 / unit))).toBeLessThan(2);
  expect(Math.abs(saved.pos_y! - (startUnits.y + 120 / unit))).toBeLessThan(2);
  await page.reload();
  await expect(plan).toHaveAttribute("data-hydrated", "true");
  const after = await measure(garden);
  const planAfter = (await plan.boundingBox())!;
  // Compare inside the plan, because the page may have scrolled differently after the reload.
  expect(Math.abs(after.x - planAfter.x - (before.x - planBox.x + 60))).toBeLessThan(unit * 2);
  expect(Math.abs(after.y - planAfter.y - (before.y - planBox.y + 120))).toBeLessThan(unit * 2);

  // A drag cannot leave the room: dragging far past the corner stops at the wall.
  const box = await measure(garden);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 600, box.y - 600, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await position("Garden"))?.pos_x).toBeLessThanOrEqual(8);
  expect((await position("Garden"))!.pos_y!).toBeLessThanOrEqual(8);
  expect((await position("Garden"))!.pos_x!).toBeGreaterThanOrEqual(0);

  // Keyboard: arrows nudge (Shift is bigger), the change is announced and saved, Enter opens its card.
  const start = (await position("Garden"))!;
  await garden.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByRole("status").filter({ hasText: /Garden at column/ })).toBeAttached();
  await expect.poll(async () => (await position("Garden"))?.pos_x).toBe(start.pos_x! + 1);
  expect((await position("Garden"))!.pos_y).toBe(start.pos_y! + 5);

  // Opening a table shows its tray with the typed alternative to dragging.
  const tray = page.getByRole("dialog");
  await openTableTray(page, page.getByRole("button", { name: /^Orchard, 0 of 8 seats/ }));
  await expect(tray.getByRole("heading", { level: 2, name: "Orchard" })).toBeVisible();
  await tray.getByLabel("Column").fill("90");
  await tray.getByLabel("Row").fill("60");
  await tray.getByRole("button", { name: /to here$/ }).click();
  await expect(tray).toBeHidden();
  await expect.poll(async () => (await position("Orchard"))?.pos_x).toBe(90);
  expect(await position("Orchard")).toEqual({ pos_x: 90, pos_y: 60 });
  // Out-of-range input is explained and nothing moves.
  await openTableTray(page, orchard);
  await tray.getByLabel("Column").fill("500");
  await tray.getByRole("button", { name: /to here$/ }).click();
  await expect(tray.getByText("Enter a whole number from 0 to 120.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tray).toBeHidden();
  expect(await position("Orchard")).toEqual({ pos_x: 90, pos_y: 60 });

  // Add a dance floor in a tray; it lands in free space, can be edited and removed.
  await page.getByRole("button", { name: "Add to the room" }).click();
  await tray.getByLabel("What is it?").selectOption({ label: "Dance floor" });
  await tray.getByRole("button", { name: "Add to the room" }).click();
  await expect(tray).toBeHidden();
  const floor = page.getByRole("button", { name: /^Dance floor, room item/ });
  await expect(floor).toBeVisible();
  await floor.click();
  await tray.getByLabel("Name").fill("Main floor");
  await tray.getByLabel("Width").fill("200");
  await tray.getByRole("button", { name: "Save Dance floor" }).click();
  await expect(tray.getByText("Enter a whole number from 2 to 120.")).toBeVisible();
  await tray.getByLabel("Width").fill("30");
  await tray.getByRole("button", { name: "Save Dance floor" }).click();
  await expect(tray).toBeHidden();
  await expect(page.getByRole("button", { name: /^Main floor, room item/ })).toBeVisible();
  await page.getByRole("button", { name: /^Main floor, room item/ }).click();
  await tray.getByRole("button", { name: "Remove Main floor" }).click();
  await expect(tray).toBeHidden();
  await expect(page.getByRole("button", { name: /room item/ })).toHaveCount(0);

  // Zoom makes the plan wider than its frame, inside its own scroll area, not the page.
  const widthAt = async () => (await plan.boundingBox())!.width;
  const w1 = await widthAt();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByText("150%")).toBeVisible();
  expect(await widthAt()).toBeGreaterThan(w1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

  // Overlap is flagged as advice, not blocked.
  await rpc("move_seating_table", {
    p_wedding: w,
    p_table: tableIds.Orchard!,
    p_x: (await position("Garden"))!.pos_x,
    p_y: (await position("Garden"))!.pos_y,
  });
  await page.reload();
  await expect(page.getByText("Garden and Orchard overlap on the floor plan.")).toBeVisible();
  await expect(plan).toHaveAttribute("data-hydrated", "true");

  // The list view carries the same tables for anyone who prefers it.
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(page.getByTestId("floor-plan")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Details and edit for Garden" })).toBeVisible();
  await page.getByRole("link", { name: "Floor plan", exact: true }).click();
  await expect(page.getByTestId("floor-plan")).toBeVisible();

  // A phone: the plan scrolls inside its frame, tables stay tappable, the page never scrolls sideways.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/app/${w}/seating/${event}`);
  const small = (await page
    .getByRole("button", { name: /^Garden, \d+ of \d+ seats/ })
    .boundingBox())!;
  expect(small.width).toBeGreaterThanOrEqual(44);
  expect(small.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/screenshots/320/seating-floor-plan.png",
    fullPage: true,
  });
});

test("numbered seats: chips on the plan and in the tray, number, swap, move and clear", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const owner = await appUser("seat-numbers");
  const { w, event } = await seed(owner);
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const r = await owner.client.rpc(fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.data;
  };
  const layout = (await rpc("ensure_seating_layout", {
    p_wedding: w,
    p_event_id: event,
  })) as string;
  const table = (await rpc("add_seating_table", {
    p_wedding: w,
    p_layout: layout,
    p_label: "Garden",
    p_capacity: 4,
  })) as string;
  const { data: guestRows } = await owner.client
    .from("guests")
    .select("id, full_name")
    .eq("wedding_id", w);
  const guestId = (name: string) => guestRows!.find((g) => g.full_name === name)!.id as string;
  // Ada has seat 2; Bo and Cy are at the table with no seat number yet.
  await rpc("assign_guest_seat", {
    p_wedding: w,
    p_layout: layout,
    p_guest: guestId("Ada Example"),
    p_table: table,
    p_seat: 2,
  });
  for (const name of ["Bo Example", "Cy Example"]) {
    await rpc("assign_guest_seat", {
      p_wedding: w,
      p_layout: layout,
      p_guest: guestId(name),
      p_table: table,
    });
  }
  const seatOf = async (name: string) =>
    (
      await owner.client
        .from("seat_assignments")
        .select("seat_number")
        .eq("guest_id", guestId(name))
        .single()
    ).data?.seat_number ?? null;

  await signInViaUi(page, owner);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/app/${w}/seating/${event}`);
  const plan = page.getByTestId("floor-plan");
  await expect(plan).toHaveAttribute("data-hydrated", "true");

  // Chips sit round the table on the plan: three filled, one empty (decorative, hidden from assistive tech).
  await expect(plan.locator("[data-chip=seated]")).toHaveCount(3);
  await expect(plan.locator("[data-chip=empty]")).toHaveCount(1);
  await page.getByRole("button", { name: "Zoom in" }).click(); // 150%: initials appear
  await expect(plan.locator("[data-chip=seated]", { hasText: "AE" })).toHaveCount(1);
  await page.getByRole("button", { name: "Zoom out" }).click();

  const tray = page.getByRole("dialog");
  await openTableTray(page, page.getByRole("button", { name: /^Garden, 3 of 4 seats/ }));
  await expect(tray.getByRole("heading", { name: "Seat numbers" })).toBeVisible();
  await expect(tray.getByRole("button", { name: "Seat 2, Ada Example" })).toBeVisible();
  await expect(tray.getByRole("button", { name: "Seat 1, empty" })).toBeVisible();
  await expect(tray.getByText("No seat number yet:")).toBeVisible();
  await expect(tray.getByText("Bo Example, Cy Example")).toBeVisible();

  // The chips are at least 44px tall and the tray passes axe with a seat open.
  const chip = tray.getByRole("button", { name: "Seat 2, Ada Example" });
  expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);

  // Number the seats: lowest free numbers in name order (Bo 1, Cy 3), Ada keeps 2.
  await tray.getByRole("button", { name: /^Number the seats/ }).click();
  await expect(tray.getByText("Numbered 2 seats.")).toBeVisible();
  await expect.poll(() => seatOf("Bo Example")).toBe(1);
  expect(await seatOf("Cy Example")).toBe(3);
  expect(await seatOf("Ada Example")).toBe(2);
  await expect(tray.getByText("No seat number yet:")).toHaveCount(0);

  // Swap Ada (seat 2) with Bo (seat 1).
  await tray.getByLabel("Swap Ada Example with").selectOption({ label: "Bo Example (seat 1)" });
  await tray.getByRole("button", { name: "Swap places" }).click();
  await expect(tray.getByText("Swapped places.")).toBeVisible();
  await expect.poll(() => seatOf("Ada Example")).toBe(1);
  expect(await seatOf("Bo Example")).toBe(2);

  // Move Cy to the empty seat 4, then clear Cy's number and put Cy back in seat 3 from the empty seat.
  await tray.getByRole("button", { name: "Seat 3, Cy Example" }).click();
  await tray.getByLabel("Move Cy Example to an empty seat").selectOption({ label: "Seat 4" });
  await tray.getByRole("button", { name: "Move to that seat" }).click();
  await expect(tray.getByText("Seat 4.")).toBeVisible();
  await expect.poll(() => seatOf("Cy Example")).toBe(4);
  // The selection follows Cy to seat 4.
  await expect(tray.getByRole("button", { name: "Seat 4, Cy Example" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await tray.getByRole("button", { name: /^Clear seat number/ }).click();
  await expect.poll(() => seatOf("Cy Example")).toBeNull();
  await expect(tray.getByText("No seat number yet:")).toBeVisible();
  await tray.getByRole("button", { name: "Seat 3, empty" }).click();
  await tray.getByLabel("Put someone in seat 3").selectOption({ label: "Cy Example" });
  await tray.getByRole("button", { name: "Put in seat 3" }).click();
  await expect.poll(() => seatOf("Cy Example")).toBe(3);

  // Seat numbers reach the frozen copy.
  await page.keyboard.press("Escape");
  await expect(tray).toBeHidden();
  await page.reload();
  await expect(plan).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: "Finalize this plan" }).click();
  await expect(page.getByText(/Finalized/).first()).toBeVisible();
  const { data: frozen } = await owner.client
    .from("seating_layouts")
    .select("snapshot")
    .eq("id", layout)
    .single();
  const frozenSeats = (
    frozen!.snapshot as { tables: { guests: { name: string; seat: number | null }[] }[] }
  ).tables[0]!.guests.map((g) => `${g.name}:${g.seat}`);
  expect(frozenSeats.sort()).toEqual(["Ada Example:1", "Bo Example:2", "Cy Example:3"]);

  // At 320 the tray still works without sideways scrolling.
  await page.setViewportSize({ width: 320, height: 700 });
  await openTableTray(page, page.getByRole("button", { name: /^Garden, 3 of 4 seats/ }));
  await expect(tray.getByRole("button", { name: "Seat 1, Ada Example" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("floor plan cards: tap a table or seat for a card beside it, hover names a seat, Edit opens the tray", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = await appUser("seat-cards");
  const { w, event } = await seed(owner);
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const r = await owner.client.rpc(fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.data;
  };
  const layout = (await rpc("ensure_seating_layout", {
    p_wedding: w,
    p_event_id: event,
  })) as string;
  const table = (await rpc("add_seating_table", {
    p_wedding: w,
    p_layout: layout,
    p_label: "Garden",
    p_capacity: 4,
  })) as string;
  const { data: guestRows } = await owner.client
    .from("guests")
    .select("id, full_name")
    .eq("wedding_id", w);
  const guestId = (name: string) => guestRows!.find((g) => g.full_name === name)!.id as string;
  // Ada has seat 2; Bo and Cy have no number yet and are drawn in seats 1 and 3; seat 4 is empty.
  await rpc("assign_guest_seat", {
    p_wedding: w,
    p_layout: layout,
    p_guest: guestId("Ada Example"),
    p_table: table,
    p_seat: 2,
  });
  for (const name of ["Bo Example", "Cy Example"]) {
    await rpc("assign_guest_seat", {
      p_wedding: w,
      p_layout: layout,
      p_guest: guestId(name),
      p_table: table,
    });
  }

  await signInViaUi(page, owner);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/app/${w}/seating/${event}`);
  const plan = page.getByTestId("floor-plan");
  await expect(plan).toHaveAttribute("data-hydrated", "true");
  const gardenTable = page.getByRole("button", { name: /^Garden, 3 of 4 seats/ });
  const seatButton = (n: number) => plan.locator(`[data-floor-seat="${n}"]`);
  const card = page.getByRole("dialog");
  const tip = page.getByTestId("seat-tip");

  // Hover names the person in a seat, or says it is empty; it goes away with the pointer.
  await expect(seatButton(2)).toHaveAccessibleName("Garden, seat 2, Ada Example");
  await seatButton(2).hover();
  await expect(tip).toHaveText("Ada Example");
  await page.screenshot({ path: "test-results/screenshots/1280/seating-seat-hover.png" });
  await seatButton(4).hover();
  await expect(tip).toHaveText("Seat 4, empty");
  await page.mouse.move(5, 5);
  await expect(tip).toHaveCount(0);

  // Tapping a table opens a card right beside it, with the facts and an Edit button; no tray yet.
  await gardenTable.click();
  await expect(card.getByRole("heading", { level: 2, name: "Garden" })).toBeVisible();
  await expect(card.getByText("3 of 4 taken, 1 open")).toBeVisible();
  await expect(card.getByText("3 attending")).toBeVisible();
  const tableBox = (await gardenTable.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  const gapX = Math.max(
    cardBox.x - (tableBox.x + tableBox.width),
    tableBox.x - (cardBox.x + cardBox.width),
  );
  const gapY = Math.max(
    cardBox.y - (tableBox.y + tableBox.height),
    tableBox.y - (cardBox.y + cardBox.height),
  );
  // Beside it, not on top of it and not far away.
  expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(0);
  expect(Math.max(gapX, gapY)).toBeLessThan(120);
  expect(cardBox.x).toBeGreaterThanOrEqual(0);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(1280);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations.map((x) => x.id)).toEqual([]);
  await page.screenshot({ path: "test-results/screenshots/1280/seating-card-table.png" });

  // Tapping the table again puts the card away; Escape does too and focus goes back to the table.
  await gardenTable.click();
  await expect(card).toHaveCount(0);
  await gardenTable.click();
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(gardenTable).toBeFocused();

  // Edit opens the large tray for the table; closing it returns focus to the table.
  await openTableTray(page, gardenTable);
  await expect(card.getByRole("heading", { level: 2, name: "Garden" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Seat numbers" })).toBeVisible();
  await expect(card.getByRole("group", { name: /^Seat \d/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(gardenTable).toBeFocused();

  // Tapping a seat: a card for the person in it.
  await seatButton(2).click();
  await expect(card.getByRole("heading", { level: 2, name: "Ada Example" })).toBeVisible();
  await expect(card.getByText("Garden, seat 2")).toBeVisible();
  await expect(card.getByText("Attending")).toBeVisible();
  await expect(card.getByText("Meal")).toBeVisible();
  await expect(seatButton(2)).toHaveAttribute("aria-expanded", "true");
  await expect(tip).toHaveCount(0); // the hover label steps aside while the card is open
  await page.screenshot({ path: "test-results/screenshots/1280/seating-card-seat.png" });

  // A guest with no saved number is drawn in a free seat and the card says so.
  await seatButton(1).click();
  await expect(card.getByRole("heading", { level: 2, name: "Bo Example" })).toBeVisible();
  await expect(card.getByText(/No seat number saved yet/)).toBeVisible();

  // An empty seat: a card that says so, not an invented guest.
  await seatButton(4).click();
  await expect(card.getByRole("heading", { level: 2, name: "Seat 4" })).toBeVisible();
  await expect(card.getByText("No one is in this seat.")).toBeVisible();
  await expect(card.getByText("Meal")).toHaveCount(0);

  // Tapping the plan elsewhere closes the card.
  await page.mouse.click(tableBox.x + tableBox.width + 300, tableBox.y + tableBox.height + 150);
  await expect(card).toHaveCount(0);

  // Edit on a seat opens the table tray on that seat, ready to change it.
  await openTrayFromCard(page, seatButton(2), /^Edit seat/);
  await expect(card.getByRole("heading", { level: 2, name: "Garden" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Seat 2, Ada Example" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(card.getByRole("group", { name: "Seat 2" })).toBeVisible();
  await expect(page.locator("dialog[data-state=open]")).toBeVisible();
  await page.waitForTimeout(350); // let the slide-in finish so the screenshot shows the tray
  await page.screenshot({ path: "test-results/screenshots/1280/seating-seat-tray.png" });
  // Swap is disabled (no one else is numbered), so focus lands on the first usable control.
  await expect(card.getByLabel("Move Ada Example to an empty seat")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(seatButton(2)).toBeFocused();

  // The empty seat's Edit opens the tray with that seat's "put someone here" form.
  await openTrayFromCard(page, seatButton(4), /^Edit seat/);
  await expect(card.getByRole("group", { name: "Seat 4" })).toBeVisible();
  await expect(card.getByText("Seat 4 is empty.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();

  // The seat editor's own line for the guest links to their page too.
  await openTrayFromCard(page, seatButton(2), /^Edit seat/);
  const adaId = guestId("Ada Example");
  await expect(card.getByRole("link", { name: /^Ada Example/ })).toHaveAttribute(
    "href",
    `/app/${w}/guests/${adaId}`,
  );
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();

  // The name in a seat's card links out to that guest's own page (name, household, notes).
  await seatButton(2).click();
  await card.getByRole("link", { name: /^Ada Example/ }).click();
  await page.waitForURL(`**/app/${w}/guests/${adaId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Ada Example" })).toBeVisible();
  await page.goto(`/app/${w}/seating/${event}`);
  await expect(plan).toHaveAttribute("data-hydrated", "true");
  // An empty seat has no guest, so no link.
  await seatButton(4).click();
  await expect(card.getByRole("link")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A phone: the card stays on screen, its buttons are comfortable targets, nothing scrolls sideways.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/app/${w}/seating/${event}`);
  await expect(plan).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click(); // 200%: bigger seat targets
  const phoneSeat = seatButton(2);
  await phoneSeat.scrollIntoViewIfNeeded();
  await phoneSeat.click();
  await expect(card.getByRole("heading", { level: 2, name: "Ada Example" })).toBeVisible();
  const phoneCard = (await card.boundingBox())!;
  expect(phoneCard.x).toBeGreaterThanOrEqual(0);
  expect(phoneCard.x + phoneCard.width).toBeLessThanOrEqual(320);
  expect(phoneCard.y).toBeGreaterThanOrEqual(0);
  expect(phoneCard.y + phoneCard.height).toBeLessThanOrEqual(800);
  const edit = (await card.getByRole("button", { name: /^Edit seat/ }).boundingBox())!;
  expect(edit.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/screenshots/320/seating-card-seat.png" });
  await card.getByRole("button", { name: /^Edit seat/ }).click();
  await expect(card.getByRole("group", { name: "Seat 2" })).toBeVisible();
  // On a phone the seat's form is below the fold of the bottom sheet, so the tray scrolls it into view.
  await expect(card.getByRole("group", { name: "Seat 2" })).toBeInViewport();
  await expect(card.getByLabel("Move Ada Example to an empty seat")).toBeFocused();
});

test("suggested seating: review, infeasible groups reported, refused after a change, applied", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = await appUser("seat-suggest");
  const { w, event } = await seed(owner);
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const r = await owner.client.rpc(fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.data;
  };
  const layout = (await rpc("ensure_seating_layout", {
    p_wedding: w,
    p_event_id: event,
  })) as string;
  const addTable = (label: string, capacity: number) =>
    rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: label,
      p_capacity: capacity,
    });
  const seated = async () =>
    (await owner.client.from("seat_assignments").select("guest_id").eq("layout_id", layout)).data!
      .length;
  const { data: guestRows } = await owner.client
    .from("guests")
    .select("id, full_name")
    .eq("wedding_id", w);
  const guestId = (name: string) => guestRows!.find((g) => g.full_name === name)!.id as string;

  // Ada, Bo and Cy are attending and share an invitation; the only table seats two.
  await addTable("Small", 2);
  await signInViaUi(page, owner);
  await page.goto(`/app/${w}/seating/${event}?view=list`);
  const tray = page.getByRole("dialog");
  await page.getByRole("button", { name: "Suggest seating" }).click();
  await expect(tray.getByText("No one can be seated this way right now.")).toBeVisible();
  await expect(
    tray.getByText(/Needs 3 seats together, but no table has more than 2 open/),
  ).toBeVisible();
  await expect(tray.getByRole("button", { name: /this way/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(tray).toBeHidden();

  // With a table of three the whole invitation fits; nothing is saved by looking.
  await addTable("Garden", 3);
  await page.reload();
  await page.getByRole("button", { name: "Suggest seating" }).click();
  await expect(tray.getByText("3 guests across 1 table.")).toBeVisible();
  const proposed = tray.getByRole("list", { name: "Proposed seating" });
  await expect(proposed.getByText("Garden")).toBeVisible();
  await expect(proposed.getByText("Ada Example, Bo Example, Cy Example")).toBeVisible();
  await expect(tray.getByText("Vegetarian")).toHaveCount(0);
  expect(await seated()).toBe(0);

  // Axe with the review open, and no sideways scroll at 320.
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations.map((x) => x.id)).toEqual([]);
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/screenshots/320/seating-suggestion.png" });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Someone changes the plan while the review is open: applying is refused and nothing is seated.
  await rpc("assign_guest_seat", {
    p_wedding: w,
    p_layout: layout,
    p_guest: guestId("Ada Example"),
    p_table: (
      await owner.client
        .from("seating_tables")
        .select("id")
        .eq("layout_id", layout)
        .eq("label", "Small")
        .single()
    ).data!.id,
  });
  await tray.getByRole("button", { name: "Seat 3 guests this way" }).click();
  await expect(tray.getByRole("alert")).toContainText("The plan changed after this suggestion");
  expect(await seated()).toBe(1);

  // A fresh review keeps Bo and Cy together (Ada is already seated and is not moved) and applies.
  await page.keyboard.press("Escape");
  await expect(tray).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Suggest seating" }).click();
  await expect(tray.getByText("2 guests across 1 table.")).toBeVisible();
  await expect(tray.getByText("Bo Example, Cy Example")).toBeVisible();
  await tray.getByRole("button", { name: "Seat 2 guests this way" }).click();
  await expect(tray).toBeHidden();
  await expect(page.getByRole("heading", { name: "Guests to seat (0)" })).toBeVisible();
  expect(await seated()).toBe(3);
  await expect(page.getByRole("button", { name: "Suggest seating" })).toHaveCount(0);
});
