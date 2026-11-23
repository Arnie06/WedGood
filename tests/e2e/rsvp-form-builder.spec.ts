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

// UX-11: the couple adds their own questions to an event's guest reply, publishes them, guests
// answer them, and the couple reads the answers. Real local stack; the suite runs with
// RSVP_FORM_BUILDER=on (playwright.config.ts). Every name and answer is synthetic.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for RSVP specs");
}
test.skip(!stackUp, "Local Supabase stack is not running (pnpm db:start)");

const password = "correct-horse-battery";
const SONG = "SENTINEL-song Dancing Example";

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

async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

/** The Examples (Ada, Bo) invited to a Reception with no meals and no plus-one places. */
async function seed(label: string) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, { name: "Questions (example)" });
  await ok(
    owner.client.rpc("commit_guest_import", {
      p_wedding: wedding,
      p_rows: [
        { name: "Ada Example", household: "The Examples" },
        { name: "Bo Example", household: "The Examples" },
      ],
      p_idempotency_key: `seed-${randomUUID()}`,
    }),
  );
  const { guests, household } = await withSuperuser(async (db) => ({
    guests: (
      await db.query("select id from public.guests where wedding_id=$1", [wedding])
    ).rows.map((r) => r.id as string),
    household: (await db.query("select id from public.households where wedding_id=$1", [wedding]))
      .rows[0].id as string,
  }));
  const eventId = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: wedding,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  )) as string;
  const raw = randomBytes(32).toString("base64url");
  await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: wedding,
      p_event_id: eventId,
      p_groups: [{ guestIds: guests, householdId: household }],
      p_plus_one_quota: 0,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [createHash("sha256").update(raw).digest("hex")],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  return { owner, wedding, eventId, path: `/rsvp/${raw}` };
}

async function checkPage(page: Page, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, `${name} axe`).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${name} overflow`).toBeLessThanOrEqual(0);
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: `test-results/screenshots/${width}/${name}.png`, fullPage: true });
}

test("the couple builds and publishes questions, a guest answers them, and the couple reads the answers", async ({
  page,
  browser,
}) => {
  const { owner, wedding, path } = await seed("form-builder");
  await signInViaUi(page, owner);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/app/${wedding}/guests/invitations`);

  // ---- build
  await page.getByRole("button", { name: "Guest questions (0)" }).click();
  const tray = page.getByRole("dialog", { name: "Guest questions" });
  await expect(tray.getByText("Nothing published yet.")).toBeVisible();
  await expect(tray.getByText("Who's coming?")).toBeVisible(); // a locked built-in step

  await tray.getByLabel("Add a question").selectOption("text");
  await tray.getByRole("button", { name: "Add question" }).click();
  // The new question's first field gets focus.
  await expect(tray.getByLabel("Question", { exact: true }).first()).toBeFocused();
  await page.keyboard.type("Song request");

  await tray.getByLabel("Add a question").selectOption("yes_no");
  await tray.getByRole("button", { name: "Add question" }).click();
  await tray.getByLabel("Question", { exact: true }).nth(1).fill("Need the shuttle?");
  await tray.getByLabel("Guests must answer").nth(1).check();

  await tray.getByLabel("Add a question").selectOption("choice");
  await tray.getByRole("button", { name: "Add question" }).click();
  // Saving with empty choices is stopped in the browser and the problem is shown.
  await tray.getByRole("button", { name: "Save draft" }).click();
  await expect(tray.getByText("Write the question.")).toBeVisible();
  await tray.getByLabel("Question", { exact: true }).nth(2).fill("Arriving");
  await tray.getByLabel("Choice 1", { exact: true }).fill("Friday");
  await tray.getByLabel("Choice 2", { exact: true }).fill("Saturday");

  // Reorder by keyboard-reachable buttons: shuttle first.
  await tray.getByRole("button", { name: 'Move "Need the shuttle?" up' }).click();
  await expect(tray.getByText(/^Question 1 · Yes or no/)).toBeVisible();

  await tray.getByRole("button", { name: "Preview as a guest" }).click();
  await expect(tray.getByRole("group", { name: /Need the shuttle\? \(required\)/ })).toBeVisible();
  await checkPage(page, "form-builder@390");

  await tray.getByRole("button", { name: "Save draft" }).click();
  await expect(tray.getByText("Draft saved. Guests don't see it until you publish.")).toBeVisible();
  await tray.getByRole("button", { name: "Publish…" }).click();
  await expect(tray.getByText("New question: Need the shuttle?")).toBeVisible();
  await tray.getByRole("button", { name: "Publish to guests" }).click();
  await expect(tray.getByText(/Published version 1\./)).toBeVisible();
  await expect(tray.getByText(/Guests see version 1/)).toBeVisible();
  await page.keyboard.press("Escape");

  // ---- answer, as a guest on a phone
  const ctx = await browser.newContext({ viewport: { width: 320, height: 800 } });
  const guest = await ctx.newPage();
  await guest.goto(path);
  await guest
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await guest.getByRole("group", { name: "Bo Example" }).getByLabel("Not attending").check();
  await guest.getByRole("button", { name: "Next" }).click();
  // Notes for the couple (UX-07), then the couple's questions.
  await guest.getByRole("button", { name: "Next" }).click();
  await expect(
    guest.getByRole("heading", { level: 2, name: /Step 3 of 4: A few more questions/ }),
  ).toBeFocused();
  // Only Ada is attending, so only Ada is asked.
  await expect(guest.getByRole("group", { name: "Bo Example" })).toHaveCount(0);
  await guest.getByRole("button", { name: "Next" }).click();
  await expect(guest.getByText('Answer "Need the shuttle?" for Ada Example.')).toBeVisible();
  await expect(guest.getByRole("radio", { name: "Yes" })).toBeFocused();
  await checkPage(guest, "guest-questions@320");
  await guest.getByRole("radio", { name: "Yes" }).check();
  await guest.getByLabel("Song request").fill(SONG);
  await guest.getByRole("radio", { name: "Saturday" }).check();
  await guest.getByRole("button", { name: "Next" }).click();
  await expect(guest.getByText(/Need the shuttle: Yes · Song request: SENTINEL/)).toBeVisible();
  await guest.getByRole("button", { name: "Send my reply" }).click();
  await expect(
    guest.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();

  // Reopening the link never shows the answers, only that they are saved.
  await guest.reload();
  await expect(guest.getByText("Answers to the couple's questions are saved.")).toBeVisible();
  expect(await guest.content()).not.toContain("SENTINEL");
  await guest.getByRole("button", { name: "Edit questions" }).click();
  await expect(guest.getByText(/Your answer is saved and isn't shown here/).first()).toBeVisible();
  // The saved answer counts: no "required" error on Next.
  await guest.getByRole("button", { name: "Next" }).click();
  await expect(guest.getByRole("heading", { level: 2, name: /Check your reply/ })).toBeVisible();
  await ctx.close();

  // ---- read, as the couple
  await page.goto(`/app/${wedding}/guests/invitations`);
  await page.getByRole("button", { name: "Answers to your questions for Reception" }).click();
  const answers = page.getByRole("dialog", { name: "Answers to your questions" });
  const shuttle = answers.getByRole("region", { name: "Need the shuttle?" });
  await expect(shuttle.getByRole("listitem").filter({ hasText: "Yes" })).toContainText("1");
  await expect(answers.getByRole("region", { name: "Song request" })).toContainText(SONG);
  await expect(answers.getByRole("region", { name: "Song request" })).toContainText("Ada Example");
  await checkPage(page, "form-answers@390");
  await page.keyboard.press("Escape");

  // The send record says which form was answered.
  await page.getByRole("button", { name: /^Sent once by the guest/ }).click();
  const sent = page.getByRole("dialog", { name: "What the guest sent" });
  await expect(sent).toContainText("answered your questions for 1 person");
  await expect(sent).toContainText("Your questions, version 1");

  // A published question's type is locked.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Guest questions (3)" }).click();
  await expect(
    page.getByRole("dialog", { name: "Guest questions" }).getByText(/stays a .Yes or no. question/),
  ).toBeVisible();

  // Desktop layout of the builder.
  await page.setViewportSize({ width: 1280, height: 900 });
  await checkPage(page, "form-builder@1280");
});
