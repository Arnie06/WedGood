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

// Drives the real app against the real local Supabase stack (see membership.spec.ts).
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for website specs");
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

async function seedInvitation(owner: TestUser, wedding: string, event: string, guest: string) {
  const raw = randomBytes(32).toString("base64url");
  await rpc(owner, "create_invitations", {
    p_wedding: wedding,
    p_event_id: event,
    p_groups: [{ guestIds: [guest], householdId: null }],
    p_plus_one_quota: 0,
    p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    p_token_hashes: [createHash("sha256").update(raw).digest("hex")],
    p_idempotency_key: `key-${randomUUID()}`,
  });
  return raw;
}

test("write, preview, publish, share with an invitation, then unpublish", async ({
  page,
  browser,
}) => {
  const owner = await appUser("site-flow");
  const wedding = await createWedding(owner, { name: "Alex & Morgan" });
  const ceremony = await rpc<string>(owner, "create_event", {
    p_wedding: wedding,
    p_event: { name: "Ceremony", kind: "ceremony", localDate: "2027-06-12" },
  });
  const dinner = await rpc<string>(owner, "create_event", {
    p_wedding: wedding,
    p_event: { name: "Rehearsal dinner", kind: "rehearsal", localDate: "2027-06-11" },
  });
  const guest = await rpc<string>(owner, "create_guest", {
    p_wedding: wedding,
    p_guest: { name: "Example Guest" },
  });
  const token = await seedInvitation(owner, wedding, dinner, guest);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  void ceremony;

  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/website`);
  await expect(page.getByRole("heading", { level: 1, name: "Guest website" })).toBeVisible();
  await expect(page.getByText("Draft, not public")).toBeVisible();
  await expect(page.getByText("Save your first draft")).toBeVisible();

  // Invalid input is explained and nothing typed is lost.
  await page.getByLabel(/^Title/).fill("Alex & Morgan");
  await page.getByLabel(/^Registry name 1/).fill("Gifts");
  await page.getByLabel(/^Registry link 1/).fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Please check the highlighted details.")).toBeVisible();
  await expect(page.getByText("Links must start with https://")).toBeVisible();
  await expect(page.getByLabel(/^Registry name 1/)).toHaveValue("Gifts");

  // A valid draft, including markup that must render as plain text.
  await page.getByLabel(/^Registry link 1/).fill("https://shop.example.com/alex-morgan");
  await page.getByLabel("Tagline").fill("We're getting married");
  await page.getByLabel("Date to show").fill("2027-06-12");
  await page.getByLabel("Our story").fill("We met at a bakery <script>window.__pwned=1</script>.");
  await page.getByLabel(/^Question 1/).fill("Is there parking?");
  await page.getByLabel(/^Answer 1/).fill("Yes, on site.");
  const ceremonyGroup = page.getByRole("group", { name: "Ceremony" });
  await ceremonyGroup.getByLabel("Who can see it").selectOption("public");
  await ceremonyGroup.getByLabel("Time").fill("4 pm");
  const dinnerGroup = page.getByRole("group", { name: "Rehearsal dinner" });
  await dinnerGroup.getByLabel("Who can see it").selectOption("invited");
  await dinnerGroup.getByLabel("Where").fill("The Garden Room");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(/Draft saved/)).toBeVisible();

  // Saved is not public.
  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  expect((await visitor.goto(`/w/${slug}`))?.status()).toBe(404);

  // Owner preview shows everything, labelled as a draft.
  await page.getByRole("link", { name: "Preview the saved draft" }).click();
  await expect(page.getByText(/Draft preview/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Alex & Morgan" })).toBeVisible();
  await expect(page.getByText("The Garden Room")).toBeVisible();
  await expect(page.getByText("Shared with invited guests only.")).toBeVisible();
  await expect(page.getByText("<script>window.__pwned=1</script>", { exact: false })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  // Preview needs a session: the same URL signed out is sent to sign-in.
  const signedOut = await anon.newPage();
  await signedOut.goto(`/app/${wedding}/website/preview`);
  await expect(signedOut).toHaveURL(/sign-in/);
  await signedOut.close();

  // Publishing needs the confirmation and a valid address.
  await page.goto(`/app/${wedding}/website`);
  await page.getByLabel(/^Web address/).fill("Bad Address!");
  await page.getByRole("button", { name: "Publish website" }).click();
  await expect(
    page.getByText("Please confirm that you want this page to be public."),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /I.ve previewed the saved draft/ }).check();
  await page.getByRole("button", { name: "Publish website" }).click();
  await expect(
    page.getByText("Use lowercase letters, numbers and single hyphens only."),
  ).toBeVisible();
  await page.getByLabel(/^Web address/).fill(slug);
  await page.getByRole("checkbox", { name: /I.ve previewed the saved draft/ }).check();
  await page.getByRole("button", { name: "Publish website" }).click();
  await expect(page.getByText(/Published\. Your website is now public/)).toBeVisible();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();

  // The public page: public event only, no private drafts, safe link, markup as text.
  await visitor.goto(`/w/${slug}`);
  await expect(visitor.getByRole("heading", { level: 1, name: "Alex & Morgan" })).toBeVisible();
  await expect(visitor.getByText("Ceremony", { exact: true })).toBeVisible();
  await expect(visitor.getByText("Rehearsal dinner")).toHaveCount(0);
  await expect(visitor.getByText("The Garden Room")).toHaveCount(0);
  await expect(visitor.getByText("Is there parking?")).toBeVisible();
  const reg = visitor.getByRole("link", { name: /Gifts/ });
  await expect(reg).toHaveAttribute("href", "https://shop.example.com/alex-morgan");
  await expect(reg).toHaveAttribute("rel", /noopener/);
  await expect(reg).toHaveAttribute("rel", /nofollow/);
  expect(
    await visitor.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  expect(await visitor.content()).not.toContain(wedding);

  // The invitation route adds only this guest's invited-only event and links to the RSVP.
  await visitor.goto(`/w/${slug}/invite/${token}`);
  await expect(visitor.getByText("The Garden Room")).toBeVisible();
  await expect(visitor.getByText("Shared with invited guests only.")).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Reply to your invitation" })).toHaveAttribute(
    "href",
    `/rsvp/${token}`,
  );
  await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await visitor.goto(`/w/${slug}/invite/${randomBytes(32).toString("base64url")}`);
  await expect(visitor.getByText(/invitation link isn't working/)).toBeVisible();
  await expect(visitor.getByText("The Garden Room")).toHaveCount(0);

  // Editing after publishing does not change the public page until it is published again.
  await page.goto(`/app/${wedding}/website`);
  await page.getByLabel("Tagline").fill("Changed tagline");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(/Draft saved/)).toBeVisible();
  await expect(page.getByText("Published, with unpublished changes")).toBeVisible();
  await visitor.goto(`/w/${slug}`);
  await expect(visitor.getByText("We're getting married")).toBeVisible();
  await expect(visitor.getByText("Changed tagline")).toHaveCount(0);

  // Unpublish: public and invitation pages disappear at once; the draft stays.
  await page.getByRole("button", { name: "Unpublish website" }).click();
  // The form unmounts with the page state; the status badge (a live region) is the confirmation.
  await expect(page.getByText("Unpublished, not public")).toBeVisible();
  expect((await visitor.goto(`/w/${slug}`))?.status()).toBe(404);
  await visitor.goto(`/w/${slug}/invite/${token}`);
  await expect(visitor.getByText(/invitation link isn't working/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Tagline")).toHaveValue("Changed tagline");
  await expect(page.getByText("Unpublished, not public")).toBeVisible();
  await anon.close();
});

test("a viewer cannot edit, preview or see the site, and cannot reach another wedding's", async ({
  page,
}) => {
  const owner = await appUser("site-owner");
  const viewer = await appUser("site-viewer");
  const stranger = await appUser("site-stranger");
  const wedding = await createWedding(owner);
  await rpc(owner, "save_site_draft", {
    p_wedding: wedding,
    p_expected_version: 0,
    p_draft: { template: "classic", title: "Private draft", faq: [], registry: [], events: [] },
  });
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/website`);
  await expect(page.getByText(/managed by the workspace owner and partner/)).toBeVisible();
  await expect(page.getByText("Private draft")).toHaveCount(0);
  expect((await page.goto(`/app/${wedding}/website/preview`))?.status()).toBe(404);

  await page.context().clearCookies();
  await signInViaUi(page, stranger);
  expect((await page.goto(`/app/${wedding}/website`))?.status()).toBe(404);
});

test("site pages pass axe and reflow at 320px and 1280px", async ({ page, browser }) => {
  const owner = await appUser("site-a11y");
  const wedding = await createWedding(owner, { name: "Alex & Morgan" });
  const ceremony = await rpc<string>(owner, "create_event", {
    p_wedding: wedding,
    p_event: {
      name: "Ceremony with a rather long name that must wrap on a phone",
      kind: "ceremony",
    },
  });
  const slug = `a11y-${randomUUID().slice(0, 8)}`;
  const version = await rpc<number>(owner, "save_site_draft", {
    p_wedding: wedding,
    p_expected_version: 0,
    p_draft: {
      template: "garden",
      title: "A long title for Alex and Morgan that has to wrap on a very narrow phone screen",
      tagline: "Join us for a day of love, laughter and good food",
      date: "2027-06-12",
      location: "Somewhere lovely",
      story: "We met at a bakery.\n\nIt was raining.",
      travel: "Fly into the nearest airport and take a short drive.",
      faq: [{ q: "Is there parking?", a: "Yes, on site." }],
      registry: [
        { label: "Gifts", url: `https://shop.example.com/${"very-long-path-".repeat(8)}` },
      ],
      events: [{ eventId: ceremony, visibility: "public", when: "4 pm", where: "The Garden" }],
    },
  });
  await rpc(owner, "publish_site", {
    p_wedding: wedding,
    p_expected_version: version,
    p_slug: slug,
  });

  await signInViaUi(page, owner);
  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  for (const width of [320, 1280]) {
    for (const [name, p, path] of [
      ["site-editor", page, `/app/${wedding}/website`],
      ["site-preview", page, `/app/${wedding}/website/preview`],
      ["site-public", visitor, `/w/${slug}`],
    ] as const) {
      await p.setViewportSize({ width, height: 900 });
      await p.goto(path);
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page: p })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((x) => `${name}@${width}: ${x.id}`)).toEqual([]);
      const overflow = await p.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name}@${width} overflow`).toBeLessThanOrEqual(0);
      await p.screenshot({ path: `test-results/screenshots/${width}/${name}.png`, fullPage: true });
    }
  }
  await anon.close();
});
