import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-17 last slice: day-of check-in. Real local Postgres, PostgREST and RLS. Names are synthetic.

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("checkin-owner");
  stranger = await createUser("checkin-stranger");
});

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}
const code = async (p: PromiseLike<{ error: { code?: string } | null }>) =>
  (await p).error?.code ?? null;
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows as T[]);
}

type Fixture = { w: string; event: string; guests: string[]; members: string[] };

/** A wedding with one event and n invited guests, all waiting. */
async function setup(n = 3): Promise<Fixture> {
  const w = await createWedding(owner);
  const event = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception" },
    }),
  )) as string;
  const guests: string[] = [];
  for (let i = 0; i < n; i++) {
    guests.push(
      (await ok(
        owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name: `Guest ${i} Example` } }),
      )) as string,
    );
  }
  const created = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: event,
      p_groups: [{ guestIds: guests, householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: future(30),
      p_token_hashes: [sha(randomBytes(32).toString("base64url"))],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  const rows = await q<{ id: string; guest_id: string }>(
    "select id, guest_id from public.invitation_members where invitation_id = $1",
    [created[0]!.o_invitation_id],
  );
  return { w, event, guests, members: guests.map((g) => rows.find((r) => r.guest_id === g)!.id) };
}

const respond = (f: Fixture, i: number, status: "accepted" | "declined" | "pending") =>
  owner.client.rpc("override_rsvp_response", {
    p_wedding: f.w,
    p_member_id: f.members[i]!,
    p_status: status,
    p_reason: "test",
  });
const checkIn = (f: Fixture, idx: number[], as: TestUser = owner, event = f.event) =>
  as.client.rpc("check_in_guests", {
    p_wedding: f.w,
    p_event: event,
    p_guests: idx.map((i) => f.guests[i]!),
  });
const undo = (f: Fixture, i: number, as: TestUser = owner) =>
  as.client.rpc("undo_guest_check_in", {
    p_wedding: f.w,
    p_event: f.event,
    p_guest: f.guests[i]!,
  });
const arrivedIds = async (f: Fixture) =>
  (
    await q<{ guest_id: string }>(
      "select guest_id from public.guest_checkins where event_id = $1 order by guest_id",
      [f.event],
    )
  ).map((r) => r.guest_id);

async function addMember(
  w: string,
  role: "partner" | "editor" | "viewer",
  permissions: object = {},
) {
  const user = await createUser(`checkin-${role}`);
  await q(
    "insert into public.memberships (wedding_id, user_id, role, permissions) values ($1,$2,$3,$4)",
    [w, user.id, role, JSON.stringify(permissions)],
  );
  return user;
}

describe("guest check-in", () => {
  it("records arrivals apart from the reply, and repeating changes nothing", async () => {
    const f = await setup(3);
    await ok(respond(f, 0, "accepted"));
    // Guest 1 never answered; guest 2 declined. Both can still be recorded when they turn up.
    await ok(respond(f, 2, "declined"));
    expect(await ok(checkIn(f, [0, 1, 2]))).toBe(3);
    const first = await q<{ guest_id: string; checked_in_at: string }>(
      "select guest_id, checked_in_at from public.guest_checkins where event_id = $1",
      [f.event],
    );
    expect(first).toHaveLength(3);
    expect(await ok(checkIn(f, [0, 1]))).toBe(0);
    const again = await q<{ guest_id: string; checked_in_at: string }>(
      "select guest_id, checked_in_at from public.guest_checkins where event_id = $1",
      [f.event],
    );
    expect(new Map(again.map((r) => [r.guest_id, +new Date(r.checked_in_at)]))).toEqual(
      new Map(first.map((r) => [r.guest_id, +new Date(r.checked_in_at)])),
    );
    // The replies are untouched.
    const replies = await q<{ rsvp_status: string }>(
      "select rsvp_status from public.invitation_members where event_id = $1 order by rsvp_status",
      [f.event],
    );
    expect(replies.map((r) => r.rsvp_status)).toEqual(["accepted", "declined", "pending"]);
  });

  it("undoes a mistaken tap and says so when there was nothing to undo", async () => {
    const f = await setup(2);
    await ok(checkIn(f, [0]));
    expect(await ok(undo(f, 0))).toBe(true);
    expect(await ok(undo(f, 0))).toBe(false);
    expect(await arrivedIds(f)).toEqual([]);
  });

  it("keeps a check-in when the guest's reply later changes", async () => {
    const f = await setup(2);
    await ok(respond(f, 0, "accepted"));
    await ok(checkIn(f, [0]));
    await ok(respond(f, 0, "declined"));
    expect(await arrivedIds(f)).toEqual([f.guests[0]]);
  });

  it("refuses a guest with no active invitation to the event, a revoked one, an archived one", async () => {
    const f = await setup(3);
    const other = (await ok(
      owner.client.rpc("create_guest", { p_wedding: f.w, p_guest: { name: "Uninvited Example" } }),
    )) as string;
    expect(
      await code(
        owner.client.rpc("check_in_guests", {
          p_wedding: f.w,
          p_event: f.event,
          p_guests: [other],
        }),
      ),
    ).toBe("CI422");
    await q("update public.invitation_members set active = false where id = $1", [f.members[1]]);
    expect(await code(checkIn(f, [1]))).toBe("CI422");
    await q("update public.guests set archived_at = now() where id = $1", [f.guests[2]]);
    expect(await code(checkIn(f, [2]))).toBe("CI422");
    expect(await arrivedIds(f)).toEqual([]);
  });

  it("is all or nothing when one guest in the batch is not eligible", async () => {
    const f = await setup(3);
    await q("update public.guests set archived_at = now() where id = $1", [f.guests[2]]);
    expect(await code(checkIn(f, [0, 1, 2]))).toBe("CI422");
    expect(await arrivedIds(f)).toEqual([]);
  });

  it("limits a batch to 20 and refuses an empty one", async () => {
    const f = await setup(1);
    expect(
      await code(
        owner.client.rpc("check_in_guests", {
          p_wedding: f.w,
          p_event: f.event,
          p_guests: Array.from({ length: 21 }, () => randomUUID()),
        }),
      ),
    ).toBe("54000");
    expect(
      await code(
        owner.client.rpc("check_in_guests", { p_wedding: f.w, p_event: f.event, p_guests: [] }),
      ),
    ).toBe("22023");
  });

  it("records a guest once when two helpers tap at the same moment", async () => {
    const f = await setup(1);
    const [a, b] = await Promise.all([checkIn(f, [0]), checkIn(f, [0])]);
    expect([a.error, b.error]).toEqual([null, null]);
    expect([a.data, b.data].sort()).toEqual([0, 1]);
    expect(await arrivedIds(f)).toEqual([f.guests[0]]);
  });

  it("does not let an event from another wedding be used", async () => {
    const f = await setup(1);
    const g = await setup(1);
    expect(await code(checkIn(f, [0], owner, g.event))).toBe("42501");
    expect(await arrivedIds(g)).toEqual([]);
  });

  it("removes check-ins with the guest or the event", async () => {
    const f = await setup(1);
    await ok(checkIn(f, [0]));
    await q("delete from public.events where id = $1", [f.event]);
    expect(
      (
        await q<{ n: string }>(
          "select count(*) n from public.guest_checkins where wedding_id = $1",
          [f.w],
        )
      )[0]!.n,
    ).toBe("0");
  });

  it("records counts, not names, in the audit trail", async () => {
    const f = await setup(2);
    await ok(checkIn(f, [0, 1]));
    await ok(undo(f, 0));
    const rows = await q<{ action: string; safe_changes: unknown }>(
      "select action, safe_changes from public.audit_events where wedding_id = $1 and action like 'checkin.%' order by occurred_at",
      [f.w],
    );
    expect(rows.map((r) => r.action)).toEqual(["checkin.guests_arrived", "checkin.guest_undone"]);
    expect(JSON.stringify(rows)).not.toMatch(/Guest \d/);
  });
});

describe("who may check guests in", () => {
  it("allows a partner and an editor with the guests grant; refuses others", async () => {
    const f = await setup(4);
    const partner = await addMember(f.w, "partner");
    const planner = await addMember(f.w, "editor", { guests: true });
    const plain = await addMember(f.w, "editor", { plan: true });
    const viewer = await addMember(f.w, "viewer");
    expect(await ok(checkIn(f, [0], partner))).toBe(1);
    expect(await ok(checkIn(f, [1], planner))).toBe(1);
    for (const u of [plain, viewer, stranger]) {
      expect(await code(checkIn(f, [2], u))).toBe("42501");
      expect(await code(undo(f, 0, u))).toBe("42501");
    }
    expect(await arrivedIds(f)).toEqual([f.guests[0], f.guests[1]].sort());
  });

  it("hides who has arrived from everyone who cannot manage guests", async () => {
    const f = await setup(2);
    await ok(checkIn(f, [0]));
    const viewer = await addMember(f.w, "viewer");
    const planner = await addMember(f.w, "editor", { guests: true });
    expect(
      await ok(owner.client.from("guest_checkins").select("guest_id").eq("wedding_id", f.w)),
    ).toHaveLength(1);
    expect(
      await ok(planner.client.from("guest_checkins").select("guest_id").eq("wedding_id", f.w)),
    ).toHaveLength(1);
    expect(
      await ok(viewer.client.from("guest_checkins").select("guest_id").eq("wedding_id", f.w)),
    ).toHaveLength(0);
    expect(
      await ok(stranger.client.from("guest_checkins").select("guest_id").eq("wedding_id", f.w)),
    ).toHaveLength(0);
  });

  it("gives clients no direct write access", async () => {
    const f = await setup(1);
    const direct = await owner.client
      .from("guest_checkins")
      .insert({ event_id: f.event, guest_id: f.guests[0]!, wedding_id: f.w });
    expect(direct.error).not.toBeNull();
    const anon = await anonClient().rpc("check_in_guests", {
      p_wedding: f.w,
      p_event: f.event,
      p_guests: [f.guests[0]!],
    });
    expect(anon.error).not.toBeNull();
    expect(await arrivedIds(f)).toEqual([]);
  });
});

describe("vendor arrivals", () => {
  async function withVendor() {
    const f = await setup(1);
    const vendor = (await ok(
      owner.client.rpc("create_candidate", {
        p_wedding: f.w,
        p_kind: "vendor",
        p_category: "photographer",
        p_name: "Lens Example",
      }),
    )) as string;
    await ok(
      owner.client.rpc("set_event_vendors", {
        p_wedding: f.w,
        p_event: f.event,
        p_add: [vendor],
        p_remove: [],
      }),
    );
    return { f, vendor };
  }
  const arrive = (f: Fixture, v: string, as: TestUser = owner) =>
    as.client.rpc("record_vendor_arrival", { p_wedding: f.w, p_event: f.event, p_candidate: v });
  const leave = (f: Fixture, v: string, as: TestUser = owner) =>
    as.client.rpc("undo_vendor_arrival", { p_wedding: f.w, p_event: f.event, p_candidate: v });

  it("records, repeats harmlessly and undoes", async () => {
    const { f, vendor } = await withVendor();
    expect(await ok(arrive(f, vendor))).toBe(true);
    expect(await ok(arrive(f, vendor))).toBe(false);
    expect(await ok(leave(f, vendor))).toBe(true);
    expect(await ok(leave(f, vendor))).toBe(false);
  });

  it("refuses a vendor that is not linked to the event", async () => {
    const { f } = await withVendor();
    const unlinked = (await ok(
      owner.client.rpc("create_candidate", {
        p_wedding: f.w,
        p_kind: "vendor",
        p_category: "music",
        p_name: "Notes Example",
      }),
    )) as string;
    expect(await code(arrive(f, unlinked))).toBe("CI423");
  });

  it("clears the arrival when the vendor is unlinked from the event", async () => {
    const { f, vendor } = await withVendor();
    await ok(arrive(f, vendor));
    await ok(
      owner.client.rpc("set_event_vendors", {
        p_wedding: f.w,
        p_event: f.event,
        p_add: [],
        p_remove: [vendor],
      }),
    );
    expect(
      (
        await q<{ n: string }>(
          "select count(*) n from public.vendor_arrivals where event_id = $1",
          [f.event],
        )
      )[0]!.n,
    ).toBe("0");
  });

  it("lets plan editors record and every member read, but not viewers write or strangers see", async () => {
    const { f, vendor } = await withVendor();
    const planner = await addMember(f.w, "editor", { plan: true });
    const noPlan = await addMember(f.w, "editor", { guests: true });
    const viewer = await addMember(f.w, "viewer");
    expect(await ok(arrive(f, vendor, planner))).toBe(true);
    for (const u of [noPlan, viewer, stranger]) {
      expect(await code(arrive(f, vendor, u))).toBe("42501");
      expect(await code(leave(f, vendor, u))).toBe("42501");
    }
    expect(
      await ok(viewer.client.from("vendor_arrivals").select("candidate_id").eq("wedding_id", f.w)),
    ).toHaveLength(1);
    expect(
      await ok(
        stranger.client.from("vendor_arrivals").select("candidate_id").eq("wedding_id", f.w),
      ),
    ).toHaveLength(0);
  });
});
