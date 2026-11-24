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

// UX-17 last slice: day-of check-in. A helper marks guests and a vendor as arrived, separately from
// who said yes, finds a guest who never answered, undoes a mistaken tap and downloads attendance.
// Drives the real app against the local Supabase stack; DAY_OF_CHECKIN=on in the E2E env.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for check-in specs");
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

/** Reception on 12 June 2027 (New York). Ada and Bo (one household) said yes; Cy never answered. */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Check-in Wedding", tz: ZONE });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  const ids: Record<string, string> = {};
  for (const name of NAMES) {
    ids[name] = await rpc<string>(
      owner.client.rpc("create_guest", {
        p_wedding: w,
        p_guest: name === "Cy Example" ? { name } : { name, household: "Example family" },
      }),
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
  for (const name of ["Ada Example", "Bo Example"]) {
    await rpc(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: w,
        p_member_id: members.find((m) => m.guest_id === ids[name])!.id,
        p_status: "accepted",
        p_reason: "Told us in person",
      }),
    );
  }
  const vendor = await rpc<string>(
    owner.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "vendor",
      p_category: "photographer",
      p_name: "Lens Example",
    }),
  );
  await rpc(
    owner.client.rpc("set_event_vendors", {
      p_wedding: w,
      p_event: reception,
      p_add: [vendor],
      p_remove: [],
    }),
  );
  return { owner, w, reception, ids, vendor };
}

test("check guests and a vendor in on the day, apart from who said yes", async ({ page }) => {
  const f = await setup("checkin-flow");
  await page.setViewportSize({ width: 390, height: 900 });
  await signInViaUi(page, f.owner);

  await page.goto(`/app/${f.w}/plan/day-of/${f.reception}`);
  await page.getByRole("link", { name: "Check-in on the day" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Check-in for Reception" }),
  ).toBeVisible();
  const summary = page.getByTestId("checkin-guest-summary");
  await expect(summary).toHaveText("0 of 2 expected guests have arrived.");

  // By default only the guests who said yes and have not arrived are listed.
  const rows = page.getByTestId("checkin-guest");
  await expect(rows).toHaveCount(2);
  await expect(page.getByText("Cy Example")).toHaveCount(0);

  // One tap checks in the whole household; the list and the count update.
  await rows
    .filter({ hasText: "Ada Example" })
    .getByRole("button", { name: /^Check in the whole household \(2\)/ })
    .click();
  await expect(summary).toHaveText("2 of 2 expected guests have arrived.");
  await expect(page.getByText("Everyone who said yes has arrived.")).toBeVisible();

  // Cy never answered but turned up: search looks at everyone invited, and Cy is counted apart.
  await page.getByLabel("Find a guest").fill("cy");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Hasn't answered");
  await rows.first().getByRole("button", { name: "Check in Cy Example" }).click();
  await expect(summary).toHaveText(
    "2 of 2 expected guests have arrived. 1 more arrived without saying yes.",
  );

  // A mistaken tap is undone from the Arrived list.
  await page.getByLabel("Find a guest").fill("");
  await page.getByRole("button", { name: "Arrived", exact: true }).click();
  await expect(rows).toHaveCount(3);
  await rows
    .filter({ hasText: "Cy Example" })
    .getByRole("button", { name: "Undo check-in for Cy Example" })
    .click();
  await expect(rows).toHaveCount(2);
  await expect(summary).toHaveText("2 of 2 expected guests have arrived.");

  // Vendors: marked arrived, then undone.
  const vendorSummary = page.getByTestId("checkin-vendor-summary");
  await expect(vendorSummary).toHaveText("0 of 1 vendor has arrived.");
  const vendor = page.getByTestId("checkin-vendor");
  await vendor.getByRole("button", { name: "Mark arrived Lens Example" }).click();
  await expect(vendorSummary).toHaveText("1 of 1 vendor has arrived.");
  await expect(vendor).toContainText("Arrived");
  await vendor.getByRole("button", { name: "Undo arrival for Lens Example" }).click();
  await expect(vendorSummary).toHaveText("0 of 1 vendor has arrived.");

  // Attendance lists everyone invited, with who arrived. Names and replies only.
  const csv = await page.request.get(`/app/${f.w}/plan/day-of/${f.reception}/check-in/export`);
  expect(csv.status()).toBe(200);
  const lines = (await csv.text())
    .replace(/^\u{feff}/u, "")
    .split("\r\n")
    .filter(Boolean);
  expect(lines[0]).toBe("Guest,Household,Reply,Arrived,Checked in at");
  expect(lines).toHaveLength(4);
  expect(lines[1]).toMatch(
    /^Ada Example,Example family,Said yes,Yes,"[A-Z][a-z]{2} \d+, .*(EDT|EST)"$/,
  );
  expect(lines[3]).toBe("Cy Example,,Hasn't answered,No,");
});

test("a viewer sees vendor arrivals but cannot record them or see guests", async ({ page }) => {
  const f = await setup("checkin-viewer");
  await rpc(
    f.owner.client.rpc("record_vendor_arrival", {
      p_wedding: f.w,
      p_event: f.reception,
      p_candidate: f.vendor,
    }),
  );
  const viewer = await appUser("checkin-viewer-user");
  await rpc(
    adminClient()
      .from("memberships")
      .insert({ wedding_id: f.w, user_id: viewer.id, role: "viewer", permissions: {} }),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/day-of/${f.reception}/check-in`);
  await expect(page.getByText("limited to people who manage guests")).toBeVisible();
  await expect(page.getByTestId("checkin-guest")).toHaveCount(0);
  await expect(page.getByTestId("checkin-vendor-summary")).toHaveText("1 of 1 vendor has arrived.");
  await expect(page.getByRole("button", { name: /Undo arrival|Mark arrived/ })).toHaveCount(0);
  await expect(page.getByText("You can see arrivals but not record them.")).toBeVisible();
  const csv = await page.request.get(`/app/${f.w}/plan/day-of/${f.reception}/check-in/export`);
  expect(csv.status()).toBe(404);
});

test("the check-in page passes axe and fits at 320, 390 and 1280", async ({ page }) => {
  const f = await setup("checkin-a11y");
  await rpc(
    f.owner.client.rpc("check_in_guests", {
      p_wedding: f.w,
      p_event: f.reception,
      p_guests: [f.ids["Ada Example"]],
    }),
  );
  await signInViaUi(page, f.owner);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${f.w}/plan/day-of/${f.reception}/check-in`);
    await expect(page.getByTestId("checkin-guest").first()).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `checkin@${width}: ${x.id}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `checkin@${width} overflow`).toBeLessThanOrEqual(0);
    // Touch targets stay at least 44px tall.
    const small = await page
      .getByTestId("checkin-guest")
      .first()
      .getByRole("button")
      .evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).length);
    expect(small, `checkin@${width} small buttons`).toBe(0);
    await page.screenshot({
      path: `test-results/screenshots/${width}/check-in.png`,
      fullPage: true,
    });
  }
});
