import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/database.types";
import { readOverridePreview } from "@/server/events/override-preview-read";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-02: the preview shown before "Change an answer" is saved. Runs the same read the actions run
// (readOverridePreview) as real signed-in users under RLS, then checks that what it predicted is
// what override_rsvp_response actually did, and that a guest reply in between changes the basis.

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const typed = (u: TestUser) => u.client as unknown as SupabaseClient<Database>;

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
let table: string;
let token: string;
let invitationId: string;
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

async function finalize() {
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
}

beforeAll(async () => {
  owner = await createUser("override-owner");
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
      owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name: `${key} Example` } }),
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
  table = (await ok(
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
  await finalize();

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
});

describe("override preview (UX-02)", () => {
  it("lists every effect of declining a seated guest, and the RPC does exactly that", async () => {
    const seat = await one<{ seat_number: number }>(
      "select seat_number from public.seat_assignments where guest_id = $1 and layout_id = $2",
      [g.ada, layout],
    );
    const p = await readOverridePreview(typed(owner), w, m.ada!, {
      status: "declined",
      mealOptionId: fish,
    });
    expect(p).not.toBeNull();
    expect(p!.changed).toBe(true);
    expect(p!.to).toEqual({ status: "declined", mealOptionId: null });
    expect(p!.items.map((i) => i.id)).toEqual([
      "seat",
      "plan",
      "attention",
      "attending",
      "caterer",
      "meals",
    ]);
    expect(p!.items[0]!.text).toBe(`Releases seat ${seat.seat_number} at Table 6.`);
    expect(p!.items.find((i) => i.id === "attending")!.text).toBe("Attending goes from 2 to 1.");
    expect(p!.items.find((i) => i.id === "caterer")!.text).toContain("stays locked at 2");
    expect(p!.items.find((i) => i.id === "meals")!.text).toBe("Meal counts: Fish 2 → 1.");

    // Reading changed nothing.
    const before = await one<{ n: number }>(
      "select count(*)::int as n from public.seat_assignments where layout_id = $1",
      [layout],
    );
    expect(before.n).toBe(2);

    await override(m.ada!, "declined");
    const after = await one<{ seated: number; stale: boolean; open: number; locked: number }>(
      `select
         (select count(*)::int from public.seat_assignments where layout_id = $1 and guest_id = $2) as seated,
         (select revision <> finalized_revision from public.seating_layouts where id = $1) as stale,
         (select count(*)::int from public.attention_items where event_id = $3 and kind = 'seats_released' and status = 'open') as open,
         (select guaranteed_count from public.catering_guarantees where event_id = $3 and status = 'locked') as locked`,
      [layout, g.ada, event],
    );
    expect(after).toEqual({ seated: 0, stale: true, open: 1, locked: 2 });

    // Now out of date already, so a further change does not repeat the plan line.
    const again = await readOverridePreview(typed(owner), w, m.bo!, {
      status: "accepted",
      mealOptionId: null,
    });
    expect(again!.items.map((i) => i.id)).toEqual(["meals", "without-meal"]);
  });

  it("says nothing changes for the saved answer", async () => {
    const p = await readOverridePreview(typed(owner), w, m.bo!, {
      status: "accepted",
      mealOptionId: fish,
    });
    expect(p!.changed).toBe(false);
    expect(p!.items).toEqual([]);
  });

  it("a guest reply between preview and save changes the basis (race)", async () => {
    const choice = { status: "declined" as const, mealOptionId: null };
    const shown = await readOverridePreview(typed(owner), w, m.cy!, choice);
    expect(shown!.current.status).toBe("pending");
    expect(shown!.items.map((i) => i.id)).toEqual([]);

    // The guest answers through the public link while the planner's tray is open.
    const { version } = await one<{ version: number }>(
      "select version from public.invitations where id = $1",
      [invitationId],
    );
    await ok(
      adminClient().rpc("rsvp_submit", {
        p_token_hash: sha(token),
        p_client: `c-${randomUUID().slice(0, 12)}`,
        p_expected_version: version,
        p_responses: [{ memberId: m.cy!, status: "accepted", mealOptionId: fish }],
      }),
    );

    const now = await readOverridePreview(typed(owner), w, m.cy!, choice);
    expect(now!.basis).not.toBe(shown!.basis);
    expect(now!.current).toEqual({ status: "accepted", mealOptionId: fish });
    expect(now!.items.map((i) => i.id)).toEqual(["attending", "caterer", "meals"]);

    // Another guest's reply also moves the counts this guest's preview shows.
    const steady = await readOverridePreview(typed(owner), w, m.bo!, choice);
    const repeat = await readOverridePreview(typed(owner), w, m.bo!, choice);
    expect(repeat!.basis).toBe(steady!.basis);
  });

  it("returns nothing to a viewer or a stranger", async () => {
    const viewer = await createUser("override-viewer");
    await ok(
      adminClient()
        .from("memberships")
        .insert({ wedding_id: w, user_id: viewer.id, role: "viewer" }),
    );
    const stranger = await createUser("override-stranger");
    for (const u of [viewer, stranger]) {
      expect(
        await readOverridePreview(typed(u), w, m.bo!, { status: "declined", mealOptionId: null }),
      ).toBeNull();
    }
  });
});
