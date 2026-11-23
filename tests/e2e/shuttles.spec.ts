import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  type TestUser,
} from "../integration/helpers";

// UX-17 first slice: guest shuttles. A planner adds a shuttle, puts a household on it with the
// checkbox list (no drag), sees it fill, downloads the rider list, and a decline takes the guest
// off. Drives the real app against the local Supabase stack; GUEST_SHUTTLES=on in the E2E env.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for shuttle specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const ZONE = "America/New_York";
const NAMES = ["Ada Example", "Bo Example", "Cy Example"];

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

async function rpc<T>(
  p: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T> {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

/** Reception on 12 June 2027 (New York); Ada, Bo and Cy invited and attending. */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Shuttle Wedding", tz: ZONE });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  const ids: Record<string, string> = {};
  for (const name of NAMES) {
    ids[name] = await rpc<string>(
      owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } }),
    );
  }
  await rpc(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: reception,
      p_groups: [{ guestIds: NAMES.map((n) => ids[n]), householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [sha(randomBytes(32).toString("base64url"))],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  const members = await rpc<{ id: string; guest_id: string }[]>(
    adminClient().from("invitation_members").select("id, guest_id").eq("event_id", reception),
  );
  const memberOf = (name: string) => members.find((m) => m.guest_id === ids[name])!.id;
  for (const name of NAMES) {
    await rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: memberOf(name),
        p_status: "accepted",
        p_reason: "Told us in person",
      }),
    );
  }
  return { owner, w, reception, ids, memberOf };
}

test("plan a shuttle, fill it without dragging, export it, and a decline frees the seat", async ({
  page,
}) => {
  const f = await setup("shuttle-flow");
  await page.setViewportSize({ width: 390, height: 900 });
  await signInViaUi(page, f.owner);

  // The event page points to shuttles.
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await expect(page.getByTestId("shuttle-totals")).toHaveText(
    "No shuttles planned for this event.",
  );
  await page.getByRole("link", { name: "Plan shuttles for Reception" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Shuttles for Reception" }),
  ).toBeVisible();
  await expect(page.getByTestId("shuttle-coverage")).toContainText(
    "0 of 3 attending guests have a ride to the event.",
  );

  // Add a shuttle; a bad seat count is explained and the typed details are kept.
  await page.getByRole("button", { name: "Add a shuttle there" }).click();
  const tray = page.getByRole("dialog", { name: "Add a shuttle" });
  await tray.getByLabel(/^Name/).fill("Hotel shuttle");
  await tray.getByLabel(/^Pickup point/).fill("Grand Hotel lobby");
  await tray.getByLabel(/^Drop-off point/).fill("Rose Hall");
  await expect(tray.getByLabel(/^Date/)).toHaveValue("2027-06-12");
  await tray.getByLabel(/^Departs \(EDT\)/).fill("15:30");
  await tray.getByLabel(/^Seats/).fill("0");
  await tray.getByRole("button", { name: "Add shuttle" }).click();
  await expect(tray.getByText("Enter a whole number of seats from 1 to 100.")).toBeVisible();
  await expect(tray.getByLabel(/^Name/)).toHaveValue("Hotel shuttle");
  await tray.getByLabel(/^Seats/).fill("2");
  await tray.getByRole("button", { name: "Add shuttle" }).click();
  await expect(tray).toBeHidden();

  const run = page.getByTestId("shuttle-run");
  await expect(run.getByRole("heading", { level: 3, name: "Hotel shuttle" })).toBeVisible();
  await expect(run).toContainText("Departs 3:30 PM");
  await expect(run).toContainText("From Grand Hotel lobby to Rose Hall");
  await expect(run.getByTestId("run-seats")).toHaveText("0 of 2 seats taken");

  // Put two guests on it with checkboxes; a third would be more than the open seats.
  await run.getByRole("button", { name: "Add riders to Hotel shuttle" }).click();
  const riders = page.getByRole("dialog", { name: "Add riders to Hotel shuttle" });
  await riders.getByRole("checkbox", { name: "Ada Example" }).check();
  await riders.getByRole("checkbox", { name: "Bo Example" }).check();
  await riders.getByRole("checkbox", { name: "Cy Example" }).check();
  await expect(
    riders.getByText("That's more guests than open seats.", { exact: false }),
  ).toBeVisible();
  await expect(riders.getByRole("button", { name: /^Add 3 to Hotel shuttle/ })).toBeDisabled();
  await riders.getByRole("checkbox", { name: "Cy Example" }).uncheck();
  await riders.getByRole("button", { name: "Add 2 to Hotel shuttle" }).click();
  await expect(riders).toBeHidden();
  await expect(run.getByTestId("run-seats")).toHaveText("2 of 2 seats taken · Full");
  await expect(
    run.getByRole("list", { name: "Riders on Hotel shuttle" }).getByRole("listitem"),
  ).toHaveCount(2);
  await expect(run.getByRole("button", { name: "Add riders to Hotel shuttle" })).toHaveCount(0);
  await expect(page.getByTestId("shuttle-coverage")).toContainText(
    "2 of 3 attending guests have a ride to the event.",
  );
  await page.getByText("Attending without a ride there (1)").click();
  await expect(page.getByTestId("shuttles-to_event").getByText("Cy Example")).toBeVisible();

  // The rider list has names and times only.
  const csv = await page.request.get(`/app/${f.w}/plan/events/${f.reception}/shuttles/export`);
  expect(csv.status()).toBe(200);
  const text = (await csv.text()).replace(/^﻿/, "");
  expect(text.split("\r\n").filter(Boolean)).toEqual([
    "Direction,Shuttle,Departs,Pickup,Drop-off,Guest",
    'To the event,Hotel shuttle,"Jun 12, 3:30 PM EDT",Grand Hotel lobby,Rose Hall,Ada Example',
    'To the event,Hotel shuttle,"Jun 12, 3:30 PM EDT",Grand Hotel lobby,Rose Hall,Bo Example',
  ]);

  // Ada declines (recorded by the couple): she comes off the shuttle in the same change.
  await rpc(
    f.owner.client.rpc("override_rsvp_response", {
      p_wedding: f.w,
      p_member_id: f.memberOf("Ada Example"),
      p_status: "declined",
      p_reason: "Called to say they can't come",
    }),
  );
  await page.reload();
  await expect(run.getByTestId("run-seats")).toHaveText("1 of 2 seats taken");
  await expect(run).not.toContainText("Ada Example");

  // Take Bo off by hand.
  await run.getByRole("button", { name: "Take off Bo Example from Hotel shuttle" }).click();
  await expect(run.getByTestId("run-seats")).toHaveText("0 of 2 seats taken");

  // Editing keeps the event's clock; removing explains what happens.
  await run.getByRole("button", { name: "Edit Hotel shuttle" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Hotel shuttle" });
  await expect(edit.getByLabel(/^Departs \(EDT\)/)).toHaveValue("15:30");
  await edit.getByLabel(/^Departs \(EDT\)/).fill("16:00");
  await edit.getByRole("button", { name: "Save shuttle" }).click();
  await expect(edit).toBeHidden();
  await expect(run).toContainText("Departs 4:00 PM");
  await run.getByRole("button", { name: "Remove Hotel shuttle" }).click();
  await page.getByRole("button", { name: "Remove Hotel shuttle" }).last().click();
  await expect(page.getByTestId("shuttle-run")).toHaveCount(0);
});

test("a planner without the guest list sees no riders", async ({ page }) => {
  const f = await setup("shuttle-noaccess");
  const planner = await appUser("shuttle-planner");
  await rpc(
    adminClient()
      .from("memberships")
      .insert({ wedding_id: f.w, user_id: planner.id, role: "editor", permissions: {} }),
  );
  await signInViaUi(page, planner);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}/shuttles`);
  await expect(page.getByText("limited to people who manage guests")).toBeVisible();
  await expect(page.getByTestId("shuttles-page")).toHaveCount(0);
  const csv = await page.request.get(`/app/${f.w}/plan/events/${f.reception}/shuttles/export`);
  expect(csv.status()).toBe(404);
});

test("the shuttles page passes axe and fits at 320, 390 and 1280", async ({ page }) => {
  const f = await setup("shuttle-a11y");
  const run = await rpc<string>(
    f.owner.client.rpc("add_shuttle_run", {
      p_wedding: f.w,
      p_event: f.reception,
      p_direction: "from_event",
      p_label: "Late bus back to the Grand Hotel and the station",
      p_pickup: "Rose Hall front steps",
      p_dropoff: "",
      p_departs_at: "2027-06-13T03:30:00.000Z",
      p_capacity: 20,
      p_notes: "Driver waits ten minutes.",
    }),
  );
  await rpc(
    f.owner.client.rpc("assign_shuttle_guests", {
      p_wedding: f.w,
      p_run: run,
      p_guests: [f.ids["Ada Example"]],
    }),
  );
  await signInViaUi(page, f.owner);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/plan/events/${f.reception}/shuttles`);
    await expect(page.getByTestId("shuttle-run")).toContainText("Departs 11:30 PM");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `shuttles@${width}: ${x.id}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `shuttles@${width} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `test-results/screenshots/${width}/shuttles.png`,
      fullPage: true,
    });
    // The riders tray at this width too.
    await page.getByRole("button", { name: /^Add riders to Late bus/ }).click();
    const tray = page.getByRole("dialog");
    await expect(tray.getByRole("checkbox", { name: "Bo Example" })).toBeVisible();
    const trayResults = await new AxeBuilder({ page })
      .include("dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(trayResults.violations.map((x) => `shuttle-tray@${width}: ${x.id}`)).toEqual([]);
    await page.screenshot({ path: `test-results/screenshots/${width}/shuttles-tray.png` });
    await page.keyboard.press("Escape");
    await expect(tray).toBeHidden();
  }
});
