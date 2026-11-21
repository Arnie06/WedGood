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
  throw new Error("CI must provide the local Supabase stack for document specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");

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

async function docCount(wedding: string): Promise<number> {
  return withSuperuser(async (db) =>
    Number(
      (
        await db.query("select count(*)::int as v from public.documents where wedding_id=$1", [
          wedding,
        ])
      ).rows[0].v,
    ),
  );
}

/** A wedding with a booked venue so there is something to attach a contract to. */
async function seed(label: string) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, { name: "Docs", guests: 100 });
  const category = await rpc<string>(owner, "create_budget_category", {
    p_wedding: wedding,
    p_name: "Venue",
  });
  const item = await rpc<string>(owner, "create_budget_item", {
    p_wedding: wedding,
    p_category: category,
    p_name: "Venue fee",
    p_amount_minor: 900_000,
  });
  const candidate = await rpc<string>(owner, "create_candidate", {
    p_wedding: wedding,
    p_kind: "venue",
    p_category: "venue",
    p_name: "Garden House",
  });
  const commitment = await rpc<string>(owner, "book_commitment", {
    p_wedding: wedding,
    p_candidate: candidate,
    p_expected_candidate_version: 1,
    p_title: "Venue contract",
    p_amount_minor: 1_000_000,
    p_allocations: [{ itemId: item, amountMinor: 1_000_000 }],
    p_installments: [],
    p_confirmed: true,
  });
  return { owner, wedding, commitment };
}

test("upload a contract, attach it to a booking, download it, then archive it", async ({
  page,
}) => {
  const { owner, wedding, commitment } = await seed("doc-flow");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/documents`);
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  await expect(page.getByText("No documents yet")).toBeVisible();

  await page.getByLabel(/^File/).setInputFiles({
    name: "venue-contract.pdf",
    mimeType: "application/pdf",
    buffer: PDF,
  });
  await page.getByLabel("Attach to (optional)").selectOption({ label: "Venue contract" });
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByText(/Document uploaded/)).toBeVisible();

  // The title defaulted from the file name; it is honestly labelled as not scanned.
  const card = page.getByRole("listitem").filter({ hasText: "venue-contract" });
  await expect(card.getByText("Not virus-scanned")).toBeVisible();
  await expect(card.getByText("Booking: Venue contract")).toBeVisible();
  expect(await docCount(wedding)).toBe(1);

  // Download goes through the authorized route and arrives as an attachment with the same bytes.
  const href = await card.getByRole("link", { name: /^Download/ }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"] ?? "").toContain("attachment");
  expect((await res.body()).equals(PDF)).toBe(true);

  // The booking page shows the attached document.
  await page.goto(`/app/${wedding}/plan/budget/bookings/${commitment}`);
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await expect(page.getByRole("link", { name: "venue-contract" })).toBeVisible();

  // Archive: gone from the list and from the download route.
  await page.goto(`/app/${wedding}/plan/documents`);
  const again = page.getByRole("listitem").filter({ hasText: "venue-contract" });
  await again.getByText("Attach, rename or archive").click();
  await again.getByRole("button", { name: "Archive this document" }).click();
  await expect(
    page.getByText("No documents yet").or(page.getByText("No documents match")),
  ).toBeVisible();
  expect((await page.request.get(href!)).status()).toBe(404);
});

test("files that fail validation are refused and leave nothing behind", async ({ page }) => {
  const { owner, wedding } = await seed("doc-bad");
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan/documents`);

  const attempts: { name: string; mimeType: string; buffer: Buffer; message: RegExp }[] = [
    {
      name: "contract.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("<html><script>alert(1)</script></html>"),
      message: /Only PDF, JPEG, PNG and WebP/,
    },
    {
      name: "photo.png",
      mimeType: "image/png",
      buffer: PDF,
      message: /contents don't match its type/,
    },
    {
      name: "active.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n<< /S /JavaScript /JS (app.alert(1)) >>"),
      message: /scripts or embedded files/,
    },
  ];
  for (const a of attempts) {
    await page
      .getByLabel(/^File/)
      .setInputFiles({ name: a.name, mimeType: a.mimeType, buffer: a.buffer });
    await page.getByRole("button", { name: "Upload document" }).click();
    await expect(page.getByText(a.message)).toBeVisible();
  }
  expect(await docCount(wedding)).toBe(0);
});

test("viewers and non-members cannot see or fetch documents", async ({ page, browser }) => {
  const { owner, wedding } = await seed("doc-roles");
  const id = await rpc<string>(owner, "create_document_intent", {
    p_wedding: wedding,
    p_kind: "contract",
    p_title: "Private contract",
    p_mime: "application/pdf",
    p_bytes: PDF.byteLength,
  });
  const key = `${wedding}/${id}`;
  await adminClient()
    .storage.from("wedding-documents")
    .upload(key, PDF, { contentType: "application/pdf" });
  const { createHash } = await import("node:crypto");
  await adminClient().rpc("complete_document", {
    p_document: id,
    p_checksum: createHash("sha256").update(PDF).digest("hex"),
    p_bytes: PDF.byteLength,
  });

  const viewer = await appUser("doc-viewer");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/plan/documents`);
  await expect(page.getByText(/private to the workspace owner and partner/)).toBeVisible();
  await expect(page.getByText("Private contract")).toHaveCount(0);
  expect((await page.request.get(`/app/${wedding}/plan/documents/${id}/download`)).status()).toBe(
    404,
  );

  const ctx = await browser.newContext();
  const outsider = await appUser("doc-outsider");
  const op = await ctx.newPage();
  await signInViaUi(op, outsider);
  expect((await op.request.get(`/app/${wedding}/plan/documents/${id}/download`)).status()).toBe(
    404,
  );
  const res = await op.goto(`/app/${wedding}/plan/documents`);
  expect(res?.status()).toBe(404);
  await ctx.close();
});

test("documents page passes axe and reflows at 320px and 1280px", async ({ page }) => {
  const { owner, wedding, commitment } = await seed("doc-a11y");
  for (const title of [
    "A contract with a very long name that has to wrap neatly on a narrow phone screen",
    "Deposit receipt",
  ]) {
    const id = await rpc<string>(owner, "create_document_intent", {
      p_wedding: wedding,
      p_kind: "contract",
      p_title: title,
      p_mime: "application/pdf",
      p_bytes: PDF.byteLength,
    });
    await adminClient().storage.from("wedding-documents").upload(`${wedding}/${id}`, PDF, {
      contentType: "application/pdf",
    });
    const { createHash } = await import("node:crypto");
    await adminClient().rpc("complete_document", {
      p_document: id,
      p_checksum: createHash("sha256").update(PDF).digest("hex"),
      p_bytes: PDF.byteLength,
    });
    await rpc(owner, "link_document", {
      p_wedding: wedding,
      p_document: id,
      p_target_type: "commitment",
      p_target: commitment,
    });
  }
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/${wedding}/plan/documents`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByText("Attach, rename or archive").first().click();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `documents@${width}: ${x.id}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `documents@${width} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `test-results/screenshots/${width}/documents.png`,
      fullPage: true,
    });
  }
});
