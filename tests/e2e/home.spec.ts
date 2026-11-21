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
  throw new Error("CI must provide the local Supabase stack for home specs");
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

test("one workspace goes straight in; the full list stays reachable", async ({ page }) => {
  const owner = await appUser("home-one");
  const wedding = await createWedding(owner, { name: "Only One" });
  await signInViaUi(page, owner);
  await expect(page).toHaveURL(new RegExp(`/app/${wedding}$`));

  await page.goto("/app?all=1");
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await expect(page.getByText("Only One")).toBeVisible();
});

test("several workspaces still show the picker", async ({ page }) => {
  const owner = await appUser("home-two");
  await createWedding(owner, { name: "First Wedding", key: `k-${randomUUID()}` });
  await createWedding(owner, { name: "Second Wedding", key: `k-${randomUUID()}` });
  await signInViaUi(page, owner);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open" })).toHaveCount(2);
});

test("an empty workspace is guided; the budget target is set inline", async ({ page }) => {
  const owner = await appUser("home-quick");
  const wedding = await createWedding(owner, { name: "Quick Set" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}`);

  const next = page.getByRole("region", { name: "Next up" });
  await expect(next.getByText("Pick your wedding date")).toBeVisible();
  await expect(next.getByRole("link", { name: "Add your date" })).toBeVisible();
  // At most three prompts, one primary.
  await expect(next.getByRole("listitem")).toHaveCount(2);

  const budget = page.getByLabel(/^Budget target/);
  await expect(budget).toBeVisible();
  await budget.fill("not money");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/valid|number|amount/i).first()).toBeVisible();
  await expect(budget).toHaveValue("not money");

  await budget.fill("25000");
  await page.getByRole("button", { name: "Save" }).click();
  // The prompt resolves itself and the value shows under Event details. A confirmation toast
  // arrives with UX-03, since the prompt unmounts on revalidation.
  await expect(page.getByLabel(/^Budget target/)).toHaveCount(0);
  await expect(page.getByText("$25,000.00").first()).toBeVisible();
});

test("a stale quick-set is refused and saves nothing", async ({ page }) => {
  const owner = await appUser("home-stale");
  const wedding = await createWedding(owner, { name: "Stale" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}`);
  await withSuperuser((db) =>
    db.query("update public.weddings set version = version + 1 where id = $1", [wedding]),
  );
  await page.getByLabel(/^Budget target/).fill("1000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert").or(page.getByText(/changed|reload|newer/i))).not.toHaveCount(
    0,
  );
  const saved = await withSuperuser((db) =>
    db.query("select target_budget_minor from public.weddings where id = $1", [wedding]),
  );
  expect(saved.rows[0].target_budget_minor).toBeNull();
});

test("a viewer sees no setup prompts they cannot act on", async ({ page }) => {
  const owner = await appUser("home-owner");
  const viewer = await appUser("home-viewer");
  const wedding = await createWedding(owner, { name: "Viewer Test" });
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}`);
  await expect(page.getByRole("region", { name: "Next up" })).toHaveCount(0);
  await expect(page.getByLabel(/^Budget target/)).toHaveCount(0);
});

test("the header shows days to go, and Home passes axe at 320 and 1280", async ({ page }) => {
  const owner = await appUser("home-a11y");
  const date = new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10);
  const wedding = await createWedding(owner, {
    name: "A Very Long Wedding Name For The Header",
    date,
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/app/${wedding}`);
    await expect(page.getByRole("banner").getByText(/days to go/)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
