import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/database.types";
import { readGuestConsequences } from "@/server/guests/consequences-read";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-05: the consequences panel on a guest's page. Runs the same read the page runs
// (readGuestConsequences) as real signed-in users under RLS, after the brief's late cancellation:
// a seated guest declines from their own link after the plan was finalized and the caterer count
// was locked.

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const typed = (u: TestUser) => u.client as unknown as SupabaseClient<Database>;
const ZONE = "Europe/London";

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data;
}
const one = async <T>(sql: string, params: unknown[]) =>
  withSuperuser(async (db) => (await db.query(sql, params)).rows[0] as T);

let owner: TestUser;
let w: string;
let event: string;
let fish: string;
let layout: string;
let token: string;
let invitationId: string;
let boSeat: number;
const g: Record<string, string> = {};
const m: Record<string, string> = {};

const override = (member: string, status: string, meal?: string) =>
  ok(
    owner.client.rpc("override_rsvp_response", {
      p_wedding: w,
      p_member_id: member,
      p_status: status,
      p_reason: "test",
      ...(meal && { p_meal_option_id: meal }),
    }),
  );

async function member(role: "partner" | "editor" | "viewer", areas?: string[]) {
  const user = await createUser(`conseq-${role}`);
  const row = await one<{ id: string; version: number }>(
    "insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3) returning id, version",
    [w, user.id, role],
  );
  if (areas) {
    await ok(
      owner.client.rpc("set_editor_grants", {
        p_membership: row.id,
        p_areas: areas,
        p_expected_version: row.version,
      }),
    );
  }
  return user;
}

beforeAll(async () => {
  owner = await createUser("conseq-owner");
  w = await createWedding(owner);
  event = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception" },
    }),
  )) as string;
  fish = (await ok(
    owner.client.rpc("add_meal_option", { p_wedding: w, p_event_id: event, p_name: "Fish" }),
  )) as string;
  for (const key of ["ada", "bo", "cy"]) {
    g[key] = (await ok(
      owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name: `${key} Conseq` } }),
    )) as string;
  }
  token = randomBytes(32).toString("base64url");
  const created = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: event,
      p_groups: [{ guestIds: [g.ada!, g.bo!, g.cy!], householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      p_token_hashes: [sha(token)],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  invitationId = created[0]!.o_invitation_id;
  for (const key of ["ada", "bo", "cy"]) {
    m[key] = (
      await one<{ id: string }>(
        "select id from public.invitation_members where guest_id = $1 and event_id = $2 and active",
        [g[key], event],
      )
    ).id;
  }
  await override(m.ada!, "accepted", fish);
  await override(m.bo!, "accepted", fish);

  layout = (await ok(
    owner.client.rpc("ensure_seating_layout", { p_wedding: w, p_event_id: event }),
  )) as string;
  const table = (await ok(
    owner.client.rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: "Table 6",
      p_capacity: 8,
    }),
  )) as string;
  for (const guest of [g.ada!, g.bo!]) {
    await ok(
      owner.client.rpc("assign_guest_seat", {
        p_wedding: w,
        p_layout: layout,
        p_guest: guest,
        p_table: table,
      }),
    );
  }
  await ok(owner.client.rpc("number_table_seats", { p_wedding: w, p_table: table }));
  boSeat = (
    await one<{ seat_number: number }>(
      "select seat_number from public.seat_assignments where guest_id = $1 and layout_id = $2",
      [g.bo, layout],
    )
  ).seat_number;
  const { revision } = await one<{ revision: number }>(
    "select revision from public.seating_layouts where id = $1",
    [layout],
  );
  await ok(
    owner.client.rpc("finalize_seating_layout", {
      p_wedding: w,
      p_layout: layout,
      p_expected_revision: revision,
    }),
  );

  const d = (
    (await ok(owner.client.rpc("event_demand", { p_wedding: w }))) as {
      event_id: string;
      yes: number;
      yes_without_meal: number;
      meals: { id: string; count: number }[];
    }[]
  ).find((r) => r.event_id === event)!;
  await ok(
    owner.client.rpc("lock_guarantee", {
      p_wedding: w,
      p_event: event,
      p_count: 2,
      p_seen: {
        yes: d.yes,
        withoutMeal: d.yes_without_meal,
        meals: d.meals.map((x) => ({ id: x.id, count: x.count })),
      },
    }),
  );

  const category = (await ok(
    owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Food" }),
  )) as string;
  await ok(
    owner.client.rpc("create_budget_item", {
      p_wedding: w,
      p_category: category,
      p_name: "Catering",
      p_cost_mode: "per_guest",
      p_amount_minor: 9_500,
      p_count_source: "event_yes",
      p_count_event: event,
    }),
  );

  // The late cancellation: Bo declines from their own link.
  const { version } = await one<{ version: number }>(
    "select version from public.invitations where id = $1",
    [invitationId],
  );
  await ok(
    adminClient().rpc("rsvp_submit", {
      p_token_hash: sha(token),
      p_client: `c-${randomUUID().slice(0, 12)}`,
      p_expected_version: version,
      p_responses: [{ memberId: m.bo!, status: "declined", mealOptionId: null }],
    }),
  );
});

const snapshotOfWrites = () =>
  one<Record<string, number>>(
    `select
       (select count(*)::int from public.rsvp_changes where wedding_id = $1) as changes,
       (select count(*)::int from public.attention_items where wedding_id = $1) as attention,
       (select count(*)::int from public.audit_events where wedding_id = $1) as audit,
       (select revision from public.seating_layouts where id = $2) as revision`,
    [w, layout],
  );

describe("guest consequences (UX-05)", () => {
  it("lists what a late decline did, needs and left alone", async () => {
    const before = await snapshotOfWrites();
    const list = await readGuestConsequences(typed(owner), w, g.bo!, ZONE);
    expect(await snapshotOfWrites()).toEqual(before);

    expect(list).toHaveLength(1);
    const [r] = list;
    expect(r!.eventName).toBe("Reception");
    expect(r!.change).toMatchObject({
      fromStatus: "accepted",
      toStatus: "declined",
      fromMeal: "Fish",
      source: "guest",
    });
    const c = r!.consequences;
    expect(c.updated.map((l) => l.text)).toEqual([
      "Attending: 1 fewer, 1 now.",
      "Planning number: 1 fewer, 2 now.",
      "Fish: 1 fewer, 1 now.",
      "Per-guest estimates that count this event follow the new number: Catering.",
      `Seat ${boSeat} at Table 6 in the finalized plan is free again in the live plan.`,
    ]);
    expect(c.review.map((l) => l.id)).toEqual(["plan", "attention", "caterer"]);
    const { r: finalized } = await one<{ r: number }>(
      "select finalized_revision as r from public.seating_layouts where id = $1",
      [layout],
    );
    expect(c.review[0]!.text).toBe(
      `The finalized seating plan (version ${finalized}) is out of date. Finalize it again before you print or share it.`,
    );
    expect(c.review[2]!.text).toBe(
      "The caterer was told 2; 1 is attending now, 1 fewer. Check whether the count can still go down.",
    );
    expect(c.unchanged.map((l) => l.id)).toEqual(["guarantee", "snapshot", "commitments"]);
    expect(c.unchanged[0]!.text).toMatch(
      /^The caterer count stays at 2, locked [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/,
    );
  });

  it("the guest whose answer never changed has no panel; a waiting guest is unaffected", async () => {
    expect(await readGuestConsequences(typed(owner), w, g.cy!, ZONE)).toEqual([]);
  });

  it("a partner and an editor holding the guests grant see the same panel as the owner", async () => {
    const mine = await readGuestConsequences(typed(owner), w, g.bo!, ZONE);
    for (const u of [await member("partner"), await member("editor", ["guests"])]) {
      expect(await readGuestConsequences(typed(u), w, g.bo!, ZONE)).toEqual(mine);
    }
  });

  it("a viewer, an editor without the guests grant and a stranger get nothing", async () => {
    // Even with guest totals shared, no reply history or seat reaches them.
    await withSuperuser((db) =>
      db.query("update public.weddings set share_guest_totals = true where id = $1", [w]),
    );
    try {
      for (const u of [
        await member("viewer"),
        await member("editor"),
        await member("editor", ["budget", "vendors", "plan"]),
        await createUser("conseq-stranger"),
      ]) {
        expect(await readGuestConsequences(typed(u), w, g.bo!, ZONE)).toEqual([]);
      }
    } finally {
      await withSuperuser((db) =>
        db.query("update public.weddings set share_guest_totals = false where id = $1", [w]),
      );
    }
  });
});
