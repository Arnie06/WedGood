import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-17 first slice: guest shuttles. Real local Postgres, PostgREST and RLS. Names are synthetic.

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("shuttle-owner");
  stranger = await createUser("shuttle-stranger");
});

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const DEPARTS = "2027-06-12T20:00:00.000Z";

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

type Fixture = {
  w: string;
  event: string;
  guests: string[];
  members: string[];
  invitation: { id: string; raw: string };
};

/** A wedding with one event and n invited guests, all waiting. */
async function setup(n = 4): Promise<Fixture> {
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
        owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name: `Rider ${i} Example` } }),
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
  const invitationId = created[0]!.o_invitation_id;
  const rows = await q<{ id: string; guest_id: string }>(
    "select id, guest_id from public.invitation_members where invitation_id = $1",
    [invitationId],
  );
  const members = guests.map((g) => rows.find((r) => r.guest_id === g)!.id);
  return { w, event, guests, members, invitation: { id: invitationId, raw } };
}

const respond = (f: Fixture, i: number, status: "accepted" | "declined" | "pending") =>
  owner.client.rpc("override_rsvp_response", {
    p_wedding: f.w,
    p_member_id: f.members[i]!,
    p_status: status,
    p_reason: "test",
  });
const acceptAll = async (f: Fixture) => {
  for (let i = 0; i < f.guests.length; i++) await ok(respond(f, i, "accepted"));
};
const addRun = (
  f: Fixture,
  over: Partial<{ direction: string; label: string; capacity: number }> = {},
  as: TestUser = owner,
) =>
  as.client.rpc("add_shuttle_run", {
    p_wedding: f.w,
    p_event: f.event,
    p_direction: over.direction ?? "to_event",
    p_label: over.label ?? `Bus ${randomUUID().slice(0, 6)}`,
    p_pickup: "Grand Hotel lobby",
    p_dropoff: "",
    p_departs_at: DEPARTS,
    p_capacity: over.capacity ?? 2,
    p_notes: null,
  });
const mkRun = async (f: Fixture, over: Parameters<typeof addRun>[1] = {}) =>
  (await ok(addRun(f, over))) as string;
const assign = (f: Fixture, run: string, idx: number[], as: TestUser = owner) =>
  as.client.rpc("assign_shuttle_guests", {
    p_wedding: f.w,
    p_run: run,
    p_guests: idx.map((i) => f.guests[i]!),
  });
const ridersOf = async (run: string) =>
  (
    await q<{ guest_id: string }>(
      "select guest_id from public.shuttle_assignments where run_id = $1 order by guest_id",
      [run],
    )
  ).map((r) => r.guest_id);
const rideCount = async (f: Fixture) =>
  Number(
    (
      await q<{ n: string }>(
        "select count(*) n from public.shuttle_assignments where wedding_id = $1",
        [f.w],
      )
    )[0]!.n,
  );
const runVersion = async (run: string) =>
  (await q<{ version: number }>("select version from public.shuttle_runs where id = $1", [run]))[0]!
    .version;

async function addMember(
  w: string,
  role: "partner" | "editor" | "viewer",
  permissions: object = {},
) {
  const user = await createUser(`shuttle-${role}`);
  await q(
    "insert into public.memberships (wedding_id, user_id, role, permissions) values ($1,$2,$3,$4)",
    [w, user.id, role, JSON.stringify(permissions)],
  );
  return user;
}

describe("runs", () => {
  it("adds, updates and removes a run; removal returns its riders", async () => {
    const f = await setup(2);
    await acceptAll(f);
    const run = await mkRun(f, { label: "  Hotel   shuttle ", capacity: 3 });
    const row = (
      await q<{ label: string; dropoff: string | null }>(
        "select label, dropoff from public.shuttle_runs where id = $1",
        [run],
      )
    )[0]!;
    expect(row).toEqual({ label: "Hotel shuttle", dropoff: null });
    await ok(assign(f, run, [0, 1]));
    const v = await runVersion(run);
    const next = await ok(
      owner.client.rpc("update_shuttle_run", {
        p_wedding: f.w,
        p_run: run,
        p_expected_version: v,
        p_label: "Hotel shuttle",
        p_pickup: "Side door",
        p_dropoff: "Chapel",
        p_departs_at: DEPARTS,
        p_capacity: 2,
        p_notes: null,
      }),
    );
    expect(next).toBe(v + 1);
    expect(
      await code(
        owner.client.rpc("remove_shuttle_run", {
          p_wedding: f.w,
          p_run: run,
          p_expected_version: v,
        }),
      ),
    ).toBe("55000");
    expect(
      await ok(
        owner.client.rpc("remove_shuttle_run", {
          p_wedding: f.w,
          p_run: run,
          p_expected_version: v + 1,
        }),
      ),
    ).toBe(2);
    expect(await rideCount(f)).toBe(0);
  });

  it("refuses bad input, a duplicate name and an event from another wedding", async () => {
    const f = await setup(1);
    expect(await code(addRun(f, { capacity: 0 }))).toBe("22023");
    expect(await code(addRun(f, { capacity: 101 }))).toBe("22023");
    expect(await code(addRun(f, { direction: "sideways" }))).toBe("22023");
    await mkRun(f, { label: "Bus A" });
    expect(await code(addRun(f, { label: "bus a" }))).toBe("23505");
    const other = await setup(1);
    const r = await owner.client.rpc("add_shuttle_run", {
      p_wedding: f.w,
      p_event: other.event,
      p_direction: "to_event",
      p_label: "Cross",
      p_pickup: "x",
      p_dropoff: null,
      p_departs_at: DEPARTS,
      p_capacity: 2,
    });
    expect(r.error?.code).toBe("42501");
  });

  it("will not shrink a run below its riders", async () => {
    const f = await setup(2);
    await acceptAll(f);
    const run = await mkRun(f, { capacity: 2 });
    await ok(assign(f, run, [0, 1]));
    const r = await owner.client.rpc("update_shuttle_run", {
      p_wedding: f.w,
      p_run: run,
      p_expected_version: await runVersion(run),
      p_label: "Smaller",
      p_pickup: "Hotel",
      p_dropoff: null,
      p_departs_at: DEPARTS,
      p_capacity: 1,
    });
    expect(r.error?.code).toBe("SH409");
  });

  it("caps runs per event", async () => {
    const f = await setup(1);
    await q(
      `insert into public.shuttle_runs (wedding_id, event_id, direction, label, pickup, departs_at, capacity)
       select $1, $2, 'to_event', 'Run ' || i, 'Hotel', now(), 1 from generate_series(1, 30) i`,
      [f.w, f.event],
    );
    expect(await code(addRun(f))).toBe("54000");
  });
});

describe("assigning", () => {
  it("places only attending guests", async () => {
    const f = await setup(3);
    await ok(respond(f, 0, "accepted"));
    await ok(respond(f, 1, "declined"));
    const run = await mkRun(f, { capacity: 5 });
    expect(await code(assign(f, run, [1]))).toBe("SH422");
    expect(await code(assign(f, run, [2]))).toBe("SH422"); // still waiting
    // All or nothing: one ineligible guest stops the whole request.
    expect(await code(assign(f, run, [0, 2]))).toBe("SH422");
    expect(await rideCount(f)).toBe(0);
    expect(await ok(assign(f, run, [0]))).toBe(1);
    // A guest from another wedding is never eligible here.
    const other = await setup(1);
    await acceptAll(other);
    const r = await owner.client.rpc("assign_shuttle_guests", {
      p_wedding: f.w,
      p_run: run,
      p_guests: [other.guests[0]!],
    });
    expect(r.error?.code).toBe("SH422");
  });

  it("enforces seats, is idempotent and moves a guest within one direction", async () => {
    const f = await setup(3);
    await acceptAll(f);
    const a = await mkRun(f, { capacity: 2 });
    const b = await mkRun(f, { capacity: 2 });
    const home = await mkRun(f, { direction: "from_event", capacity: 5 });
    expect(await ok(assign(f, a, [0, 1]))).toBe(2);
    expect(await ok(assign(f, a, [0, 1]))).toBe(0);
    expect(await code(assign(f, a, [2]))).toBe("SH409");
    expect(await ok(assign(f, b, [1]))).toBe(1);
    expect(await ridersOf(a)).toEqual([f.guests[0]!]);
    expect(await ridersOf(b)).toEqual([f.guests[1]!]);
    // Riding there does not stop a ride back.
    expect(await ok(assign(f, home, [0, 1, 2]))).toBe(3);
    expect(await rideCount(f)).toBe(5);
    await ok(
      owner.client.rpc("unassign_shuttle_guest", {
        p_wedding: f.w,
        p_run: home,
        p_guest: f.guests[2]!,
      }),
    );
    expect((await ridersOf(home)).length).toBe(2);
  });

  it("gives the last seat to exactly one of two concurrent requests", async () => {
    const f = await setup(2);
    await acceptAll(f);
    const run = await mkRun(f, { capacity: 1 });
    const [r1, r2] = await Promise.all([assign(f, run, [0]), assign(f, run, [1])]);
    const codes = [r1.error?.code ?? "ok", r2.error?.code ?? "ok"].sort();
    expect(codes).toEqual(["SH409", "ok"]);
    expect((await ridersOf(run)).length).toBe(1);
  });

  it("refuses more than 20 guests at once and an empty request", async () => {
    const f = await setup(1);
    const run = await mkRun(f);
    const many = Array.from({ length: 21 }, () => randomUUID());
    expect(
      await code(
        owner.client.rpc("assign_shuttle_guests", { p_wedding: f.w, p_run: run, p_guests: many }),
      ),
    ).toBe("54000");
    expect(
      await code(
        owner.client.rpc("assign_shuttle_guests", { p_wedding: f.w, p_run: run, p_guests: [] }),
      ),
    ).toBe("22023");
  });
});

describe("releases follow replies in the same transaction", () => {
  it("a decline, a return to waiting, an archive and a revocation each remove rides", async () => {
    const f = await setup(4);
    await acceptAll(f);
    const there = await mkRun(f, { capacity: 4 });
    const back = await mkRun(f, { direction: "from_event", capacity: 4 });
    await ok(assign(f, there, [0, 1, 2, 3]));
    await ok(assign(f, back, [0, 1, 2, 3]));

    await ok(respond(f, 0, "declined"));
    expect(await ridersOf(there)).not.toContain(f.guests[0]);
    expect(await ridersOf(back)).not.toContain(f.guests[0]);

    await ok(respond(f, 1, "pending"));
    expect(await ridersOf(there)).not.toContain(f.guests[1]);

    const gv = (
      await q<{ version: number }>("select version from public.guests where id = $1", [
        f.guests[2]!,
      ])
    )[0]!.version;
    await ok(
      owner.client.rpc("set_guest_archived", {
        p_wedding: f.w,
        p_guest_id: f.guests[2]!,
        p_expected_version: gv,
        p_archived: true,
      }),
    );
    expect(await ridersOf(there)).toEqual([f.guests[3]!]);

    const iv = (
      await q<{ version: number }>("select version from public.invitations where id = $1", [
        f.invitation.id,
      ])
    )[0]!.version;
    await ok(
      owner.client.rpc("revoke_invitation", {
        p_wedding: f.w,
        p_invitation_id: f.invitation.id,
        p_expected_version: iv,
      }),
    );
    expect(await rideCount(f)).toBe(0);

    const audit = await q<{ safe_changes: Record<string, unknown> }>(
      "select safe_changes from public.audit_events where wedding_id = $1 and action = 'shuttle.guest_released'",
      [f.w],
    );
    expect(audit.length).toBeGreaterThanOrEqual(4);
    for (const a of audit) expect(Object.keys(a.safe_changes)).toEqual(["rides"]);
  });

  it("a guest's own decline through the public link removes their rides", async () => {
    const f = await setup(2);
    await acceptAll(f);
    const run = await mkRun(f, { capacity: 2 });
    await ok(assign(f, run, [0, 1]));
    const client = `c-${randomUUID().slice(0, 12)}`;
    const view = (
      await adminClient().rpc("rsvp_view", {
        p_token_hash: sha(f.invitation.raw),
        p_client: client,
      })
    ).data as { version: number; members: { id: string; name: string }[] };
    await ok(
      adminClient().rpc("rsvp_submit", {
        p_token_hash: sha(f.invitation.raw),
        p_client: client,
        p_expected_version: view.version,
        p_responses: view.members
          .filter((m) => m.name === "Rider 0 Example")
          .map((m) => ({ memberId: m.id, status: "declined", mealOptionId: null })),
      }),
    );
    expect(await ridersOf(run)).toEqual([f.guests[1]!]);
  });

  it("a meal change for an attending guest keeps the ride", async () => {
    const f = await setup(1);
    await acceptAll(f);
    const run = await mkRun(f);
    await ok(assign(f, run, [0]));
    await ok(respond(f, 0, "accepted"));
    expect(await ridersOf(run)).toEqual([f.guests[0]!]);
  });

  it("deleting the event removes its runs and rides", async () => {
    const f = await setup(1);
    await acceptAll(f);
    const run = await mkRun(f);
    await ok(assign(f, run, [0]));
    await q("delete from public.events where id = $1", [f.event]);
    expect(await rideCount(f)).toBe(0);
  });
});

describe("authorization", () => {
  it("lets a partner and a planner with the guests grant manage shuttles, and nobody else", async () => {
    const f = await setup(1);
    await acceptAll(f);
    const partner = await addMember(f.w, "partner");
    const planner = await addMember(f.w, "editor", { guests: true });
    const plain = await addMember(f.w, "editor", {});
    const viewer = await addMember(f.w, "viewer");
    expect(await code(addRun(f, {}, partner))).toBeNull();
    const run = (await ok(addRun(f, {}, planner))) as string;
    for (const u of [plain, viewer, stranger]) {
      expect(await code(addRun(f, {}, u))).toBe("42501");
      expect(await code(assign(f, run, [0], u))).toBe("42501");
      expect(
        await code(
          u.client.rpc("remove_shuttle_run", { p_wedding: f.w, p_run: run, p_expected_version: 1 }),
        ),
      ).toBe("42501");
    }
    await ok(assign(f, run, [0], planner));
    // Reads: managers see runs and riders; others see nothing.
    for (const u of [plain, viewer, stranger]) {
      expect((await u.client.from("shuttle_runs").select("id").eq("wedding_id", f.w)).data).toEqual(
        [],
      );
      expect(
        (await u.client.from("shuttle_assignments").select("id").eq("wedding_id", f.w)).data,
      ).toEqual([]);
    }
    expect(
      (await partner.client.from("shuttle_assignments").select("id").eq("wedding_id", f.w)).data
        ?.length,
    ).toBe(1);
  });

  it("allows no direct writes, even for the owner", async () => {
    const f = await setup(1);
    const ins = await owner.client.from("shuttle_runs").insert({
      wedding_id: f.w,
      event_id: f.event,
      direction: "to_event",
      label: "x",
      pickup: "x",
      departs_at: DEPARTS,
      capacity: 1,
    });
    expect(ins.error).not.toBeNull();
  });
});
