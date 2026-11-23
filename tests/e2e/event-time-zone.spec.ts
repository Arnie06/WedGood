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

// REL-12: an event may have its own time zone; the agenda and the Event page read in it.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for event time zone specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");

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

/** A New York wedding with a Reception and a Ceremony, each with one item at 21:00 UTC (5:00 PM EDT). */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Zone Wedding", tz: "America/New_York" });
  const mk = async (name: string, kind: string, itemTitle: string) => {
    const id = await rpc<string>(
      owner.client.rpc("create_event", {
        p_wedding: w,
        p_event: { name, kind, localDate: "2027-06-12" },
      }),
    );
    await rpc(
      owner.client.rpc("create_timeline_item", {
        p_wedding: w,
        p_event: id,
        p_title: itemTitle,
        p_starts_at: "2027-06-12T21:00:00Z",
      }),
    );
    return id;
  };
  const reception = await mk("Reception", "reception", "Toasts");
  const ceremony = await mk("Ceremony", "ceremony", "Vows");
  return { owner, w, reception, ceremony };
}

test("choose a zone for one event: the preview, the Event page, the agenda and the edit form follow it", async ({
  page,
}) => {
  const f = await setup("tz-flow");
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);

  // Before: the wedding's zone.
  const agenda = page.getByTestId("agenda-preview");
  await expect(agenda).toContainText("5:00 PM");
  await expect(page.getByText("Times in EDT.")).toBeVisible();

  await page.getByRole("button", { name: "Edit event" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit event" });
  const zone = dialog.getByLabel("Time zone");
  await expect(zone).toHaveValue("");
  await expect(zone.locator("option").first()).toHaveText("Same as the wedding (America/New York)");
  // No change, no preview.
  await expect(dialog.getByRole("status")).toHaveCount(0);

  await zone.selectOption("Europe/Rome");
  const preview = dialog.getByRole("status");
  await expect(preview).toContainText("The 1 agenda item keeps the same moment");
  await expect(preview).toContainText(
    "“Toasts” now shows as 5:00 PM EDT, and would show as 11:00 PM",
  );
  // Back to where it was: the preview goes away again.
  await zone.selectOption("");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await zone.selectOption("Europe/Rome");
  await dialog.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // After: the same moment on Rome's clock.
  await expect(agenda).toContainText("11:00 PM");
  await expect(agenda).not.toContainText("5:00 PM");
  await expect(page.getByText("Times in GMT+2.")).toBeVisible();

  // The agenda page and the handoff say whose clock this is, and the edit form reads in it.
  await page.goto(`/app/${f.w}/plan/day-of/${f.reception}`);
  await expect(
    page.getByText(/times are local to Europe\/Rome \(GMT\+2\), this event's own zone/),
  ).toBeVisible();
  await page.getByText("Edit", { exact: false }).filter({ hasText: "Toasts" }).first().click();
  await expect(page.getByText("Local time, GMT+2").first()).toBeVisible();
  await expect(page.getByLabel("Starts").first()).toHaveValue("23:00");
  await page.goto(`/app/${f.w}/plan/day-of/${f.reception}/handoff`);
  await expect(page.getByText(/all times local to Europe\/Rome \(GMT\+2\)/)).toBeVisible();
  await expect(page.getByText("11:00 PM").first()).toBeVisible();

  // The other event still follows the wedding.
  await page.goto(`/app/${f.w}/plan/day-of/${f.ceremony}`);
  await expect(page.getByText(/times are local to America\/New York \(EDT\)\./)).toBeVisible();
  await expect(page.getByText("own zone")).toHaveCount(0);
  await page.goto(`/app/${f.w}/plan/events/${f.ceremony}`);
  await expect(page.getByTestId("agenda-preview")).toContainText("5:00 PM");

  // Back to the wedding's zone: the same moment on the first clock again.
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await page.getByRole("button", { name: "Edit event" }).click();
  await page.getByRole("dialog", { name: "Edit event" }).getByLabel("Time zone").selectOption("");
  await page
    .getByRole("dialog", { name: "Edit event" })
    .getByRole("button", { name: "Save event" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("agenda-preview")).toContainText("5:00 PM");
});

test("a zone chosen when an event is created is kept", async ({ page }) => {
  const f = await setup("tz-create");
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events`);
  await page.getByRole("button", { name: "Add an event" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an event" });
  await dialog.getByLabel("Event name").fill("Welcome drinks");
  await dialog.getByLabel("Time zone").selectOption("Asia/Tokyo");
  await dialog.getByRole("button", { name: "Add event" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("link", { name: /Welcome drinks/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Edit event" }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit event" }).getByLabel("Time zone"),
  ).toHaveValue("Asia/Tokyo");
});

test("a viewer reads the agenda in the event's zone and cannot change it", async ({ page }) => {
  const f = await setup("tz-viewer");
  await rpc(
    f.owner.client.rpc("update_event", {
      p_wedding: f.w,
      p_event_id: f.reception,
      p_expected_version: 1,
      p_event: {
        name: "Reception",
        kind: "reception",
        localDate: "2027-06-12",
        timeZone: "Europe/Rome",
      },
    }),
  );
  const viewer = await appUser("tz-viewer-member");
  const raw = randomBytes(32).toString("base64url");
  await rpc(
    f.owner.client.rpc("create_collaborator_invite", {
      p_wedding: f.w,
      p_email: viewer.email,
      p_role: "viewer",
      p_token_hash: sha(raw),
    }),
  );
  await rpc(viewer.client.rpc("redeem_collaborator_invite", { p_token_hash: sha(raw) }));
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await expect(page.getByTestId("agenda-preview")).toContainText("11:00 PM");
  await expect(page.getByText("Times in GMT+2.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit event" })).toHaveCount(0);
});

test("layout and accessibility: the zone field and preview, at 320 and 1280", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await setup("tz-layout");
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["event-zone", `/app/${f.w}/plan/events/${f.reception}`],
      ["agenda-zone", `/app/${f.w}/plan/day-of/${f.reception}`],
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
    }
    await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
    await page.getByRole("button", { name: "Edit event" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit event" });
    await dialog.getByLabel("Time zone").selectOption("Pacific/Auckland");
    await expect(dialog.getByRole("status")).toBeVisible();
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return box ? box.x + box.width : Infinity;
      })
      .toBeLessThanOrEqual(width);
    expect((await dialog.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    const results = await new AxeBuilder({ page })
      .include("dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `tray@${width}: ${x.id}`)).toEqual([]);
    await page.screenshot({ path: `test-results/screenshots/${width}/event-zone-tray.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});
