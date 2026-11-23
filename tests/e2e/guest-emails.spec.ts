import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  withSuperuser,
  type TestUser,
} from "../integration/helpers";

// UX-16: the guest's "Add to calendar" and the couple's guest email outbox, against the real local
// stack. The suite runs with GUEST_EMAIL=on and the labelled dev sink (playwright.config.ts), so an
// approved email is captured and reaches no one. Every name and address is synthetic.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for guest email specs");
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

async function signIn(page: Page, user: { email: string }) {
  await page.goto("/sign-in");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>) {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

/** One dated event; Ada and Bo share an invitation, Cy has her own and hasn't replied. */
async function setup(label: string) {
  const owner = await appUser(label);
  const wedding = await createWedding(owner, { name: "Emails (example)" });
  const event = (await must(
    owner.client.rpc("create_event", {
      p_wedding: wedding,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  )) as string;
  const guest = async (name: string, email: string) =>
    (await must(
      owner.client.rpc("create_guest", { p_wedding: wedding, p_guest: { name, email } }),
    )) as string;
  const ada = await guest("Ada Example", "ada@example.test");
  const bo = await guest("Bo Example", "bo@example.test");
  const cy = await guest("Cy Example", "cy@example.test");
  const raws: string[] = [];
  for (const ids of [[ada, bo], [cy]]) {
    const raw = randomBytes(32).toString("base64url");
    await must(
      owner.client.rpc("create_invitations", {
        p_wedding: wedding,
        p_event_id: event,
        p_groups: [{ guestIds: ids, householdId: null }],
        p_plus_one_quota: 0,
        p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        p_token_hashes: [sha(raw)],
        p_idempotency_key: `key-${randomUUID()}`,
      }),
    );
    raws.push(raw);
  }
  return { owner, wedding, household: `/rsvp/${raws[0]}`, householdRaw: raws[0]! };
}

async function replyAsGuest(page: Page, path: string) {
  await page.goto(path);
  await page
    .getByRole("group", { name: "Ada Example" })
    .getByLabel("Attending", { exact: true })
    .check();
  await page
    .getByRole("group", { name: "Bo Example" })
    .getByLabel("Not attending", { exact: true })
    .check();
  const send = page.getByRole("button", { name: "Send my reply" });
  for (let i = 0; i < 5 && !(await send.isVisible()); i++) {
    await page.getByRole("button", { name: "Next" }).click();
  }
  await send.click();
  await expect(
    page.getByRole("heading", { name: "Thank you. Your reply is saved." }),
  ).toBeVisible();
}

test("a guest adds the attended event to their calendar without the link in the file", async ({
  page,
}) => {
  const { household, householdRaw } = await setup("cal-guest");
  await page.setViewportSize({ width: 390, height: 844 });
  await replyAsGuest(page, household);

  const button = page.getByRole("button", { name: "Add to calendar" });
  await expect(button).toBeVisible();
  await expect(page.getByText("Adds the date as an all-day event.")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  expect(download.suggestedFilename()).toBe("wedding.ics");
  const file = await readFile((await download.path())!, "utf8");
  expect(file).toContain("BEGIN:VCALENDAR");
  expect(file).toContain("SUMMARY:Reception");
  expect(file).toContain("DTSTART;VALUE=DATE:20270612");
  expect(file).not.toContain(householdRaw);
  expect(file).not.toMatch(/Ada|Bo Example|example\.test/);
  await expect(page.getByText("Your calendar file is downloading.")).toBeVisible();

  const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(scan.violations).toEqual([]);
});

test("the owner prepares, reads and approves one email; nothing is claimed as delivered", async ({
  page,
}) => {
  const { owner, wedding, household } = await setup("mail-owner");
  await replyAsGuest(page, household);
  await page.context().clearCookies();
  await signIn(page, owner);

  await page.goto(`/app/${wedding}/guests`);
  await page
    .getByRole("navigation", { name: "Guest tools" })
    .getByRole("link", { name: "Guest emails" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Guest emails" })).toBeVisible();
  await expect(page.getByTestId("guest-mail-status")).toContainText("Test mode");

  await page.getByRole("button", { name: "Prepare confirmations for Reception" }).click();
  await expect(page.getByText(/Prepared 2 confirmations to review/)).toBeVisible();
  await page.getByRole("button", { name: "Prepare reminders for Reception" }).click();
  await expect(page.getByText(/Prepared 1 reminder to review/)).toBeVisible();
  // Preparing again adds nothing.
  await page.getByRole("button", { name: "Prepare confirmations for Reception" }).click();
  await expect(page.getByText(/No new confirmations/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "To review (3)" })).toBeVisible();

  const ada = page.getByRole("listitem").filter({ hasText: "Reply confirmation to Ada Example" });
  await ada.getByText("Read the email").click();
  await expect(ada).toContainText("Ada Example: attending");
  await expect(ada).toContainText("Bo Example: not attending");
  await expect(ada).toContainText("ada@example.test");
  const cy = page.getByRole("listitem").filter({ hasText: "Reply reminder to Cy Example" });
  await cy.getByText("Read the email").click();
  await expect(cy).toContainText("whether Cy Example can join us for Reception");
  await expect(cy).not.toContainText("/rsvp/");

  await ada.getByRole("button", { name: "Approve and send to Ada Example" }).click();
  await expect(
    page.getByText("Captured by the local test sink. It was not delivered to anyone."),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "To review (2)" })).toBeVisible();
  const history = page.getByRole("region", { name: /Sent and discarded/ });
  await expect(history.getByText("Captured locally")).toBeVisible();
  await expect(history).toContainText("not delivered");
  await expect(page.getByRole("main")).not.toContainText(/delivered to Ada|was delivered/i);

  await page
    .getByRole("listitem")
    .filter({ hasText: "Reply confirmation to Bo Example" })
    .getByRole("button", { name: "Discard the email to Bo Example" })
    .click();
  await expect(page.getByText("Discarded. It won't be sent.")).toBeVisible();

  const status = await withSuperuser(
    async (db) =>
      (
        await db.query(
          "select status, provider from public.guest_messages where wedding_id=$1 order by status",
          [wedding],
        )
      ).rows,
  );
  expect(status).toEqual([
    { status: "cancelled", provider: null },
    { status: "draft", provider: null },
    { status: "sent", provider: "dev-sink" },
  ]);

  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, `no sideways scroll at ${width}px`).toBe(false);
  }
  const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(scan.violations).toEqual([]);
});

test("a partner can prepare and read emails but cannot approve sending", async ({ page }) => {
  const { owner, wedding } = await setup("mail-partner");
  const partner = await appUser("mail-partner-2");
  await withSuperuser((db) =>
    db.query(
      "insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'partner')",
      [wedding, partner.id],
    ),
  );
  void owner;
  await signIn(page, partner);
  await page.goto(`/app/${wedding}/guests/messages`);
  await page.getByRole("button", { name: "Prepare reminders for Reception" }).click();
  await expect(page.getByText(/Prepared 3 reminders to review/)).toBeVisible();
  await expect(page.getByText("Only the workspace owner can approve sending.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve and send/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Discard the email/ })).toHaveCount(3);
});
