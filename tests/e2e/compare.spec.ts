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
  throw new Error("CI must provide the local Supabase stack for compare specs");
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

/** A venue with one quote. `lines` are fixed-price rows; a null amount is an unknown cost. */
async function venueQuote(
  owner: TestUser,
  wedding: string,
  name: string,
  seated: number | null,
  lines: { description: string; amount: number | null }[],
): Promise<{ candidate: string; proposal: string }> {
  const candidate = await rpc<string>(owner, "create_candidate", {
    p_wedding: wedding,
    p_kind: "venue",
    p_category: "venue",
    p_name: name,
    ...(seated !== null && { p_seated_capacity: seated }),
  });
  const proposal = await rpc<string>(owner, "create_proposal", {
    p_wedding: wedding,
    p_candidate: candidate,
    p_title: "Saturday package",
  });
  let v = 1;
  for (const l of lines) {
    await rpc(owner, "add_proposal_line", {
      p_wedding: wedding,
      p_proposal: proposal,
      p_expected_version: v,
      p_description: l.description,
      p_cost_mode: "fixed",
      ...(l.amount !== null && { p_amount_minor: l.amount }),
    });
    v += 1;
  }
  return { candidate, proposal };
}

async function scalar(sql: string, params: unknown[]): Promise<unknown> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows[0]?.v);
}

function card(page: Page, name: string) {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: new RegExp(name), level: 3 }) });
}

test("compare two quotes: unknown costs stay visible, a small venue is flagged, nothing is zero-filled", async ({
  page,
}) => {
  const owner = await appUser("cmp-flow");
  const wedding = await createWedding(owner, { name: "Compare", guests: 100 });
  await venueQuote(owner, wedding, "Garden House", 150, [
    { description: "Venue hire", amount: 500000 },
    { description: "Service charge", amount: null },
  ]);
  await venueQuote(owner, wedding, "Tiny Barn", 80, [
    { description: "Venue hire", amount: 400000 },
  ]);
  await signInViaUi(page, owner);

  await page.goto(`/app/${wedding}/discover/compare`);
  await expect(page.getByText(/No comparisons yet/)).toBeVisible();
  await page.getByRole("link", { name: "New comparison" }).click();
  await page.getByLabel(/^Name/).fill("Ceremony venues");
  await expect(page.getByLabel(/^Guests to price for/)).toHaveValue("100");

  // Choosing fewer than two is refused with a field error, and the typed name is kept.
  await page.getByRole("button", { name: "Start comparing" }).click();
  await expect(page.getByText("Choose 2 to 4 quotes to compare.")).toBeVisible();
  await expect(page.getByLabel(/^Name/)).toHaveValue("Ceremony venues");

  await page.getByRole("checkbox", { name: /Garden House/ }).check();
  await page.getByRole("checkbox", { name: /Tiny Barn/ }).check();
  await page.getByRole("button", { name: "Start comparing" }).click();
  await page.waitForURL(/\/discover\/compare\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Ceremony venues" })).toBeVisible();

  const garden = card(page, "Garden House");
  await expect(garden).toContainText("$5,000.00");
  await expect(garden).toContainText("1 required cost is still unknown");
  await expect(garden).toContainText("Service charge: not known yet");
  await expect(garden).toContainText("Not ranked: required costs are still unknown");
  const barn = card(page, "Tiny Barn");
  await expect(barn).toContainText("Seats only 80, which is 20 short of your 100 guests");
  await expect(barn).toContainText("Doesn't fit");
  // With an unknown fee we must not call anything the cheapest.
  await expect(page.getByText("Lowest known cost")).toHaveCount(0);
  await expect(page.getByText(/can't say which option is cheapest/)).toBeVisible();
  await expect(page.getByText("Ranked #")).toHaveCount(0);
});

test("ratings and weights produce a score with coverage, and ranking needs an explicit accept", async ({
  page,
}) => {
  const owner = await appUser("cmp-score");
  const wedding = await createWedding(owner, { name: "Score", guests: 100 });
  const a = await venueQuote(owner, wedding, "Garden House", 150, [
    { description: "Venue hire", amount: 500000 },
    { description: "Service charge", amount: null },
  ]);
  const b = await venueQuote(owner, wedding, "Orchard", 150, [
    { description: "Venue hire", amount: 450000 },
  ]);
  const id = await rpc<string>(owner, "create_comparison", {
    p_wedding: wedding,
    p_title: "Shortlist",
    p_guest_count: 100,
    p_proposals: [a.proposal, b.proposal],
    p_criteria: [
      { id: "style", label: "Style", weight: 6 },
      { id: "service", label: "Service", weight: 4 },
    ],
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover/compare/${id}`);
  await expect(card(page, "Orchard")).toContainText("Not rated yet");

  // Only Style is rated for Garden House; Service stays empty and is not read as zero.
  await page.getByLabel("Style (0 to 100)").first().fill("80");
  await page.getByLabel("Style (0 to 100)").nth(1).fill("90");
  await page.getByLabel("Service (0 to 100)").nth(1).fill("50");
  await page.getByRole("button", { name: "Save ratings" }).click();
  await expect(page.getByText("Ratings saved.")).toBeVisible();
  await expect(card(page, "Garden House")).toContainText(
    "80 out of 100, based on 60% of your weights",
  );
  await expect(card(page, "Orchard")).toContainText("74 out of 100, based on 100% of your weights");
  // Orchard has every required cost known, so it ranks; Garden House has an unknown fee.
  await expect(card(page, "Orchard")).toContainText("Ranked #1");
  await expect(card(page, "Garden House")).not.toContainText("Ranked #");

  // Bad rating text is refused without saving anything.
  await page.getByLabel("Style (0 to 100)").first().fill("101");
  await page.getByRole("button", { name: "Save ratings" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /0 to 100/ })
      .first(),
  ).toBeVisible();
  expect(await scalar("select version v from public.comparisons where id=$1", [id])).toBe(2);

  await page.reload();
  await page.getByLabel(/^Rank options even when some required costs/).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(card(page, "Garden House")).toContainText("Ranked #");
});

test("choosing needs acknowledgement of warnings, records a decision, books nothing, and goes stale when a quote changes", async ({
  page,
}) => {
  const owner = await appUser("cmp-decide");
  const wedding = await createWedding(owner, { name: "Decide", guests: 100 });
  const a = await venueQuote(owner, wedding, "Garden House", 150, [
    { description: "Venue hire", amount: 500000 },
    { description: "Service charge", amount: null },
  ]);
  const b = await venueQuote(owner, wedding, "Orchard", 150, [
    { description: "Venue hire", amount: 450000 },
  ]);
  const id = await rpc<string>(owner, "create_comparison", {
    p_wedding: wedding,
    p_title: "Shortlist",
    p_guest_count: 100,
    p_proposals: [a.proposal, b.proposal],
    p_criteria: [{ id: "style", label: "Style", weight: 5 }],
  });
  await signInViaUi(page, owner);
  await page.goto(`/app/${wedding}/discover/compare/${id}`);

  const choose = page
    .getByRole("listitem")
    .or(page.locator("section#decide-heading, div"))
    .filter({ has: page.getByRole("button", { name: /^Choose Garden House/ }) })
    .last();
  await expect(
    choose.getByLabel(/I've read these warnings: some required costs are still unknown/),
  ).toBeVisible();
  await choose.getByRole("button", { name: /^Choose Garden House/ }).click();
  await expect(page.getByText(/confirm you've read the warnings/)).toBeVisible();
  expect(
    await scalar("select count(*)::int v from public.decisions where comparison_id=$1", [id]),
  ).toBe(0);

  await choose.getByLabel(/I've read these warnings/).check();
  await choose.getByLabel("Note (optional)").fill("Loved the garden");
  await choose.getByRole("button", { name: /^Choose Garden House/ }).click();
  await expect(page.getByText("Decision recorded. Nothing has been booked.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your decision" })).toBeVisible();
  await expect(page.getByText("Loved the garden")).toBeVisible();
  await expect(page.getByText(/may be out of date/)).toHaveCount(0);
  expect(await scalar("select stage v from public.candidates where id=$1", [a.candidate])).toBe(
    "considering",
  );
  expect(
    await scalar(
      "select count(*)::int v from public.proposals where wedding_id=$1 and status='open'",
      [wedding],
    ),
  ).toBe(2);

  // The quote changes after the decision: the decision is kept, flagged stale.
  await rpc(owner, "update_proposal_line", {
    p_wedding: wedding,
    p_line: (await scalar(
      "select id v from public.proposal_lines where proposal_id=$1 and amount_minor is null",
      [a.proposal],
    )) as string,
    p_expected_version: 3,
    p_description: "Service charge",
    p_cost_mode: "fixed",
    p_amount_minor: 90000,
  });
  await page.reload();
  await expect(page.getByText(/may be out of date: a quote was edited/)).toBeVisible();
  await expect(page.getByText(/It hasn't been changed/)).toBeVisible();
  expect(
    await scalar(
      "select chosen_proposal_id v from public.decisions where comparison_id=$1 and superseded_at is null",
      [id],
    ),
  ).toBe(a.proposal);
});

test("a viewer can read a comparison but not change it; a stranger gets 404", async ({ page }) => {
  const owner = await appUser("cmp-roles");
  const wedding = await createWedding(owner, { name: "Roles", guests: 100 });
  const a = await venueQuote(owner, wedding, "Garden House", 150, [
    { description: "Hire", amount: 500000 },
  ]);
  const b = await venueQuote(owner, wedding, "Orchard", 150, [
    { description: "Hire", amount: 450000 },
  ]);
  const id = await rpc<string>(owner, "create_comparison", {
    p_wedding: wedding,
    p_title: "Shortlist",
    p_guest_count: 100,
    p_proposals: [a.proposal, b.proposal],
    p_criteria: [{ id: "style", label: "Style", weight: 5 }],
  });
  const viewer = await appUser("cmp-viewer");
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      wedding,
      viewer.id,
    ]),
  );
  await signInViaUi(page, viewer);
  await page.goto(`/app/${wedding}/discover/compare/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Shortlist" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Choose|Save ratings|Save settings|Remove this/ }),
  ).toHaveCount(0);
  await expect(page.getByText(/You can view this/)).toBeVisible();
  expect((await page.goto(`/app/${wedding}/discover/compare/new`))?.status()).toBe(404);
  await page.goto(`/app/${wedding}/discover/compare`);
  await expect(page.getByRole("link", { name: "New comparison" })).toHaveCount(0);

  const stranger = await appUser("cmp-stranger");
  await page.context().clearCookies();
  await signInViaUi(page, stranger);
  expect((await page.goto(`/app/${wedding}/discover/compare/${id}`))?.status()).toBe(404);
  expect((await page.goto(`/app/${wedding}/discover/compare`))?.status()).toBe(404);
});

test("comparison pages pass axe and reflow at 320px and 1280px", async ({ page }) => {
  const owner = await appUser("cmp-a11y");
  const wedding = await createWedding(owner, { name: "A11y", guests: 100 });
  const a = await venueQuote(
    owner,
    wedding,
    "A venue with a rather long name for a narrow phone",
    80,
    [
      {
        description: "Venue hire with a long description that must wrap on a phone",
        amount: 500000,
      },
      { description: "Service charge", amount: null },
    ],
  );
  const b = await venueQuote(owner, wedding, "Orchard", null, [
    { description: "Hire", amount: 450000 },
  ]);
  const id = await rpc<string>(owner, "create_comparison", {
    p_wedding: wedding,
    p_title: "A comparison with a rather long name to check wrapping",
    p_guest_count: 100,
    p_proposals: [a.proposal, b.proposal],
    p_criteria: [
      { id: "style", label: "Style", weight: 6 },
      { id: "service", label: "Service", weight: 4 },
    ],
  });
  await signInViaUi(page, owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, name] of [
      [`/app/${wedding}/discover/compare`, "compare-list"],
      [`/app/${wedding}/discover/compare/new`, "compare-new"],
      [`/app/${wedding}/discover/compare/${id}`, "compare-detail"],
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
