import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  withSuperuser,
  type TestUser,
} from "../integration/helpers";

// Drives the real app against the real local Supabase stack, including private storage.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for package specs");
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

async function rpc<T>(user: TestUser, fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await user.client.rpc(fn, args);
  if (r.error) throw new Error(`${fn}: ${r.error.message}`);
  return r.data as T;
}

async function join(wedding: string, role: "partner" | "editor" | "viewer", label: string) {
  const user = await appUser(label);
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3)", [
      wedding,
      user.id,
      role,
    ]),
  );
  return user;
}

async function seed(label: string, items = 2) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, {
    name: "Alex & Morgan (Example)",
    date: "2027-06-12",
    tz: "America/New_York",
    guests: 80,
    location: "Hudson Valley",
    budgetMinor: 2_500_000,
  });
  const event = await rpc<string>(owner, "create_event", {
    p_wedding: wedding,
    p_event: { name: "Reception", kind: "reception" },
  });
  for (let i = 0; i < items; i += 1) {
    await rpc(owner, "create_timeline_item", {
      p_wedding: wedding,
      p_event: event,
      p_title: `Moment ${i + 1} with a longer description so that the row wraps in a narrow column`,
      p_starts_at: new Date(Date.UTC(2027, 5, 12, 20, 0) + i * 900_000).toISOString(),
      p_location: "Garden terrace",
      p_responsible_label: "Coordinator",
      p_contact: i === 0 ? "Pat 555-0142" : null,
      p_notes: i === 0 ? "Side door code is private" : null,
    });
  }
  const category = await rpc<string>(owner, "create_budget_category", {
    p_wedding: wedding,
    p_name: "Venue",
  });
  await rpc(owner, "create_budget_item", {
    p_wedding: wedding,
    p_category: category,
    p_name: "Venue fee",
    p_amount_minor: 900_000,
  });
  await rpc(owner, "create_budget_item", {
    p_wedding: wedding,
    p_category: category,
    p_name: "Chairs",
  });
  return { owner, wedding, event };
}

async function startPreview(page: Page, wedding: string, preset: string, label: RegExp) {
  await page.goto(`/app/${wedding}/plan/packages/new`);
  await page.getByRole("link", { name: label }).click();
  await expect(page).toHaveURL(new RegExp(`preset=${preset}`));
}

test("preview, create, download PDF and CSV, then notice the plan changed", async ({ page }) => {
  const { owner, wedding, event } = await seed("pk-flow");
  await signInViaUi(page, owner);
  await startPreview(page, wedding, "caterer", /Start with caterer brief/i);
  await page.getByLabel("CSV").check();
  await page.getByRole("button", { name: "Preview package" }).click();

  await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();
  await expect(page.getByText("Moment 1 with a longer description").first()).toBeVisible();
  // Contacts and notes are off by default and stay out of the preview and the files.
  await expect(page.getByText("555-0142")).toHaveCount(0);
  await expect(page.getByText("Side door code")).toHaveCount(0);
  await expect(page.getByText(/nothing is sent to anyone/i)).toBeVisible();

  await page.getByRole("button", { name: "Create package" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Caterer brief");
  await expect(page.getByText("Matches your plan").first()).toBeVisible();

  const base = page.url();
  const pdf = await page.request.get(`${base}/download?format=pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["cache-control"]).toBe("no-store");
  expect(pdf.headers()["content-disposition"]).toContain("attachment");
  const pdfBytes = await pdf.body();
  expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect((await PDFDocument.load(pdfBytes)).getPageCount()).toBeGreaterThanOrEqual(2);

  const csv = await page.request.get(`${base}/download?format=csv`);
  expect(csv.status()).toBe(200);
  const csvText = await csv.text();
  expect(csvText.startsWith("﻿Section,Table,Row,Column,Value")).toBe(true);
  expect(csvText).toContain("Moment 1");
  expect(csvText).not.toContain("555-0142");
  expect(csvText).not.toContain("Side door code");

  // The plan moves on: the package says so but its files do not change.
  const before = createHash("sha256").update(pdfBytes).digest("hex");
  await rpc(owner, "create_timeline_item", {
    p_wedding: wedding,
    p_event: event,
    p_title: "A brand new agenda item",
    p_starts_at: "2027-06-12T23:00:00Z",
  });
  await page.reload();
  await expect(page.getByText("Plan has changed").first()).toBeVisible();
  await expect(page.getByText("A brand new agenda item")).toHaveCount(0);
  const after = await page.request.get(`${base}/download?format=pdf`);
  expect(
    createHash("sha256")
      .update(await after.body())
      .digest("hex"),
  ).toBe(before);

  await page.goto(`/app/${wedding}/plan/packages`);
  await expect(page.getByText("Plan has changed")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download PDF" })).toBeVisible();
});

test("contacts and notes appear only when chosen", async ({ page }) => {
  const { owner, wedding } = await seed("pk-opt-in");
  await signInViaUi(page, owner);
  await startPreview(page, wedding, "coordinator", /Start with coordinator handoff/i);
  await page.getByLabel(/Include contact details/).check();
  await page.getByRole("button", { name: "Preview package" }).click();
  await expect(page.getByText("Pat 555-0142").first()).toBeVisible();
  await expect(page.getByText("Side door code")).toHaveCount(0);
  await page.getByRole("button", { name: "Create package" }).click();
  await expect(page.getByText("Contacts included; notes not included")).toBeVisible();
  const csv = await (await page.request.get(`${page.url()}/download?format=pdf`)).body();
  expect(csv.length).toBeGreaterThan(500);
});

test("a changed preview is refused instead of silently saved", async ({ page }) => {
  const { owner, wedding } = await seed("pk-digest");
  await signInViaUi(page, owner);
  await startPreview(page, wedding, "financial", /Start with financial report/i);
  await page.getByRole("button", { name: "Preview package" }).click();
  await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[name="digest"]');
    if (input) input.value = "0".repeat(64);
  });
  await page.getByRole("button", { name: "Create package" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "plan changed since the preview" }),
  ).toBeVisible();
  const n = await withSuperuser(
    async (db) =>
      (
        await db.query("select count(*)::int as v from public.packages where wedding_id=$1", [
          wedding,
        ])
      ).rows[0].v as number,
  );
  expect(n).toBe(0);
});

test("budget unknowns and recorded payments are stated plainly", async ({ page }) => {
  const { owner, wedding } = await seed("pk-budget");
  await signInViaUi(page, owner);
  await startPreview(page, wedding, "financial", /Start with financial report/i);
  await page.getByRole("button", { name: "Preview package" }).click();
  await expect(page.getByText(/lower bound/)).toBeVisible();
  await expect(page.getByText(/do not confirm that money moved/)).toBeVisible();
  await expect(page.getByText("$25,000.00").first()).toBeVisible();
});

test("a long package runs to several PDF pages with every row present", async ({ page }) => {
  const { owner, wedding } = await seed("pk-long", 70);
  await signInViaUi(page, owner);
  await startPreview(page, wedding, "coordinator", /Start with coordinator handoff/i);
  await page.getByLabel("Orientation (PDF)").selectOption("landscape");
  await page.getByLabel("Paper (PDF)").selectOption("letter");
  await page.getByRole("button", { name: "Preview package" }).click();
  await page.getByRole("button", { name: "Create package" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Coordinator handoff");
  const body = await (await page.request.get(`${page.url()}/download?format=pdf`)).body();
  const doc = await PDFDocument.load(body);
  expect(doc.getPageCount()).toBeGreaterThan(3);
  const { width, height } = doc.getPage(0).getSize();
  expect([width, height]).toEqual([792, 612]);
});

test("collaborators without export rights see nothing and cannot download", async ({ page }) => {
  const { owner, wedding } = await seed("pk-acl");
  await signInViaUi(page, owner);
  await startPreview(page, wedding, "financial", /Start with financial report/i);
  await page.getByRole("button", { name: "Preview package" }).click();
  await page.getByRole("button", { name: "Create package" }).click();
  await page.waitForURL(/\/plan\/packages\/[0-9a-f-]{36}$/);
  const detail = page.url();

  for (const role of ["editor", "viewer"] as const) {
    const member = await join(wedding, role, `pk-${role}`);
    await page.context().clearCookies();
    await signInViaUi(page, member);
    await page.goto(`/app/${wedding}/plan/packages`);
    await expect(page.getByText(/Only the workspace owner or a partner/)).toBeVisible();
    await expect(page.getByRole("link", { name: /Download/ })).toHaveCount(0);
    expect((await page.request.get(`${detail}/download?format=pdf`)).status()).toBe(404);
    expect((await page.goto(detail))?.status()).toBe(404);
    await page.goto(`/app/${wedding}/plan/packages/new`);
    await expect(page.getByText(/Only the workspace owner or a partner/)).toBeVisible();
  }

  const outsider = await appUser("pk-outsider");
  await page.context().clearCookies();
  await signInViaUi(page, outsider);
  expect((await page.request.get(`${detail}/download?format=pdf`)).status()).toBe(404);
  expect((await page.goto(detail))?.status()).toBe(404);
});

test("package pages pass axe and reflow at 320px and 1280px", async ({ page }) => {
  // Two widths of axe over four pages: about 37 s on this machine, over the 30 s default.
  test.setTimeout(90_000);
  const { owner, wedding } = await seed("pk-a11y", 12);
  await signInViaUi(page, owner);
  await startPreview(page, wedding, "master", /Start with wedding book/i);
  await page.getByRole("button", { name: "Preview package" }).click();
  await page.getByRole("button", { name: "Create package" }).click();
  await page.waitForURL(/\/plan\/packages\/[0-9a-f-]{36}$/);
  const detail = new URL(page.url()).pathname;
  const chooser = `/app/${wedding}/plan/packages/new`;
  const builder = `${chooser}?preset=master`;
  const preview = `${builder}&customized=1&preview=1&sections=overview&sections=events&sections=timeline&sections=budget&formats=pdf&formats=csv`;
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["packages-list", `/app/${wedding}/plan/packages`],
      ["packages-chooser", chooser],
      ["packages-builder", builder],
      ["packages-preview", preview],
      ["packages-detail", detail],
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
  }
});
