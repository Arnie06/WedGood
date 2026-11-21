import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
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
  throw new Error("CI must provide the local Supabase stack for tray specs");
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

const boxOf = async (page: Page, name: string) =>
  (await page.getByRole("dialog", { name }).boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };

test("on a wide screen the tray slides in from the right, full height", async ({ page }) => {
  const owner = await appUser("tray-wide");
  const wedding = await createWedding(owner, { name: "Tray Wide" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);
  await page.getByRole("button", { name: "Add a task" }).click();
  await expect(page.getByRole("dialog", { name: "Add a task" })).toBeVisible();
  await expect(async () => {
    const box = await boxOf(page, "Add a task");
    expect(Math.round(box.x + box.width)).toBe(1280); // flush with the right edge
    expect(Math.round(box.height)).toBe(800); // full height
    expect(box.width).toBeLessThan(600);
  }).toPass();
});

test("on a phone the tray is a bottom sheet", async ({ page }) => {
  const owner = await appUser("tray-phone");
  const wedding = await createWedding(owner, { name: "Tray Phone" });
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);
  await page.getByRole("button", { name: "Add a task" }).click();
  await expect(async () => {
    const box = await boxOf(page, "Add a task");
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844); // sits on the bottom edge
    expect(box.height).toBeLessThan(844);
  }).toPass();
});

test("Escape and the backdrop close it, focus returns to the trigger, and the form is unmounted", async ({
  page,
}) => {
  const owner = await appUser("tray-close");
  const wedding = await createWedding(owner, { name: "Tray Close" });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);
  const trigger = page.getByRole("button", { name: "Add a task" });

  await trigger.click();
  await expect(page.getByLabel(/^Task/)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Add a task" })).toBeHidden();
  await expect(trigger).toBeFocused();
  // Closed trays hold no form, so a long list is not carrying hundreds of hidden fields.
  await expect(page.locator("dialog input")).toHaveCount(0);

  await trigger.click();
  await page.mouse.click(10, 10); // the backdrop, outside the tray
  await expect(page.getByRole("dialog", { name: "Add a task" })).toBeHidden();
});

test("a saved edit closes the tray and confirms with a toast", async ({ page }) => {
  const owner = await appUser("tray-save");
  const wedding = await createWedding(owner, { name: "Tray Save" });
  await owner.client.rpc("create_task", {
    p_wedding: wedding,
    p_title: "Taste the cake",
    p_idempotency_key: `k-${randomUUID()}`,
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/plan`);
  await page.getByRole("button", { name: 'Edit "Taste the cake"' }).click();
  const tray = page.getByRole("dialog", { name: "Edit task" });
  await tray.getByLabel(/^Notes/).fill("Lemon");
  await tray.getByRole("button", { name: "Save changes" }).click();
  await expect(tray).toBeHidden();
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Task saved.");
});

test("trays pass axe and do not overflow at 320 and 1280, with a tray open", async ({ page }) => {
  const owner = await appUser("tray-a11y");
  const wedding = await createWedding(owner, { name: "Tray A11y" });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [path, button, dialog] of [
      [`/app/${wedding}/plan`, "Add a task", "Add a task"],
      [`/app/${wedding}/guests`, "Add a guest", "Add a guest"],
      [`/app/${wedding}/discover`, "Add a venue", "Add a venue"],
      [`/app/${wedding}/guests/invitations`, "Add an event", "Add an event"],
    ] as const) {
      await page.goto(path);
      await page.getByRole("button", { name: button }).click();
      await expect(page.getByRole("dialog", { name: dialog })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((v) => `${path}@${width}: ${v.id}`)).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }
  }
});

test("opening trays across the main pages raises no console or hydration errors", async ({
  page,
}) => {
  const owner = await appUser("tray-console");
  const wedding = await createWedding(owner, { name: "Tray Console" });
  await owner.client.rpc("create_task", {
    p_wedding: wedding,
    p_title: "A task row with a tray",
    p_idempotency_key: `k-${randomUUID()}`,
  });
  await signInViaUi(page, owner);

  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));

  for (const [path, button] of [
    ["plan", "Add a task"],
    ["guests", "Add a guest"],
    ["discover", "Add a venue"],
    ["guests/invitations", "Add an event"],
    ["plan/budget", "Add a category"],
  ] as const) {
    await page.goto(`/app/${wedding}/${path}`);
    await page.getByRole("button", { name: button }).click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  // A row-level tray: the task title opens an edit tray.
  await page.goto(`/app/${wedding}/plan`);
  await page.getByRole("button", { name: 'Edit "A task row with a tray"' }).click();
  await expect(page.getByRole("dialog", { name: "Edit task" })).toBeVisible();
  await page.keyboard.press("Escape");

  expect(problems).toEqual([]);
});
