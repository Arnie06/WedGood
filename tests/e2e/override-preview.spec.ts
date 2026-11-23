import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  adminClient,
  anonClient,
  createWedding,
  localStack,
  type TestUser,
} from "../integration/helpers";

// UX-02: "Change an answer" shows what it would touch before saving, and refuses to save over a
// reply that arrived after the preview. Drives the real app against the local Supabase stack.
let stackUp = true;
try {
  localStack();
} catch {
  stackUp = false;
}
if (process.env.CI && !stackUp) {
  throw new Error("CI must provide the local Supabase stack for override preview specs");
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

/** Reception: Ada attending with Fish at seat 1 on a finalized plan; Cy waiting. */
async function setup(label: string) {
  const owner = await appUser(label);
  const w = await createWedding(owner, { name: "Override Wedding", tz: "America/New_York" });
  const reception = await rpc<string>(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", localDate: "2027-06-12" },
    }),
  );
  const fish = await rpc<string>(
    owner.client.rpc("add_meal_option", { p_wedding: w, p_event_id: reception, p_name: "Fish" }),
  );
  const ids: Record<string, string> = {};
  for (const name of ["Ada Example", "Cy Example"]) {
    ids[name] = await rpc<string>(
      owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } }),
    );
  }
  const token = randomBytes(32).toString("base64url");
  const created = await rpc<{ o_invitation_id: string }[]>(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: reception,
      p_groups: [{ guestIds: Object.values(ids), householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [sha(token)],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  const invitationId = created[0]!.o_invitation_id;
  const members = await rpc<{ id: string; guest_id: string }[]>(
    adminClient()
      .from("invitation_members")
      .select("id, guest_id")
      .eq("invitation_id", invitationId),
  );
  const memberOf = (name: string) => members.find((m) => m.guest_id === ids[name])!.id;
  await rpc(
    owner.client.rpc("override_rsvp_response", {
      p_wedding: w,
      p_member_id: memberOf("Ada Example"),
      p_status: "accepted",
      p_reason: "test",
      p_meal_option_id: fish,
    }),
  );
  const layout = await rpc<string>(
    owner.client.rpc("ensure_seating_layout", { p_wedding: w, p_event_id: reception }),
  );
  const table = await rpc<string>(
    owner.client.rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: "Table 6",
      p_capacity: 8,
    }),
  );
  await rpc(
    owner.client.rpc("assign_guest_seat", {
      p_wedding: w,
      p_layout: layout,
      p_guest: ids["Ada Example"]!,
      p_table: table,
    }),
  );
  await rpc(owner.client.rpc("number_table_seats", { p_wedding: w, p_table: table }));
  const { data: lay } = await adminClient()
    .from("seating_layouts")
    .select("revision")
    .eq("id", layout)
    .single();
  await rpc(
    owner.client.rpc("finalize_seating_layout", {
      p_wedding: w,
      p_layout: layout,
      p_expected_revision: lay!.revision,
    }),
  );

  /** The guest answers through their link, as the public page would. */
  async function guestReplies(name: string, status: "accepted" | "declined") {
    const { data: inv } = await adminClient()
      .from("invitations")
      .select("version")
      .eq("id", invitationId)
      .single();
    await rpc(
      adminClient().rpc("rsvp_submit", {
        p_token_hash: sha(token),
        p_client: `c-${randomUUID().slice(0, 12)}`,
        p_expected_version: inv!.version,
        p_responses: [
          {
            memberId: memberOf(name),
            status,
            ...(status === "accepted" && { mealOptionId: fish }),
          },
        ],
      }),
    );
  }
  async function answerOf(name: string) {
    const { data } = await adminClient()
      .from("invitation_members")
      .select("rsvp_status")
      .eq("id", memberOf(name))
      .single();
    return data!.rsvp_status;
  }
  return { owner, w, ids, layout, memberOf, guestReplies, answerOf };
}

async function openTray(page: Page, w: string) {
  await page.goto(`/app/${w}/guests/invitations`);
  await page
    .getByRole("button", { name: /^Change an answer for/ })
    .first()
    .click();
  const tray = page.getByRole("dialog", { name: "Change an answer" });
  await expect(tray).toBeVisible();
  return tray;
}

test("declining a seated guest lists the seat, plan, counts and meals before saving", async ({
  page,
}) => {
  const f = await setup("override-owner");
  await page.setViewportSize({ width: 320, height: 900 });
  await signInViaUi(page, f.owner);
  const tray = await openTray(page, f.w);

  const answer = tray.getByLabel("Answer for Ada Example");
  await answer.selectOption({ label: "Not attending" });
  // Focus stays on what the person was using; the preview is announced, not focused.
  await expect(answer).toBeFocused();
  const impact = tray.getByTestId(`override-impact-${f.memberOf("Ada Example")}`);
  await expect(impact).toContainText("Releases seat 1 at Table 6.");
  await expect(impact).toContainText("The finalized seating plan becomes out of date.");
  await expect(impact).toContainText("Needs attention");
  await expect(impact).toContainText("Attending goes from 1 to 0.");
  await expect(impact).toContainText("Meal counts: Fish 1 → 0.");
  await expect(impact).toHaveAttribute("aria-live", "polite");
  await expect(answer).toBeFocused();
  await expect(tray.getByLabel("Meal").first()).toBeDisabled();

  // Back to the saved answer: nothing to record.
  await answer.selectOption({ label: "Attending" });
  await expect(impact).toContainText("This is the saved answer, so nothing would change.");
  const save = tray.getByRole("button", { name: "Record change" }).first();
  await expect(save).toBeDisabled();

  await answer.selectOption({ label: "Not attending" });
  await expect(impact).toContainText("Releases seat 1 at Table 6.");
  await tray.getByLabel("Reason for the change").first().fill("Called to say they can't come");
  await save.click();
  await expect.poll(() => f.answerOf("Ada Example")).toBe("declined");
  const { count } = await adminClient()
    .from("seat_assignments")
    .select("guest_id", { count: "exact", head: true })
    .eq("layout_id", f.layout);
  expect(count).toBe(0);
});

test("a guest reply after the preview is shown instead of being overwritten", async ({ page }) => {
  const f = await setup("override-race");
  await page.setViewportSize({ width: 390, height: 900 });
  await signInViaUi(page, f.owner);
  const tray = await openTray(page, f.w);

  const answer = tray.getByLabel("Answer for Cy Example");
  await answer.selectOption({ label: "Not attending" });
  const impact = tray.getByTestId(`override-impact-${f.memberOf("Cy Example")}`);
  // Not seated and not attending, so only the finalized plan is touched.
  await expect(impact).toContainText("The finalized seating plan becomes out of date.");
  await expect(impact).not.toContainText("Attending goes");
  const form = tray.locator("form").filter({ has: page.getByLabel("Answer for Cy Example") });
  await form.getByLabel("Reason for the change").fill("Spoke on the phone");

  // Cy answers through their link while the tray is open.
  await f.guestReplies("Cy Example", "accepted");

  await form.getByRole("button", { name: "Record change" }).click();
  await expect(form.getByText(/^Replies changed since you opened this/)).toBeVisible();
  await expect(form.getByText("Saved answer now:")).toContainText("Attending · Fish");
  await expect(impact).toContainText("Attending goes from 2 to 1.");
  await expect(impact).toContainText("Meal counts: Fish 2 → 1.");
  // Not saved: the guest's own answer stands.
  expect(await f.answerOf("Cy Example")).toBe("accepted");
  // The reason is kept, so a second press records the change against the new picture.
  await expect(form.getByLabel("Reason for the change")).toHaveValue("Spoke on the phone");
  await form.getByRole("button", { name: "Record change" }).click();
  await expect.poll(() => f.answerOf("Cy Example")).toBe("declined");
});

test("the tray with a preview passes axe and fits at 320 and 1280", async ({ page }) => {
  const f = await setup("override-a11y");
  await signInViaUi(page, f.owner);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const tray = await openTray(page, f.w);
    await tray.getByLabel("Answer for Ada Example").selectOption({ label: "Not attending" });
    await expect(tray.getByTestId(`override-impact-${f.memberOf("Ada Example")}`)).toContainText(
      "Releases seat 1",
    );
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((x) => `override-preview@${width}: ${x.id}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `override-preview@${width} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/screenshots/${width}/override-preview.png` });
  }
});
