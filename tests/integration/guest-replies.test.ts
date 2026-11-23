import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { matchesReply, replyTotals } from "@/domain/guests/replies";
import type { Database } from "@/server/db/database.types";
import { readGuestReplies } from "@/server/guests/replies-read";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-01: the guest list's per-event filters must return exactly the guests event_demand counts.
// Runs the same reads the page runs (readGuestReplies) as real signed-in users, under RLS.

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const typed = (u: TestUser) => u.client as unknown as SupabaseClient<Database>;

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

let owner: TestUser;
let w: string;
let event: string;
let names: Map<string, string>;

async function invite(guestIds: string[], quota: number) {
  const raw = randomBytes(32).toString("base64url");
  const created = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: event,
      p_groups: [{ guestIds, householdId: null }],
      p_plus_one_quota: quota,
      p_expires_at: future(30),
      p_token_hashes: [sha(raw)],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  return { id: created[0]!.o_invitation_id, raw };
}

async function memberOf(guest: string) {
  return withSuperuser(
    async (db) =>
      (
        await db.query(
          "select id from public.invitation_members where guest_id = $1 and event_id = $2 and active",
          [guest, event],
        )
      ).rows[0].id as string,
  );
}

const respond = async (guest: string, status: "accepted" | "declined", meal?: string) =>
  ok(
    owner.client.rpc("override_rsvp_response", {
      p_wedding: w,
      p_member_id: await memberOf(guest),
      p_status: status,
      p_reason: "test",
      ...(meal && { p_meal_option_id: meal }),
    }),
  );

beforeAll(async () => {
  owner = await createUser("replies-owner");
  w = await createWedding(owner);
  event = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception" },
    }),
  )) as string;
  const fish = (await ok(
    owner.client.rpc("add_meal_option", { p_wedding: w, p_event_id: event, p_name: "Fish" }),
  )) as string;
  const g: Record<string, string> = {};
  for (const key of ["seated", "nomeal", "unseated", "wait", "late", "no", "archived", "outside"]) {
    g[key] = (await ok(
      owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name: `${key} Example` } }),
    )) as string;
  }
  names = new Map(Object.entries(g).map(([k, id]) => [id, k]));

  const main = await invite([g.seated!, g.nomeal!, g.unseated!, g.wait!, g.no!, g.archived!], 1);
  const late = await invite([g.late!], 0);
  await withSuperuser((db) =>
    db.query("update public.invitations set deadline = now() - interval '1 day' where id = $1", [
      late.id,
    ]),
  );

  await respond(g.seated!, "accepted", fish);
  await respond(g.nomeal!, "accepted");
  await respond(g.unseated!, "accepted", fish);
  await respond(g.no!, "declined");
  await respond(g.archived!, "accepted", fish);

  // A guest-named plus-one through the public RPC: attending, no meal, not seated.
  const version = await withSuperuser(
    async (db) =>
      (await db.query("select version from public.invitations where id = $1", [main.id])).rows[0]
        .version as number,
  );
  await ok(
    adminClient().rpc("rsvp_submit", {
      p_token_hash: sha(main.raw),
      p_client: `c-${randomUUID().slice(0, 12)}`,
      p_expected_version: version,
      p_responses: [],
      p_plus_one: { name: "Plusone Example" },
    }),
  );

  const layout = (await ok(
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
  for (const guest of [g.seated!, g.archived!]) {
    await ok(
      owner.client.rpc("assign_guest_seat", {
        p_wedding: w,
        p_layout: layout,
        p_guest: guest,
        p_table: table,
      }),
    );
  }

  const archivedVersion = await withSuperuser(
    async (db) =>
      (await db.query("select version from public.guests where id = $1", [g.archived!])).rows[0]
        .version as number,
  );
  await ok(
    owner.client.rpc("set_guest_archived", {
      p_wedding: w,
      p_guest_id: g.archived!,
      p_expected_version: archivedVersion,
      p_archived: true,
    }),
  );
});

/** Non-archived guests, as the page lists them. */
async function activeGuests(u: TestUser) {
  const rows = await ok(
    u.client.from("guests").select("id, full_name, archived_at").eq("wedding_id", w),
  );
  return (rows as { id: string; full_name: string; archived_at: string | null }[]).filter(
    (r) => r.archived_at === null,
  );
}

describe("guest list replies (UX-01)", () => {
  it("each filter returns exactly the guests event_demand counts", async () => {
    const replies = await readGuestReplies(typed(owner), w, event);
    const guests = await activeGuests(owner);
    const ids = guests.map((r) => r.id);
    const demand = (
      (await ok(owner.client.rpc("event_demand", { p_wedding: w }))) as {
        event_id: string;
        invited: number;
        yes: number;
        waiting_open: number;
        waiting_closed: number;
        no: number;
        seated_confirmed: number;
        yes_without_meal: number;
      }[]
    ).find((d) => d.event_id === event)!;

    const totals = replyTotals(ids, replies);
    expect(totals.yes).toBe(demand.yes);
    expect(totals.waiting).toBe(demand.waiting_open + demand.waiting_closed);
    expect(totals.no).toBe(demand.no);
    expect(totals.no_meal).toBe(demand.yes_without_meal);
    expect(totals.not_seated).toBe(Math.max(demand.yes - demand.seated_confirmed, 0));
    expect(totals.yes + totals.waiting + totals.no).toBe(demand.invited);

    // And the right people, not just the right numbers.
    const pick = (f: Parameters<typeof matchesReply>[1]) =>
      guests
        .filter((r) => matchesReply(replies.byGuest.get(r.id), f))
        .map((r) => names.get(r.id) ?? r.full_name)
        .sort();
    expect(pick("yes")).toEqual(["Plusone Example", "nomeal", "seated", "unseated"]);
    expect(pick("waiting")).toEqual(["late", "wait"]);
    expect(pick("no")).toEqual(["no"]);
    expect(pick("not_invited")).toEqual(["outside"]);
    expect(pick("no_meal")).toEqual(["Plusone Example", "nomeal"]);
    expect(pick("not_seated")).toEqual(["Plusone Example", "nomeal", "unseated"]);
  });

  it("shows meal, seat, plus-one and a passed reply date per guest", async () => {
    const replies = await readGuestReplies(typed(owner), w, event);
    const by = (key: string) => replies.byGuest.get([...names].find(([, k]) => k === key)![0]);
    expect(by("seated")).toMatchObject({
      answer: "yes",
      meal: "Fish",
      seat: { tableLabel: "Table 6", seatNumber: null, tentative: false },
    });
    expect(by("late")).toMatchObject({ answer: "waiting", replyClosed: true });
    expect(by("wait")).toMatchObject({ answer: "waiting", replyClosed: false });
    const plusOne = [...replies.byGuest.values()].filter((r) => r.isPlusOne);
    expect(plusOne).toHaveLength(1);
    expect(replies.asksMeal).toBe(true);
  });

  it("returns no rows to a viewer, an editor without the guests grant, or a stranger", async () => {
    const add = async (role: "viewer" | "editor") => {
      const user = await createUser(`replies-${role}`);
      await withSuperuser((db) =>
        db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3)", [
          w,
          user.id,
          role,
        ]),
      );
      return user;
    };
    for (const u of [await add("viewer"), await add("editor"), await createUser("replies-out")]) {
      const replies = await readGuestReplies(typed(u), w, event);
      expect(replies.byGuest.size).toBe(0);
    }
  });

  it("an editor holding the guests grant sees the same replies as the owner", async () => {
    const editor = await createUser("replies-granted");
    const membership = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'editor') returning id, version",
            [w, editor.id],
          )
        ).rows[0] as { id: string; version: number },
    );
    await ok(
      owner.client.rpc("set_editor_grants", {
        p_membership: membership.id,
        p_areas: ["guests"],
        p_expected_version: membership.version,
      }),
    );
    const mine = await readGuestReplies(typed(owner), w, event);
    const theirs = await readGuestReplies(typed(editor), w, event);
    expect(Object.fromEntries(theirs.byGuest)).toEqual(Object.fromEntries(mine.byGuest));
  });
});
