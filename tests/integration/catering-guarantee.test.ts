import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  anonClient,
  createUser,
  createWedding,
  withSuperuser,
  type TestUser,
} from "./helpers";

// REL-08: caterer count, the guarantee (ADR-031 D5). A locked count never moves with replies; it
// changes only by a revision with a reason, and the old count stays as history. The lock refuses
// a breakdown the person did not see, one winner takes a race, and members who may not read guest
// totals read nothing.

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("cg-owner");
  stranger = await createUser("cg-stranger");
});

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const ymd = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

type Seen = { yes: number; withoutMeal: number; meals: { id: string; count: number }[] };
type Fixture = {
  w: string;
  event: string;
  guests: string[];
  members: string[];
  meals: string[];
  invitation: { raw: string };
};

async function addMember(w: string, role: "partner" | "editor" | "viewer", label: string) {
  const user = await createUser(label);
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3)", [
      w,
      user.id,
      role,
    ]),
  );
  return user;
}

/** One event, two meals and n invited guests who have not answered. */
async function setup(n = 6): Promise<Fixture> {
  const w = await createWedding(owner);
  const event = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception" },
    }),
  )) as string;
  const meals: string[] = [];
  for (const name of ["Chicken", "Veg"]) {
    meals.push(
      (await ok(
        owner.client.rpc("add_meal_option", { p_wedding: w, p_event_id: event, p_name: name }),
      )) as string,
    );
  }
  const guests: string[] = [];
  for (let i = 0; i < n; i++) {
    guests.push(
      (await ok(
        owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name: `Guest ${i} Example` } }),
      )) as string,
    );
  }
  const raw = randomBytes(32).toString("base64url");
  const created = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: event,
      p_groups: [{ guestIds: guests, householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: future(30),
      p_token_hashes: [sha(raw)],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  const rows = await withSuperuser(
    async (db) =>
      (
        await db.query(
          "select id, guest_id from public.invitation_members where invitation_id = $1",
          [created[0]!.o_invitation_id],
        )
      ).rows,
  );
  return {
    w,
    event,
    guests,
    members: guests.map((g) => rows.find((r) => r.guest_id === g)!.id as string),
    meals,
    invitation: { raw },
  };
}

const respond = (
  f: Fixture,
  i: number,
  status: "accepted" | "declined" | "pending",
  meal?: string,
) =>
  ok(
    owner.client.rpc("override_rsvp_response", {
      p_wedding: f.w,
      p_member_id: f.members[i]!,
      p_status: status,
      p_reason: "test",
      ...(meal && { p_meal_option_id: meal }),
    }),
  );

type Demand = {
  event_id: string;
  yes: number;
  yes_without_meal: number;
  meals: { id: string; name: string; active: boolean; count: number }[];
};
async function demand(f: Fixture, user: TestUser = owner) {
  const rows = (await ok(user.client.rpc("event_demand", { p_wedding: f.w }))) as Demand[];
  return rows.find((r) => r.event_id === f.event)!;
}
/** What the tray would send: today's replies for the event. */
async function seen(f: Fixture): Promise<Seen> {
  const d = await demand(f);
  return {
    yes: d.yes,
    withoutMeal: d.yes_without_meal,
    meals: d.meals.map((m) => ({ id: m.id, count: m.count })),
  };
}

type LockArgs = {
  count?: number;
  seen?: Seen;
  candidate?: string | null;
  due?: string | null;
  key?: string | null;
};
async function lock(f: Fixture, user: TestUser = owner, a: LockArgs = {}) {
  return user.client.rpc("lock_guarantee", {
    p_wedding: f.w,
    p_event: f.event,
    p_count: a.count ?? 100,
    p_seen: a.seen ?? (await seen(f)),
    ...(a.candidate && { p_candidate: a.candidate }),
    ...(a.due && { p_due: a.due }),
    ...(a.key && { p_idempotency_key: a.key }),
  });
}
type ReviseArgs = LockArgs & { reason?: string };
async function revise(f: Fixture, id: string, user: TestUser = owner, a: ReviseArgs = {}) {
  return user.client.rpc("revise_guarantee", {
    p_wedding: f.w,
    p_guarantee: id,
    p_count: a.count ?? 90,
    p_seen: a.seen ?? (await seen(f)),
    p_reason: a.reason ?? "The venue lost a table",
    ...(a.candidate && { p_candidate: a.candidate }),
    ...(a.due && { p_due: a.due }),
    ...(a.key && { p_idempotency_key: a.key }),
  });
}

type Row = {
  id: string;
  status: string;
  guaranteed_count: number;
  yes_at_lock: number;
  without_meal_at_lock: number;
  meals: { id: string; name: string; count: number }[];
  due_on: string | null;
  candidate_id: string | null;
  supersedes_id: string | null;
  reason: string | null;
  superseded_at: string | null;
};
const rows = (f: Fixture) =>
  withSuperuser(
    async (db) =>
      (
        await db.query<Row>(
          "select * from public.catering_guarantees where event_id = $1 order by locked_at, id",
          [f.event],
        )
      ).rows,
  );
const audits = (f: Fixture, action: string) =>
  withSuperuser(async (db) =>
    (
      await db.query(
        "select safe_changes from public.audit_events where wedding_id = $1 and action = $2 order by occurred_at, id",
        [f.w, action],
      )
    ).rows.map((r) => r.safe_changes as Record<string, unknown>),
  );
const tasks = (f: Fixture) =>
  withSuperuser(
    async (db) =>
      (
        await db.query<{ title: string; due_date: string | null; notes: string | null }>(
          "select title, to_char(due_date, 'YYYY-MM-DD') as due_date, notes from public.tasks where wedding_id = $1 and title like 'Send the %guest count to the caterer%' order by created_at, id",
          [f.w],
        )
      ).rows,
  );
const vendor = async (f: Fixture, name: string, category = "caterer") =>
  (await ok(
    owner.client.rpc("create_candidate", {
      p_wedding: f.w,
      p_kind: "vendor",
      p_category: category,
      p_name: name,
    }),
  )) as string;
const assignVendor = (f: Fixture, v: string) =>
  ok(
    owner.client.rpc("set_event_vendors", {
      p_wedding: f.w,
      p_event: f.event,
      p_add: [v],
      p_remove: [],
    }),
  );

describe("lock_guarantee", () => {
  it("locks the number the couple chose and saves the replies it rested on", async () => {
    const f = await setup();
    await respond(f, 0, "accepted", f.meals[0]);
    await respond(f, 1, "accepted", f.meals[0]);
    await respond(f, 2, "accepted", f.meals[1]);
    await respond(f, 3, "accepted"); // no meal yet
    await respond(f, 4, "declined");
    const id = await ok(lock(f, owner, { count: 120 })); // a buffer above the 4 attending
    const [row] = await rows(f);
    expect(row).toMatchObject({
      id,
      status: "locked",
      guaranteed_count: 120,
      yes_at_lock: 4,
      without_meal_at_lock: 1,
      supersedes_id: null,
      reason: null,
      superseded_at: null,
    });
    expect(row!.meals.map((m) => [m.name, m.count])).toEqual([
      ["Chicken", 2],
      ["Veg", 1],
    ]);
    // Counts and notes stay out of the audit trail.
    expect(await audits(f, "catering.locked")).toEqual([
      { eventId: f.event, hasCaterer: false, hasDue: false },
    ]);
  });

  it("PDF §8 test 4: a guest cancels after the lock and the locked count does not move", async () => {
    const f = await setup(3);
    await respond(f, 0, "accepted", f.meals[0]);
    await respond(f, 1, "accepted", f.meals[1]);
    await respond(f, 2, "accepted", f.meals[0]);
    await ok(lock(f, owner, { count: 3 }));
    const before = (await rows(f))[0]!;

    // Seating is finalized, then a guest cancels from their own link.
    const layout = (await ok(
      owner.client.rpc("ensure_seating_layout", { p_wedding: f.w, p_event_id: f.event }),
    )) as string;
    const table = (await ok(
      owner.client.rpc("add_seating_table", {
        p_wedding: f.w,
        p_layout: layout,
        p_label: "A",
        p_capacity: 4,
      }),
    )) as string;
    for (const g of f.guests) {
      await ok(
        owner.client.rpc("assign_guest_seat", {
          p_wedding: f.w,
          p_layout: layout,
          p_guest: g,
          p_table: table,
        }),
      );
    }
    const layoutRow = () =>
      withSuperuser(
        async (db) =>
          (await db.query("select * from public.seating_layouts where id = $1", [layout])).rows[0],
      );
    const pre = await layoutRow();
    await ok(
      owner.client.rpc("finalize_seating_layout", {
        p_wedding: f.w,
        p_layout: layout,
        p_expected_revision: pre.revision,
      }),
    );
    const frozen = await layoutRow();
    const view = (await ok(
      adminClient().rpc("rsvp_view", {
        p_token_hash: sha(f.invitation.raw),
        p_client: `c-${randomUUID().slice(0, 12)}`,
      }),
    )) as { version: number };
    await ok(
      adminClient().rpc("rsvp_submit", {
        p_token_hash: sha(f.invitation.raw),
        p_client: `c-${randomUUID().slice(0, 12)}`,
        p_expected_version: view.version,
        p_responses: [{ memberId: f.members[0], status: "declined" }],
      }),
    );

    // Replies moved, the plan went stale, the locked count is exactly as it was.
    expect((await demand(f)).yes).toBe(2);
    const after = await layoutRow();
    expect(after.finalized_revision).toBe(frozen.revision);
    expect(after.revision).toBeGreaterThan(frozen.revision);
    expect(await rows(f)).toEqual([before]);
  });

  it("refuses when replies changed since the preview, and writes nothing", async () => {
    const f = await setup();
    await respond(f, 0, "accepted", f.meals[0]);
    const old = await seen(f);
    await respond(f, 1, "accepted", f.meals[1]); // a reply lands after the person looked
    const r = await lock(f, owner, { seen: old });
    expect(r.error?.code).toBe("CG412");
    expect(await rows(f)).toHaveLength(0);
    expect(await tasks(f)).toHaveLength(0);
    // Looking again works.
    await ok(lock(f, owner, { count: 10 }));
    expect(await rows(f)).toHaveLength(1);
  });

  it("notices a single meal count, the without-meal figure or a new meal option changing", async () => {
    const f = await setup();
    await respond(f, 0, "accepted", f.meals[0]);
    const base = await seen(f);
    const bump = (i: number): Seen => ({
      ...base,
      meals: base.meals.map((m, j) => (j === i ? { ...m, count: m.count + 1 } : m)),
    });
    for (const bad of [
      bump(0),
      bump(1),
      { ...base, withoutMeal: base.withoutMeal + 1 },
      { ...base, yes: base.yes + 1 },
      { ...base, meals: base.meals.slice(1) },
      { ...base, meals: [...base.meals, { id: randomUUID(), count: 0 }] },
    ]) {
      expect((await lock(f, owner, { seen: bad })).error?.code).toBe("CG412");
    }
    expect(await rows(f)).toHaveLength(0);
    // Order does not matter.
    await ok(lock(f, owner, { seen: { ...base, meals: [...base.meals].reverse() } }));
  });

  it("refuses a preview that is the wrong shape", async () => {
    const f = await setup();
    const base = await seen(f);
    const bad: unknown[] = [
      null,
      [],
      { yes: 1 },
      { ...base, yes: -1 },
      { ...base, yes: 1.5 },
      { ...base, meals: "no" },
      { ...base, meals: [{ id: 7, count: 1 }] },
      { ...base, meals: [{ id: f.meals[0], count: "1" }] },
      {
        ...base,
        meals: [
          { id: f.meals[0], count: 0 },
          { id: f.meals[0], count: 0 },
        ],
      },
      { ...base, meals: Array.from({ length: 41 }, () => ({ id: randomUUID(), count: 0 })) },
    ];
    for (const seenValue of bad) {
      const r = await owner.client.rpc("lock_guarantee", {
        p_wedding: f.w,
        p_event: f.event,
        p_count: 5,
        p_seen: seenValue as never,
      });
      expect(r.error?.code, JSON.stringify(seenValue)).toBe("22023");
    }
    expect(await rows(f)).toHaveLength(0);
  });

  it("refuses counts outside 1 to 5000 and dates outside the supported range", async () => {
    const f = await setup();
    for (const count of [0, -4, 5001]) {
      expect((await lock(f, owner, { count })).error?.code, String(count)).toBe("22023");
    }
    expect((await lock(f, owner, { due: "1969-12-31" })).error?.code).toBe("22023");
    expect((await lock(f, owner, { due: "2201-01-01" })).error?.code).toBe("22023");
    expect((await lock(f, owner, { key: "short" })).error?.code).toBe("22023");
    expect(await rows(f)).toHaveLength(0);
  });

  it("gives one winner when several people lock at once", async () => {
    for (let round = 0; round < 3; round++) {
      const f = await setup(3);
      await respond(f, 0, "accepted", f.meals[0]);
      const results = await Promise.all(
        [100, 101, 102, 103].map((count) => lock(f, owner, { count })),
      );
      const wins = results.filter((r) => !r.error);
      expect(wins).toHaveLength(1);
      for (const r of results.filter((x) => x.error)) expect(r.error?.code).toBe("CG409");
      const stored = await rows(f);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.id).toBe(wins[0]!.data);
    }
  });

  it("answers a repeated request with the same row, one task and one audit entry", async () => {
    const f = await setup();
    await respond(f, 0, "accepted", f.meals[0]);
    const key = `lock-${randomUUID()}`;
    const args = { count: 50, due: ymd(40), key };
    const a = await ok(lock(f, owner, args));
    const b = await ok(lock(f, owner, args));
    expect(b).toBe(a);
    expect(await rows(f)).toHaveLength(1);
    expect(await tasks(f)).toHaveLength(1);
    expect(await audits(f, "catering.locked")).toHaveLength(1);
    // The same key with a different count is refused, not silently merged.
    const clash = await lock(f, owner, { ...args, count: 51 });
    expect(clash.error?.code).toBe("23505");
  });

  it("refuses a second lock for an event that already has one", async () => {
    const f = await setup();
    await ok(lock(f));
    const again = await lock(f, owner, { count: 99 });
    expect(again.error?.code).toBe("CG409");
    expect((await rows(f)).filter((r) => r.status === "locked")).toHaveLength(1);
  });
});

describe("caterer choice", () => {
  it("accepts a vendor assigned to the event and keeps it on the row", async () => {
    const f = await setup();
    const v = await vendor(f, "Fork & Spoon");
    await assignVendor(f, v);
    await ok(lock(f, owner, { candidate: v }));
    expect((await rows(f))[0]!.candidate_id).toBe(v);
    expect(await audits(f, "catering.locked")).toEqual([
      { eventId: f.event, hasCaterer: true, hasDue: false },
    ]);
  });

  it("refuses a vendor that is not assigned to this event, a venue, a foreign vendor, or a passed one", async () => {
    const f = await setup();
    const unassigned = await vendor(f, "Not Here Catering");
    expect((await lock(f, owner, { candidate: unassigned })).error?.code).toBe("22023");

    const venue = (await ok(
      owner.client.rpc("create_candidate", {
        p_wedding: f.w,
        p_kind: "venue",
        p_category: "venue",
        p_name: "The Barn",
      }),
    )) as string;
    expect((await lock(f, owner, { candidate: venue })).error?.code).toBe("22023");

    const g = await setup(1);
    const foreign = await vendor(g, "Other Wedding Catering");
    await assignVendor(g, foreign);
    expect((await lock(f, owner, { candidate: foreign })).error?.code).toBe("22023");

    const passed = await vendor(f, "Passed Catering");
    await assignVendor(f, passed);
    await withSuperuser((db) =>
      db.query("update public.candidates set stage='declined' where id=$1", [passed]),
    );
    expect((await lock(f, owner, { candidate: passed })).error?.code).toBe("22023");
    expect(await rows(f)).toHaveLength(0);
  });

  it("lets a revision keep a caterer that was passed on since, but not switch to one", async () => {
    const f = await setup();
    const v = await vendor(f, "Fork & Spoon");
    const w = await vendor(f, "Second Caterer");
    await assignVendor(f, v);
    await assignVendor(f, w);
    const id = (await ok(lock(f, owner, { candidate: v }))) as string;
    await withSuperuser((db) =>
      db.query("update public.candidates set stage='cancelled' where id in ($1,$2)", [v, w]),
    );
    // Keeping the same caterer is allowed; the count can still change.
    const rev = (await ok(revise(f, id, owner, { count: 80, candidate: v }))) as string;
    expect((await rows(f)).find((r) => r.id === rev)!.candidate_id).toBe(v);
    // Switching to a different passed vendor is not.
    expect((await revise(f, rev, owner, { count: 70, candidate: w })).error?.code).toBe("22023");
  });
});

describe("reminder task", () => {
  it("is due a week before the caterer's date when that is still ahead", async () => {
    const f = await setup();
    await ok(lock(f, owner, { due: ymd(40) }));
    const [t] = await tasks(f);
    expect(t!.title).toBe("Send the final guest count to the caterer (Reception)");
    expect(t!.due_date).toBe(ymd(33));
    expect(t!.notes).toContain("Nothing is sent from this app");
    // No number in the title: every member can read tasks, not every member may read totals.
    expect(t!.title).not.toMatch(/\d/);
  });

  it("is due today when the caterer's date is less than a week away, and on the date when it has passed", async () => {
    const soon = await setup();
    await ok(lock(soon, owner, { due: ymd(3) }));
    const today = await withSuperuser(
      async (db) =>
        (
          await db.query<{ d: string }>(
            "select to_char((now() at time zone w.timezone)::date, 'YYYY-MM-DD') d from public.weddings w where w.id = $1",
            [soon.w],
          )
        ).rows[0]!.d,
    );
    expect((await tasks(soon))[0]!.due_date).toBe(today);

    const late = await setup();
    await ok(lock(late, owner, { due: ymd(-10) }));
    expect((await tasks(late))[0]!.due_date).toBe(ymd(-10));
  });

  it("is not created without a date", async () => {
    const f = await setup();
    await ok(lock(f));
    expect(await tasks(f)).toHaveLength(0);
  });
});

describe("revise_guarantee", () => {
  it("supersedes the old count, keeps it as history and records the reason", async () => {
    const f = await setup();
    await respond(f, 0, "accepted", f.meals[0]);
    const first = (await ok(lock(f, owner, { count: 118 }))) as string;
    await respond(f, 1, "accepted", f.meals[1]);
    const second = (await ok(
      revise(f, first, owner, { count: 112, reason: "  Venue lost a table  " }),
    )) as string;
    expect(second).not.toBe(first);
    const [a, b] = await rows(f);
    expect(a).toMatchObject({ id: first, status: "superseded", guaranteed_count: 118 });
    expect(a!.superseded_at).not.toBeNull();
    expect(b).toMatchObject({
      id: second,
      status: "locked",
      guaranteed_count: 112,
      supersedes_id: first,
      reason: "Venue lost a table",
      yes_at_lock: 2,
    });
    // Field names only in the audit trail, never the reason or the numbers.
    expect(await audits(f, "catering.revised")).toEqual([
      { eventId: f.event, changed: expect.arrayContaining(["count", "replies"]) },
    ]);
  });

  it("requires a reason", async () => {
    const f = await setup();
    const id = (await ok(lock(f))) as string;
    for (const reason of ["", "   ", "x".repeat(501)]) {
      expect((await revise(f, id, owner, { reason })).error?.code, reason.length + "").toBe(
        "22023",
      );
    }
    expect(await rows(f)).toHaveLength(1);
  });

  it("changes nothing, and adds no row, task or audit entry, when nothing differs", async () => {
    const f = await setup();
    await respond(f, 0, "accepted", f.meals[0]);
    const id = (await ok(lock(f, owner, { count: 60, due: ymd(30) }))) as string;
    const same = await ok(revise(f, id, owner, { count: 60, due: ymd(30) }));
    expect(same).toBe(id);
    expect(await rows(f)).toHaveLength(1);
    expect((await rows(f))[0]!.status).toBe("locked");
    expect(await audits(f, "catering.revised")).toHaveLength(0);
    expect(await tasks(f)).toHaveLength(1);
  });

  it("makes a new reminder only when the count or date changed", async () => {
    const f = await setup();
    const v = await vendor(f, "Fork & Spoon");
    await assignVendor(f, v);
    const a = (await ok(lock(f, owner, { count: 60, due: ymd(30) }))) as string;
    // Only the caterer changed: nothing new to send.
    const b = (await ok(revise(f, a, owner, { count: 60, due: ymd(30), candidate: v }))) as string;
    expect(await tasks(f)).toHaveLength(1);
    // The count changed: a new reminder, worded as a revision.
    await ok(revise(f, b, owner, { count: 55, due: ymd(30), candidate: v }));
    const t = await tasks(f);
    expect(t).toHaveLength(2);
    expect(t[1]!.title).toBe("Send the revised guest count to the caterer (Reception)");
  });

  it("refuses a revision of a count someone else already revised", async () => {
    const f = await setup();
    const first = (await ok(lock(f))) as string;
    await ok(revise(f, first, owner, { count: 90 }));
    const stale = await revise(f, first, owner, { count: 80 });
    expect(stale.error?.code).toBe("55000");
    expect((await rows(f)).filter((r) => r.status === "locked")).toHaveLength(1);
  });

  it("gives one winner when two people revise the same count at once", async () => {
    for (let round = 0; round < 3; round++) {
      const f = await setup(3);
      const first = (await ok(lock(f))) as string;
      const results = await Promise.all(
        [91, 92, 93].map((count) => revise(f, first, owner, { count })),
      );
      expect(results.filter((r) => !r.error)).toHaveLength(1);
      for (const r of results.filter((x) => x.error)) expect(r.error?.code).toBe("55000");
      const stored = await rows(f);
      expect(stored).toHaveLength(2);
      expect(stored.filter((r) => r.status === "locked")).toHaveLength(1);
    }
  });

  it("refuses a stale preview, and a foreign guarantee id", async () => {
    const f = await setup();
    const id = (await ok(lock(f))) as string;
    const old = await seen(f);
    await respond(f, 0, "accepted", f.meals[0]);
    expect((await revise(f, id, owner, { seen: old })).error?.code).toBe("CG412");

    const g = await setup(1);
    // A guarantee id from another wedding does not exist here.
    const foreign = (await ok(lock(g))) as string;
    expect((await revise(f, foreign)).error?.code).toBe("42501");
    expect((await rows(f)).filter((r) => r.status === "locked")).toHaveLength(1);
  });

  it("is idempotent per key", async () => {
    const f = await setup();
    const first = (await ok(lock(f))) as string;
    const key = `rev-${randomUUID()}`;
    const a = await ok(revise(f, first, owner, { count: 70, key }));
    const b = await ok(revise(f, first, owner, { count: 70, key }));
    expect(b).toBe(a);
    expect(await rows(f)).toHaveLength(2);
    expect(await audits(f, "catering.revised")).toHaveLength(1);
  });
});

describe("who may lock, revise and read", () => {
  it("lets owner and partner lock and revise; editors, viewers, strangers and anonymous callers cannot", async () => {
    const f = await setup();
    const partner = await addMember(f.w, "partner", "cg-partner");
    const editor = await addMember(f.w, "editor", "cg-editor");
    const viewer = await addMember(f.w, "viewer", "cg-viewer");
    for (const user of [editor, viewer, stranger]) {
      expect((await lock(f, user)).error?.code).toBe("42501");
    }
    const anon = anonClient();
    const r = await anon.rpc("lock_guarantee", {
      p_wedding: f.w,
      p_event: f.event,
      p_count: 5,
      p_seen: { yes: 0, withoutMeal: 0, meals: [] },
    });
    expect(r.error).not.toBeNull();
    expect(await rows(f)).toHaveLength(0);

    const id = (await ok(lock(f, partner, { count: 40 }))) as string;
    for (const user of [editor, viewer, stranger]) {
      expect((await revise(f, id, user)).error?.code).toBe("42501");
    }
    await ok(revise(f, id, partner, { count: 38 }));
    expect(await rows(f)).toHaveLength(2);
  });

  it("shows rows to owner and partner, and to others only while guest totals are shared", async () => {
    const f = await setup();
    const partner = await addMember(f.w, "partner", "cg-partner-r");
    const editor = await addMember(f.w, "editor", "cg-editor-r");
    const viewer = await addMember(f.w, "viewer", "cg-viewer-r");
    await ok(lock(f, owner, { count: 30 }));
    const read = async (u: TestUser) =>
      (await ok(u.client.from("catering_guarantees").select("id").eq("wedding_id", f.w))) ?? [];
    expect(await read(owner)).toHaveLength(1);
    expect(await read(partner)).toHaveLength(1);
    for (const u of [editor, viewer, stranger]) expect(await read(u)).toHaveLength(0);

    await ok(owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
    expect(await read(editor)).toHaveLength(1);
    expect(await read(viewer)).toHaveLength(1);
    expect(await read(stranger)).toHaveLength(0);
    await ok(owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: false }));
    expect(await read(editor)).toHaveLength(0);
  });

  it("refuses a lock for an event or caterer in another wedding", async () => {
    const f = await setup();
    const g = await setup();
    const r = await owner.client.rpc("lock_guarantee", {
      p_wedding: f.w,
      p_event: g.event,
      p_count: 5,
      p_seen: await seen(g),
    });
    expect(r.error?.code).toBe("42501");
    expect(await rows(g)).toHaveLength(0);
    expect(await rows(f)).toHaveLength(0);
  });

  it("gives clients no direct write access", async () => {
    const f = await setup();
    const id = (await ok(lock(f))) as string;
    const upd = await owner.client
      .from("catering_guarantees")
      .update({ guaranteed_count: 5 })
      .eq("id", id)
      .select();
    expect(upd.data ?? []).toHaveLength(0);
    const del = await owner.client.from("catering_guarantees").delete().eq("id", id).select();
    expect(del.data ?? []).toHaveLength(0);
    const ins = await owner.client.from("catering_guarantees").insert({
      wedding_id: f.w,
      event_id: f.event,
      guaranteed_count: 5,
      yes_at_lock: 0,
      without_meal_at_lock: 0,
      meals: [],
    });
    expect(ins.error).not.toBeNull();
    expect((await rows(f))[0]!.guaranteed_count).toBe(100);
  });
});

describe("the table keeps its history", () => {
  it("refuses edits and deletes even from the database role, but lets a wedding be erased", async () => {
    const f = await setup();
    const id = (await ok(lock(f))) as string;
    await withSuperuser(async (db) => {
      await expect(
        db.query("update public.catering_guarantees set guaranteed_count = 1 where id = $1", [id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.query("update public.catering_guarantees set reason = 'x' where id = $1", [id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.query("delete from public.catering_guarantees where id = $1", [id]),
      ).rejects.toThrow(/append-only/);
    });
    expect((await rows(f))[0]!.guaranteed_count).toBe(100);

    // Erasing a whole wedding is the one permitted deletion. A wedding with no invitations is used
    // here so that other tables' own rules do not get in the way.
    const w = await createWedding(owner);
    const e = (await ok(
      owner.client.rpc("create_event", {
        p_wedding: w,
        p_event: { name: "Brunch", kind: "other" },
      }),
    )) as string;
    await ok(
      owner.client.rpc("lock_guarantee", {
        p_wedding: w,
        p_event: e,
        p_count: 5,
        p_seen: { yes: 0, withoutMeal: 0, meals: [] },
      }),
    );
    const count = () =>
      withSuperuser(async (db) =>
        Number(
          (
            await db.query(
              "select count(*) n from public.catering_guarantees where event_id = $1",
              [e],
            )
          ).rows[0].n,
        ),
      );
    expect(await count()).toBe(1);
    await withSuperuser((db) => db.query("delete from public.weddings where id = $1", [w]));
    expect(await count()).toBe(0);
  });

  it("allows only one locked row per event and one revision per row, and pairs a revision with a reason", async () => {
    const f = await setup();
    const id = (await ok(lock(f))) as string;
    const insert = (extra: string, params: unknown[]) =>
      withSuperuser((db) =>
        db.query(
          `insert into public.catering_guarantees
             (wedding_id, event_id, guaranteed_count, yes_at_lock, without_meal_at_lock, meals ${extra})
           values ($1, $2, 5, 0, 0, '[]'::jsonb ${params.length > 2 ? ", $3, $4" : ""})`,
          params,
        ),
      );
    await expect(insert("", [f.w, f.event])).rejects.toThrow(/catering_guarantees_one_locked/);
    // A reason without a revision, or a revision without a reason, is refused.
    await expect(insert(", reason", [f.w, f.event, "why", null])).rejects.toThrow();
    await expect(insert(", supersedes_id", [f.w, f.event, id, null])).rejects.toThrow();
  });

  it("removes nothing when an event's caterer count is read after the replies fall to zero", async () => {
    const f = await setup(2);
    await respond(f, 0, "accepted", f.meals[0]);
    await ok(lock(f, owner, { count: 5 }));
    await respond(f, 0, "declined");
    expect((await demand(f)).yes).toBe(0);
    expect((await rows(f))[0]).toMatchObject({ guaranteed_count: 5, status: "locked" });
  });
});
