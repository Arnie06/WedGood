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

// REL-07: vendors assigned to events. Drives the real app against the local stack.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for event vendor specs");
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

/** Reception and Ceremony; vendors Lens Co (booked), Good Notes (saved) and a venue. */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Vendor Wedding", tz: "America/New_York" });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  const ceremony = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Ceremony", kind: "ceremony", localDate: "2027-06-12" },
    }),
  );
  const mk = (name: string, category: string) =>
    rpc<string>(
      owner.client.rpc("create_candidate", {
        p_wedding: w,
        p_kind: "vendor",
        p_category: category,
        p_name: name,
      }),
    );
  const lens = await mk("Lens Co", "photographer");
  const notes = await mk("Good Notes", "music");
  const barn = await rpc<string>(
    owner.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "venue",
      p_category: "venue",
      p_name: "Old Barn",
    }),
  );
  return { owner, w, reception, ceremony, lens, notes, barn };
}

async function book(f: Awaited<ReturnType<typeof setup>>) {
  const cat = await rpc<string>(
    f.owner.client.rpc("create_budget_category", { p_wedding: f.w, p_name: "Photo" }),
  );
  const item = await rpc<string>(
    f.owner.client.rpc("create_budget_item", {
      p_wedding: f.w,
      p_category: cat,
      p_name: "Photo package",
      p_amount_minor: 500_000,
    }),
  );
  return rpc<string>(
    f.owner.client.rpc("book_commitment", {
      p_wedding: f.w,
      p_candidate: f.lens,
      p_expected_candidate_version: 1,
      p_title: "Photo contract",
      p_amount_minor: 500_000,
      p_allocations: [{ itemId: item, amountMinor: 500_000 }],
      p_installments: [{ dueOn: "2027-05-08", amountMinor: 500_000 }],
      p_confirmed: true,
    }),
  );
}

async function join(owner: TestUser, w: string, role: "viewer", label: string) {
  const user = await appUser(label);
  const raw = randomBytes(32).toString("base64url");
  await rpc(
    owner.client.rpc("create_collaborator_invite", {
      p_wedding: w,
      p_email: user.email,
      p_role: role,
      p_token_hash: sha(raw),
    }),
  );
  await rpc(user.client.rpc("redeem_collaborator_invite", { p_token_hash: sha(raw) }));
  return user;
}

test("assign vendors from the event, then see them on the vendor, the agenda picker and the handoff", async ({
  page,
}) => {
  const f = await setup("ev-flow");
  await rpc(
    f.owner.client.rpc("create_timeline_item", {
      p_wedding: f.w,
      p_event: f.reception,
      p_title: "Photos",
      p_starts_at: "2027-06-12T21:00:00Z",
      p_vendor: f.lens,
      p_contact: "Mia 555-0100",
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);

  await expect(page.getByTestId("vendors-empty")).toContainText("No vendors assigned yet.");
  await page.getByRole("button", { name: "Assign vendors" }).click();
  const dialog = page.getByRole("dialog", { name: /Who works at Reception/ });
  // The venue is placed with "Where", so only vendors are offered.
  await expect(dialog.getByLabel(/Old Barn/)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await dialog.getByLabel(/Lens Co/).check();
  await dialog.getByLabel(/Good Notes/).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved. 2 added.")).toBeVisible();
  const list = page.getByTestId("event-vendors");
  await expect(list).toContainText("Lens Co");
  await expect(list).toContainText("Photographer");
  await expect(list).toContainText("Good Notes");

  // Take one away again, once the first tray has finished closing.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Change vendors" }).click();
  await page
    .getByRole("dialog", { name: /Who works at Reception/ })
    .getByLabel(/Good Notes/)
    .uncheck();
  await page
    .getByRole("dialog", { name: /Who works at Reception/ })
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByText("Saved. 1 removed.")).toBeVisible();
  await expect(list).not.toContainText("Good Notes");

  // The vendor's own page says where it works.
  await page.goto(`/app/${f.w}/discover/${f.lens}`);
  const works = page.getByTestId("works-at-events");
  await expect(works).toContainText("Reception");
  await expect(works).not.toContainText("Ceremony");

  // The agenda picker puts this event's vendors first.
  await page.goto(`/app/${f.w}/plan/day-of/${f.reception}`);
  await expect(page.getByTestId("agenda-vendors")).toContainText("Lens Co");
  const picker = page.getByLabel("Venue or vendor").last();
  const groups = await picker.locator("optgroup").evaluateAll((els) =>
    els.map((el) => ({
      label: el.getAttribute("label"),
      options: [...el.querySelectorAll("option")].map((o) => o.textContent),
    })),
  );
  expect(groups).toEqual([
    { label: "At this event", options: ["Lens Co"] },
    {
      label: "Other venues and vendors",
      options: expect.arrayContaining(["Good Notes", "Old Barn"]),
    },
  ]);

  // The handoff lists them with their agenda items and the contact written on those items.
  await page.goto(`/app/${f.w}/plan/day-of/${f.reception}/handoff`);
  const handoff = page.getByTestId("handoff-vendors");
  await expect(handoff).toContainText("Lens Co");
  await expect(handoff).toContainText("Photographer · Saved");
  await expect(handoff).toContainText("Photos");
  await expect(handoff).toContainText("Contact: Mia 555-0100");
  await expect(handoff).not.toContainText("Good Notes");
});

test("choose events from the booking page, and an amendment keeps them", async ({ page }) => {
  const f = await setup("ev-booking");
  const commitment = await book(f);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/budget/bookings/${commitment}`);

  await expect(page.getByTestId("works-at-empty")).toContainText("Not assigned to an event yet.");
  await page.getByRole("button", { name: "Choose events" }).click();
  const dialog = page.getByRole("dialog", { name: /Where does Lens Co work/ });
  await dialog.getByLabel(/Reception/).check();
  await dialog.getByLabel(/Ceremony/).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved. 2 added.")).toBeVisible();
  await expect(page.getByTestId("works-at-events")).toContainText("Reception");
  await expect(page.getByTestId("works-at-events")).toContainText("Ceremony");

  // Amend the contract: a new contract row, the same vendor, the same events.
  const next = await rpc<string>(
    f.owner.client.rpc("amend_commitment", {
      p_wedding: f.w,
      p_commitment: commitment,
      p_expected_version: 1,
      p_title: "Photo contract v2",
      p_amount_minor: 600_000,
      p_allocations: [
        {
          itemId: (
            await rpc<{ budget_item_id: string }[]>(
              adminClient()
                .from("commitment_allocations")
                .select("budget_item_id")
                .eq("commitment_id", commitment),
            )
          )[0]!.budget_item_id,
          amountMinor: 600_000,
        },
      ],
      p_installments: [{ dueOn: "2027-06-01", amountMinor: 600_000 }],
      p_confirmed: true,
    }),
  );
  await page.goto(`/app/${f.w}/plan/budget/bookings/${next}`);
  await expect(page.getByTestId("works-at-events")).toContainText("Reception");
  await expect(page.getByTestId("works-at-events")).toContainText("Ceremony");
});

test("an archived or passed vendor stays visible with its state, and can be removed", async ({
  page,
}) => {
  const f = await setup("ev-stale");
  await rpc(
    f.owner.client.rpc("set_event_vendors", {
      p_wedding: f.w,
      p_event: f.reception,
      p_add: [f.lens, f.notes],
      p_remove: [],
    }),
  );
  await rpc(
    f.owner.client.rpc("create_timeline_item", {
      p_wedding: f.w,
      p_event: f.reception,
      p_title: "First dance",
      p_starts_at: "2027-06-12T23:00:00Z",
      p_vendor: f.notes,
    }),
  );
  await adminClient().from("candidates").update({ stage: "declined" }).eq("id", f.lens);
  await adminClient()
    .from("candidates")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", f.notes);

  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, f.owner);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  const list = page.getByTestId("event-vendors");
  await expect(list).toContainText("Lens Co (passed)");
  await expect(list).toContainText("Good Notes (archived)");

  // The agenda item that names the archived vendor keeps it in the picker.
  await page.goto(`/app/${f.w}/plan/day-of/${f.reception}`);
  await page.getByText(/^Edit/).first().click();
  const picker = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Save changes" }) })
    .getByLabel("Venue or vendor");
  await expect(picker).toHaveValue(f.notes);
  await expect(picker.locator("option:checked")).toHaveText("Good Notes (archived)");

  // Clear the archived one from the event; the passed one cannot be added again once removed.
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await page.getByRole("button", { name: "Change vendors" }).click();
  const dialog = page.getByRole("dialog", { name: /Who works at Reception/ });
  await expect(dialog.getByLabel(/Good Notes \(archived\)/)).toBeChecked();
  await dialog.getByLabel(/Good Notes \(archived\)/).uncheck();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved. 1 removed.")).toBeVisible();
  await expect(list).not.toContainText("Good Notes");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Change vendors" }).click();
  await expect(
    page.getByRole("dialog", { name: /Who works at Reception/ }).getByLabel(/Good Notes/),
  ).toHaveCount(0);
});

test("a viewer sees who works at an event but cannot change it", async ({ page }) => {
  const f = await setup("ev-viewer");
  await rpc(
    f.owner.client.rpc("set_event_vendors", {
      p_wedding: f.w,
      p_event: f.reception,
      p_add: [f.lens],
      p_remove: [],
    }),
  );
  const viewer = await join(f.owner, f.w, "viewer", "ev-viewer-member");
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInViaUi(page, viewer);
  await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
  await expect(page.getByTestId("event-vendors")).toContainText("Lens Co");
  await expect(page.getByRole("button", { name: /Assign vendors|Change vendors/ })).toHaveCount(0);
  await page.goto(`/app/${f.w}/discover/${f.lens}`);
  await expect(page.getByTestId("works-at-events")).toContainText("Reception");
  await expect(page.getByRole("button", { name: "Choose events" })).toHaveCount(0);
});

test("accessible and within the screen at 320 and 1280, trays included", async ({ page }) => {
  // Two widths, three pages and a tray each: slow when other specs share the machine.
  test.setTimeout(90_000);
  const f = await setup("ev-a11y");
  await rpc(
    f.owner.client.rpc("set_event_vendors", {
      p_wedding: f.w,
      p_event: f.reception,
      p_add: [f.lens],
      p_remove: [],
    }),
  );
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["event-vendors", `/app/${f.w}/plan/events/${f.reception}`],
      ["vendor-works-at", `/app/${f.w}/discover/${f.lens}`],
      ["handoff-vendors", `/app/${f.w}/plan/day-of/${f.reception}/handoff`],
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
    await page.goto(`/app/${f.w}/plan/events/${f.reception}`);
    await page.getByRole("button", { name: "Change vendors" }).click();
    const dialog = page.getByRole("dialog", { name: /Who works at Reception/ });
    await dialog.getByLabel(/Good Notes/).check();
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
    await page.screenshot({ path: `test-results/screenshots/${width}/event-vendors-tray.png` });
    await page.keyboard.press("Escape");
  }
});
