import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("demand-owner");
  stranger = await createUser("demand-stranger");
});

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

type Demand = {
  event_id: string;
  planning_basis: string;
  plan_open_plus_ones: boolean;
  invited: number;
  yes: number;
  waiting_open: number;
  waiting_closed: number;
  no: number;
  open_plus_ones: number;
  seated_confirmed: number;
  seated_tentative: number;
  yes_without_meal: number;
  meals: { id: string; name: string; active: boolean; count: number }[];
};
const allDemand = async (u: TestUser, w: string) =>
  (await ok(u.client.rpc("event_demand", { p_wedding: w }))) as Demand[];
const demandOf = async (u: TestUser, w: string, event: string) =>
  (await allDemand(u, w)).find((r) => r.event_id === event);

type Fixture = {
  w: string;
  event: string;
  guests: string[];
  members: string[];
  meals: string[];
  invitation: { id: string; raw: string; version: number };
};

/** One event, two meals, n invited guests who have not answered, one invitation with `quota` plus-ones. */
async function setup(n = 4, quota = 0): Promise<Fixture> {
  const w = await createWedding(owner);
  const event = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception" },
    }),
  )) as string;
  const meals = [] as string[];
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
      p_plus_one_quota: quota,
      p_expires_at: future(30),
      p_token_hashes: [sha(raw)],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  const invitationId = created[0]!.o_invitation_id;
  const rows = await withSuperuser(
    async (db) =>
      (
        await db.query(
          "select id, guest_id from public.invitation_members where invitation_id = $1",
          [invitationId],
        )
      ).rows,
  );
  const version = await withSuperuser(
    async (db) =>
      (await db.query("select version from public.invitations where id = $1", [invitationId]))
        .rows[0].version as number,
  );
  return {
    w,
    event,
    guests,
    members: guests.map((g) => rows.find((r) => r.guest_id === g)!.id as string),
    meals,
    invitation: { id: invitationId, raw, version },
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

async function join(f: Fixture, user: TestUser, role: "partner" | "editor" | "viewer") {
  const raw = randomBytes(32).toString("base64url");
  await ok(
    owner.client.rpc("create_collaborator_invite", {
      p_wedding: f.w,
      p_email: user.email,
      p_role: role,
      p_token_hash: sha(raw),
    }),
  );
  await ok(user.client.rpc("redeem_collaborator_invite", { p_token_hash: sha(raw) }));
}

describe("event_demand counts", () => {
  it("starts with everyone waiting and no meals counted", async () => {
    const f = await setup(4, 2);
    const d = (await demandOf(owner, f.w, f.event))!;
    expect(d).toMatchObject({
      invited: 4,
      yes: 0,
      waiting_open: 4,
      waiting_closed: 0,
      no: 0,
      open_plus_ones: 2,
      seated_confirmed: 0,
      yes_without_meal: 0,
      planning_basis: "auto",
      plan_open_plus_ones: false,
    });
    expect(d.meals.map((m) => [m.name, m.count])).toEqual([
      ["Chicken", 0],
      ["Veg", 0],
    ]);
  });

  it("follows accept, decline and revert, with meals counted for attending guests only", async () => {
    const f = await setup();
    await respond(f, 0, "accepted", f.meals[0]);
    await respond(f, 1, "accepted");
    await respond(f, 2, "declined");
    let d = (await demandOf(owner, f.w, f.event))!;
    expect(d).toMatchObject({ invited: 4, yes: 2, waiting_open: 1, no: 1, yes_without_meal: 1 });
    expect(d.meals.find((m) => m.name === "Chicken")!.count).toBe(1);

    // A guest who changes their mind from yes to no leaves the meal totals.
    await respond(f, 0, "declined");
    d = (await demandOf(owner, f.w, f.event))!;
    expect(d).toMatchObject({ yes: 1, no: 2 });
    expect(d.meals.find((m) => m.name === "Chicken")!.count).toBe(0);
  });

  it("counts a plus-one once and uses up one place", async () => {
    const f = await setup(2, 1);
    await ok(
      adminClient().rpc("rsvp_submit", {
        p_token_hash: sha(f.invitation.raw),
        p_client: `c-${randomUUID().slice(0, 12)}`,
        p_expected_version: f.invitation.version,
        p_responses: [],
        p_plus_one: { name: "Taylor Example" },
      }),
    );
    const d = (await demandOf(owner, f.w, f.event))!;
    expect(d).toMatchObject({ invited: 3, yes: 1, waiting_open: 2, open_plus_ones: 0 });
  });

  it("leaves out archived guests, as seating does", async () => {
    const f = await setup(3);
    await respond(f, 0, "accepted");
    const version = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.guests where id = $1", [f.guests[0]!])).rows[0]
          .version as number,
    );
    await ok(
      owner.client.rpc("set_guest_archived", {
        p_wedding: f.w,
        p_guest_id: f.guests[0]!,
        p_expected_version: version,
        p_archived: true,
      }),
    );
    const d = (await demandOf(owner, f.w, f.event))!;
    expect(d).toMatchObject({ invited: 2, yes: 0 });
  });

  it("moves waiting guests to closed after the reply date and stops counting their plus-ones", async () => {
    const f = await setup(2, 2);
    await withSuperuser((db) =>
      db.query("update public.invitations set deadline = now() - interval '1 day' where id = $1", [
        f.invitation.id,
      ]),
    );
    const d = (await demandOf(owner, f.w, f.event))!;
    expect(d).toMatchObject({ waiting_open: 0, waiting_closed: 2, open_plus_ones: 0 });
  });

  it("drops a revoked invitation entirely", async () => {
    const f = await setup(2, 1);
    await respond(f, 0, "accepted");
    const current = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.invitations where id = $1", [f.invitation.id]))
          .rows[0].version as number,
    );
    await ok(
      owner.client.rpc("revoke_invitation", {
        p_wedding: f.w,
        p_invitation_id: f.invitation.id,
        p_expected_version: current,
      }),
    );
    const d = (await demandOf(owner, f.w, f.event))!;
    expect(d).toMatchObject({ invited: 0, yes: 0, waiting_open: 0, open_plus_ones: 0 });
  });

  it("equals the seating totals: confirmed seats never exceed attending", async () => {
    const f = await setup(3);
    const layout = (await ok(
      owner.client.rpc("ensure_seating_layout", { p_wedding: f.w, p_event_id: f.event }),
    )) as string;
    const table = (await ok(
      owner.client.rpc("add_seating_table", {
        p_wedding: f.w,
        p_layout: layout,
        p_label: "T1",
        p_capacity: 4,
      }),
    )) as string;
    await respond(f, 0, "accepted");
    await respond(f, 1, "accepted");
    await ok(
      owner.client.rpc("assign_guest_seat", {
        p_wedding: f.w,
        p_layout: layout,
        p_guest: f.guests[0]!,
        p_table: table,
      }),
    );
    const d = (await demandOf(owner, f.w, f.event))!;
    const seats = await withSuperuser(async (db) =>
      Number(
        (
          await db.query(
            "select count(*) n from public.seat_assignments where layout_id = $1 and not tentative",
            [layout],
          )
        ).rows[0].n,
      ),
    );
    expect(d.seated_confirmed).toBe(seats);
    expect(d.yes - d.seated_confirmed).toBe(1);

    // A seated guest who declines leaves both the seat and the attending count.
    await respond(f, 0, "declined");
    const after = (await demandOf(owner, f.w, f.event))!;
    expect(after).toMatchObject({ yes: 1, seated_confirmed: 0 });
  });

  it("stays consistent when a reply and a read happen together", async () => {
    const f = await setup(4);
    const reads = await Promise.all([
      respond(f, 0, "accepted"),
      demandOf(owner, f.w, f.event),
      respond(f, 1, "declined"),
      demandOf(owner, f.w, f.event),
    ]);
    for (const r of reads) {
      if (!r) continue;
      const d = r as Demand;
      expect(d.yes + d.waiting_open + d.waiting_closed + d.no).toBe(d.invited);
    }
    const final = (await demandOf(owner, f.w, f.event))!;
    expect(final).toMatchObject({ yes: 1, no: 1, waiting_open: 2 });
  });
});

describe("who can read guest totals (D2)", () => {
  it("refuses strangers and other weddings' members", async () => {
    const f = await setup(2);
    const other = await setup(1);
    expect((await stranger.client.rpc("event_demand", { p_wedding: f.w })).error?.code).toBe(
      "42501",
    );
    // Owner of one wedding cannot read another's counts.
    const mine = await createWedding(stranger);
    expect((await stranger.client.rpc("event_demand", { p_wedding: other.w })).error?.code).toBe(
      "42501",
    );
    expect(await allDemand(stranger, mine)).toEqual([]);
  });

  it("gives partners totals, and editors and viewers nothing until the owner shares them", async () => {
    const f = await setup(2);
    const partner = await createUser("demand-partner");
    const editor = await createUser("demand-editor");
    const viewer = await createUser("demand-viewer");
    await join(f, partner, "partner");
    await join(f, editor, "editor");
    await join(f, viewer, "viewer");
    expect((await demandOf(partner, f.w, f.event))?.invited).toBe(2);
    expect(await allDemand(editor, f.w)).toEqual([]);
    expect(await allDemand(viewer, f.w)).toEqual([]);

    await ok(owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
    for (const u of [editor, viewer]) {
      const d = (await demandOf(u, f.w, f.event))!;
      expect(d.invited).toBe(2);
      // Totals only: the payload has no names or ids beyond the event and meal options.
      expect(Object.keys(d).sort()).toEqual([
        "event_id",
        "invited",
        "meals",
        "no",
        "open_plus_ones",
        "plan_open_plus_ones",
        "planning_basis",
        "seated_confirmed",
        "seated_tentative",
        "waiting_closed",
        "waiting_open",
        "yes",
        "yes_without_meal",
      ]);
      // Guest rows themselves stay owner and partner only.
      const rows = await u.client.from("invitation_members").select("id");
      expect(rows.data ?? []).toEqual([]);
      const guests = await u.client.from("guests").select("id");
      expect(guests.data ?? []).toEqual([]);
    }

    await ok(owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: false }));
    expect(await allDemand(viewer, f.w)).toEqual([]);
  });

  it("lets only an owner change the setting, and audits a real change once", async () => {
    const f = await setup(1);
    const partner = await createUser("demand-partner2");
    const editor = await createUser("demand-editor2");
    await join(f, partner, "partner");
    await join(f, editor, "editor");
    for (const u of [partner, editor, stranger]) {
      const r = await u.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true });
      expect(r.error?.code).toBe("42501");
    }
    await ok(owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
    await ok(owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
    const n = await withSuperuser(async (db) =>
      Number(
        (
          await db.query(
            "select count(*) n from public.audit_events where wedding_id = $1 and action = 'wedding.guest_totals_sharing_changed'",
            [f.w],
          )
        ).rows[0].n,
      ),
    );
    expect(n).toBe(1);
  });
});

describe("planning settings on events", () => {
  it("stores the planning basis and plus-one opt-in, and rejects unknown bases", async () => {
    const f = await setup(1);
    const bad = await owner.client.rpc("update_event", {
      p_wedding: f.w,
      p_event_id: f.event,
      p_expected_version: 1,
      p_event: { name: "Reception", kind: "reception", planningBasis: "everyone" },
    });
    expect(bad.error?.code).toBe("22023");

    await ok(
      owner.client.rpc("update_event", {
        p_wedding: f.w,
        p_event_id: f.event,
        p_expected_version: 1,
        p_event: {
          name: "Reception",
          kind: "reception",
          planningBasis: "yes",
          planOpenPlusOnes: true,
        },
      }),
    );
    const d = (await demandOf(owner, f.w, f.event))!;
    expect(d).toMatchObject({ planning_basis: "yes", plan_open_plus_ones: true });
  });

  it("keeps stored planning settings when an update omits them, and ignores a no-op save", async () => {
    const f = await setup(1);
    await ok(
      owner.client.rpc("update_event", {
        p_wedding: f.w,
        p_event_id: f.event,
        p_expected_version: 1,
        p_event: { name: "Reception", kind: "reception", planningBasis: "yes_waiting" },
      }),
    );
    await ok(
      owner.client.rpc("update_event", {
        p_wedding: f.w,
        p_event_id: f.event,
        p_expected_version: 2,
        p_event: { name: "Reception renamed", kind: "reception" },
      }),
    );
    expect((await demandOf(owner, f.w, f.event))!.planning_basis).toBe("yes_waiting");
    // Same content again: version stays put.
    await ok(
      owner.client.rpc("update_event", {
        p_wedding: f.w,
        p_event_id: f.event,
        p_expected_version: 3,
        p_event: { name: "Reception renamed", kind: "reception" },
      }),
    );
    const v = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.events where id = $1", [f.event])).rows[0]
          .version as number,
    );
    expect(v).toBe(3);
  });

  it("refuses a cross-wedding update", async () => {
    const f = await setup(1);
    const mine = await createWedding(stranger);
    const r = await stranger.client.rpc("update_event", {
      p_wedding: mine,
      p_event_id: f.event,
      p_expected_version: 1,
      p_event: { name: "Hijack", kind: "reception" },
    });
    expect(r.error?.code).toBe("42501");
  });
});
