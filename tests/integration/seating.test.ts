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

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("seat-owner");
  stranger = await createUser("seat-stranger");
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

type Fixture = {
  w: string;
  event: string;
  layout: string;
  guests: string[];
  members: string[];
  meals: string[];
  invitation: { id: string; raw: string };
};

/** A wedding with one event, two meals, n invited guests (all waiting) and an empty layout. */
async function setup(n = 4): Promise<Fixture> {
  const w = await createWedding(owner);
  const event = await ok(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception" },
    }),
  );
  const meals = [
    await ok(
      owner.client.rpc("add_meal_option", {
        p_wedding: w,
        p_event_id: event as string,
        p_name: "Chicken",
      }),
    ),
    await ok(
      owner.client.rpc("add_meal_option", {
        p_wedding: w,
        p_event_id: event as string,
        p_name: "Veg",
      }),
    ),
  ] as string[];
  const guests: string[] = [];
  for (let i = 0; i < n; i++) {
    guests.push(
      (await ok(
        owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name: `Guest ${i} Example` } }),
      )) as string,
    );
  }
  const raw = randomBytes(32).toString("base64url");
  const created = await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: event as string,
      p_groups: [{ guestIds: guests, householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: future(30),
      p_token_hashes: [sha(raw)],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  const invitationId = (created as { o_invitation_id: string }[])[0]!.o_invitation_id;
  const layout = (await ok(
    owner.client.rpc("ensure_seating_layout", { p_wedding: w, p_event_id: event as string }),
  )) as string;
  const rows = await withSuperuser(
    async (db) =>
      (
        await db.query(
          "select id, guest_id from public.invitation_members where invitation_id = $1",
          [invitationId],
        )
      ).rows,
  );
  const members = guests.map((g) => rows.find((r) => r.guest_id === g)!.id as string);
  return {
    w,
    event: event as string,
    layout,
    guests,
    members,
    meals,
    invitation: { id: invitationId, raw },
  };
}

const respond = (
  f: Fixture,
  i: number,
  status: "accepted" | "declined" | "pending",
  meal?: string,
) =>
  owner.client.rpc("override_rsvp_response", {
    p_wedding: f.w,
    p_member_id: f.members[i]!,
    p_status: status,
    p_reason: "test",
    ...(meal && { p_meal_option_id: meal }),
  });
const accept = async (f: Fixture, i: number, meal?: string) => {
  await ok(respond(f, i, "accepted", meal));
};
const addTable = async (f: Fixture, label: string, capacity: number) =>
  (await ok(
    owner.client.rpc("add_seating_table", {
      p_wedding: f.w,
      p_layout: f.layout,
      p_label: label,
      p_capacity: capacity,
    }),
  )) as string;
const assign = (f: Fixture, i: number, table: string, seat?: number) =>
  owner.client.rpc("assign_guest_seat", {
    p_wedding: f.w,
    p_layout: f.layout,
    p_guest: f.guests[i]!,
    p_table: table,
    ...(seat !== undefined && { p_seat: seat }),
  });
const layoutRow = async (f: Fixture) =>
  (await withSuperuser(
    async (db) =>
      (await db.query("select * from public.seating_layouts where id = $1", [f.layout])).rows[0],
  ))!;
const seatCount = async (f: Fixture, table?: string) =>
  withSuperuser(async (db) =>
    Number(
      (
        await db.query(
          "select count(*) n from public.seat_assignments where layout_id = $1 and ($2::uuid is null or table_id = $2)",
          [f.layout, table ?? null],
        )
      ).rows[0].n,
    ),
  );

describe("layouts", () => {
  it("creates one layout per event and replays safely", async () => {
    const f = await setup(1);
    const again = await ok(
      owner.client.rpc("ensure_seating_layout", { p_wedding: f.w, p_event_id: f.event }),
    );
    expect(again).toBe(f.layout);
    expect(
      await withSuperuser(async (db) =>
        Number(
          (
            await db.query("select count(*) n from public.seating_layouts where event_id = $1", [
              f.event,
            ])
          ).rows[0].n,
        ),
      ),
    ).toBe(1);
  });

  it("denies outsiders, anonymous callers and cross-tenant ids", async () => {
    const f = await setup(1);
    const other = await setup(1);
    const t = await addTable(f, "T1", 4);
    expect(
      (await stranger.client.rpc("ensure_seating_layout", { p_wedding: f.w, p_event_id: f.event }))
        .error?.code,
    ).toBe("42501");
    expect(
      (await anonClient().rpc("ensure_seating_layout", { p_wedding: f.w, p_event_id: f.event }))
        .error,
    ).not.toBeNull();
    expect(
      (
        await stranger.client.rpc("add_seating_table", {
          p_wedding: f.w,
          p_layout: f.layout,
          p_label: "X",
          p_capacity: 2,
        })
      ).error?.code,
    ).toBe("42501");
    // Owner of another wedding cannot reach this layout, even by passing their own wedding id.
    expect(
      (
        await owner.client.rpc("add_seating_table", {
          p_wedding: other.w,
          p_layout: f.layout,
          p_label: "X",
          p_capacity: 2,
        })
      ).error?.code,
    ).toBe("42501");
    expect(
      (
        await owner.client.rpc("assign_guest_seat", {
          p_wedding: other.w,
          p_layout: other.layout,
          p_guest: f.guests[0]!,
          p_table: t,
        })
      ).error?.code,
    ).toBe("42501");
  });

  it("limits reads to managers and refuses direct writes", async () => {
    const f = await setup(1);
    await addTable(f, "T1", 2);
    expect(
      (await stranger.client.from("seating_layouts").select("id").eq("id", f.layout)).data,
    ).toEqual([]);
    expect((await stranger.client.from("seating_tables").select("id")).data).toEqual([]);
    expect(
      (await owner.client.from("seating_layouts").select("id").eq("id", f.layout)).data,
    ).toHaveLength(1);
    expect(
      (
        await owner.client.from("seat_assignments").insert({
          wedding_id: f.w,
          layout_id: f.layout,
          table_id: randomUUID(),
          guest_id: f.guests[0]!,
        })
      ).error,
    ).not.toBeNull();
    expect(
      (await owner.client.from("seating_tables").update({ capacity: 50 }).eq("layout_id", f.layout))
        .data ?? [],
    ).toEqual([]);
  });
});

describe("tables", () => {
  it("validates labels and capacity and rejects duplicates", async () => {
    const f = await setup(1);
    await addTable(f, "Head table", 8);
    for (const [label, cap] of [
      ["", 4],
      ["   ", 4],
      ["A", 0],
      ["A", 51],
      ["x".repeat(61), 4],
    ] as const) {
      const r = await owner.client.rpc("add_seating_table", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_label: label,
        p_capacity: cap,
      });
      expect(r.error?.code, `${label}/${cap}`).toBe("22023");
    }
    const dup = await owner.client.rpc("add_seating_table", {
      p_wedding: f.w,
      p_layout: f.layout,
      p_label: "head TABLE",
      p_capacity: 4,
    });
    expect(dup.error?.code).toBe("23505");
  });

  it("will not shrink a table below its seated guests, and removing one returns guests to the queue", async () => {
    const f = await setup(3);
    const t = await addTable(f, "T1", 3);
    for (const i of [0, 1, 2]) {
      await accept(f, i);
      await ok(assign(f, i, t));
    }
    const version = (await withSuperuser(
      async (db) =>
        (await db.query("select version from public.seating_tables where id = $1", [t])).rows[0]
          .version,
    )) as number;
    const small = await owner.client.rpc("update_seating_table", {
      p_wedding: f.w,
      p_table: t,
      p_expected_version: version,
      p_label: "T1",
      p_capacity: 2,
    });
    expect(small.error?.code).toBe("SE409");
    const stale = await owner.client.rpc("update_seating_table", {
      p_wedding: f.w,
      p_table: t,
      p_expected_version: version + 5,
      p_label: "T1",
      p_capacity: 5,
    });
    expect(stale.error?.code).toBe("55000");
    await ok(
      owner.client.rpc("update_seating_table", {
        p_wedding: f.w,
        p_table: t,
        p_expected_version: version,
        p_label: "Table One",
        p_capacity: 5,
      }),
    );
    const unseated = await ok(
      owner.client.rpc("remove_seating_table", {
        p_wedding: f.w,
        p_table: t,
        p_expected_version: version + 1,
      }),
    );
    expect(unseated).toBe(3);
    expect(await seatCount(f)).toBe(0);
  });
});

describe("assignment rules", () => {
  it("seats accepted guests, moves them, and keeps one assignment per guest", async () => {
    const f = await setup(2);
    const a = await addTable(f, "A", 2);
    const b = await addTable(f, "B", 2);
    await accept(f, 0);
    await ok(assign(f, 0, a));
    await ok(assign(f, 0, a)); // idempotent retry
    expect(await seatCount(f)).toBe(1);
    await ok(assign(f, 0, b)); // move
    expect(await seatCount(f)).toBe(1);
    expect(await seatCount(f, b)).toBe(1);
    await ok(
      owner.client.rpc("unassign_guest_seat", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_guest: f.guests[0]!,
      }),
    );
    await ok(
      owner.client.rpc("unassign_guest_seat", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_guest: f.guests[0]!,
      }),
    );
    expect(await seatCount(f)).toBe(0);
  });

  it("refuses waiting, declined, uninvited and archived guests", async () => {
    const f = await setup(3);
    const t = await addTable(f, "A", 4);
    expect((await assign(f, 0, t)).error?.code).toBe("SE422"); // waiting, tentative off
    await ok(respond(f, 1, "declined"));
    expect((await assign(f, 1, t)).error?.code).toBe("SE422");
    const loner = await ok(
      owner.client.rpc("create_guest", { p_wedding: f.w, p_guest: { name: "Uninvited Example" } }),
    );
    const r = await owner.client.rpc("assign_guest_seat", {
      p_wedding: f.w,
      p_layout: f.layout,
      p_guest: loner as string,
      p_table: t,
    });
    expect(r.error?.code).toBe("SE422");
    await accept(f, 2);
    const v = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.guests where id = $1", [f.guests[2]!])).rows[0]
          .version,
    );
    await ok(
      owner.client.rpc("set_guest_archived", {
        p_wedding: f.w,
        p_guest_id: f.guests[2]!,
        p_expected_version: v,
        p_archived: true,
      }),
    );
    expect((await assign(f, 2, t)).error?.code).toBe("SE422");
    expect(await seatCount(f)).toBe(0);
  });

  it("seats waiting guests as tentative only when allowed, and keeps the two apart", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 4);
    const ver = async () => (await layoutRow(f)).version as number;
    await ok(
      owner.client.rpc("set_seating_tentative", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_version: await ver(),
        p_allow: true,
      }),
    );
    await ok(assign(f, 0, t));
    await accept(f, 1);
    await ok(assign(f, 1, t));
    const rows = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select guest_id, tentative from public.seat_assignments where layout_id = $1",
            [f.layout],
          )
        ).rows,
    );
    expect(rows.find((r) => r.guest_id === f.guests[0])!.tentative).toBe(true);
    expect(rows.find((r) => r.guest_id === f.guests[1])!.tentative).toBe(false);
    // Cannot turn it off while a tentative guest is seated.
    const off = await owner.client.rpc("set_seating_tentative", {
      p_wedding: f.w,
      p_layout: f.layout,
      p_expected_version: await ver(),
      p_allow: false,
    });
    expect(off.error?.code).toBe("SE422");
    // Accepting confirms the tentative seat without moving them.
    await accept(f, 0);
    const after = await withSuperuser(
      async (db) =>
        (
          await db.query("select tentative from public.seat_assignments where guest_id = $1", [
            f.guests[0]!,
          ])
        ).rows[0],
    );
    expect(after.tentative).toBe(false);
  });

  it("enforces numbered seats: unique per table and inside capacity", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 3);
    await accept(f, 0);
    await accept(f, 1);
    await ok(assign(f, 0, t, 2));
    expect((await assign(f, 1, t, 2)).error?.code).toBe("23505");
    expect((await assign(f, 1, t, 4)).error?.code).toBe("22023");
    expect((await assign(f, 1, t, 0)).error?.code).toBe("22023");
    await ok(assign(f, 1, t, 3));
    expect(await seatCount(f, t)).toBe(2);
  });

  it("T10: two requests for the last seat leave capacity intact", async () => {
    for (let round = 0; round < 3; round++) {
      const f = await setup(3);
      const t = await addTable(f, "A", 2);
      for (const i of [0, 1, 2]) await accept(f, i);
      await ok(assign(f, 0, t));
      const [x, y] = await Promise.all([assign(f, 1, t), assign(f, 2, t)]);
      const errors = [x.error, y.error].filter(Boolean);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("SE409");
      expect(await seatCount(f, t)).toBe(2);
    }
  });

  it("T10: many concurrent requests never exceed capacity", async () => {
    const f = await setup(8);
    const t = await addTable(f, "A", 3);
    for (let i = 0; i < 8; i++) await accept(f, i);
    const results = await Promise.all(f.guests.map((_, i) => assign(f, i, t)));
    expect(results.filter((r) => !r.error)).toHaveLength(3);
    expect(await seatCount(f, t)).toBe(3);
  });

  it("a guest declining while being seated cannot end up seated", async () => {
    for (let round = 0; round < 3; round++) {
      const f = await setup(1);
      const t = await addTable(f, "A", 2);
      await accept(f, 0);
      await Promise.all([assign(f, 0, t), respond(f, 0, "declined")]);
      expect(await seatCount(f)).toBe(0);
    }
  });
});

describe("RSVP changes act on seating", () => {
  it("T11: a decline from the guest's own link unseats them and makes a finalized plan stale", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 2);
    await accept(f, 0, f.meals[0]);
    await accept(f, 1, f.meals[1]);
    await ok(assign(f, 0, t));
    await ok(assign(f, 1, t));
    const before = await layoutRow(f);
    await ok(
      owner.client.rpc("finalize_seating_layout", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_revision: before.revision,
      }),
    );
    const frozen = await layoutRow(f);
    expect(frozen.finalized_revision).toBe(frozen.revision);

    const view = await ok(
      adminClient().rpc("rsvp_view", {
        p_token_hash: sha(f.invitation.raw),
        p_client: `c-${randomUUID().slice(0, 12)}`,
      }),
    );
    const v = view as { version: number };
    await ok(
      adminClient().rpc("rsvp_submit", {
        p_token_hash: sha(f.invitation.raw),
        p_client: `c-${randomUUID().slice(0, 12)}`,
        p_expected_version: v.version,
        p_responses: [{ memberId: f.members[0], status: "declined" }],
      }),
    );
    expect(await seatCount(f)).toBe(1);
    const after = await layoutRow(f);
    expect(after.revision).toBeGreaterThan(frozen.revision);
    expect(after.finalized_revision).toBe(frozen.revision); // stale
    // The frozen snapshot still shows the guest as originally seated.
    const guestsInSnapshot = (after.snapshot as { tables: { guests: unknown[] }[] }).tables[0]!
      .guests;
    expect(guestsInSnapshot).toHaveLength(2);
  });

  it("T12: a meal change updates totals source rows once and marks the plan stale", async () => {
    const f = await setup(1);
    const t = await addTable(f, "A", 2);
    await accept(f, 0, f.meals[0]);
    await ok(assign(f, 0, t));
    const a = await layoutRow(f);
    await accept(f, 0, f.meals[1]);
    const b = await layoutRow(f);
    expect(b.revision).toBe(a.revision + 1);
    const meal = await withSuperuser(
      async (db) =>
        (
          await db.query("select meal_option_id from public.invitation_members where id = $1", [
            f.members[0]!,
          ])
        ).rows[0].meal_option_id,
    );
    expect(meal).toBe(f.meals[1]);
    expect(await seatCount(f)).toBe(1);
    // Repeating the same answer changes nothing.
    await accept(f, 0, f.meals[1]);
    expect((await layoutRow(f)).revision).toBe(b.revision);
  });

  it("an owner reset to waiting removes a confirmed seat unless tentative seating is on", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 4);
    await accept(f, 0);
    await ok(assign(f, 0, t));
    await ok(respond(f, 0, "pending"));
    expect(await seatCount(f)).toBe(0);
    await ok(
      owner.client.rpc("set_seating_tentative", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_version: (await layoutRow(f)).version,
        p_allow: true,
      }),
    );
    await accept(f, 1);
    await ok(assign(f, 1, t));
    await ok(respond(f, 1, "pending"));
    const row = await withSuperuser(
      async (db) =>
        (
          await db.query("select tentative from public.seat_assignments where guest_id = $1", [
            f.guests[1]!,
          ])
        ).rows[0],
    );
    expect(row.tentative).toBe(true);
  });

  it("revoking an invitation and archiving a guest release their seats", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 4);
    await accept(f, 0);
    await accept(f, 1);
    await ok(assign(f, 0, t));
    await ok(assign(f, 1, t));
    const gv = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.guests where id = $1", [f.guests[1]!])).rows[0]
          .version,
    );
    await ok(
      owner.client.rpc("set_guest_archived", {
        p_wedding: f.w,
        p_guest_id: f.guests[1]!,
        p_expected_version: gv,
        p_archived: true,
      }),
    );
    expect(await seatCount(f)).toBe(1);
    const iv = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.invitations where id = $1", [f.invitation.id]))
          .rows[0].version,
    );
    await ok(
      owner.client.rpc("revoke_invitation", {
        p_wedding: f.w,
        p_invitation_id: f.invitation.id,
        p_expected_version: iv,
      }),
    );
    expect(await seatCount(f)).toBe(0);
  });
});

describe("finalizing", () => {
  it("refuses a stale revision and freezes a snapshot that later edits do not rewrite", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 2);
    await accept(f, 0, f.meals[0]);
    await ok(assign(f, 0, t));
    const rev = (await layoutRow(f)).revision as number;
    const stale = await owner.client.rpc("finalize_seating_layout", {
      p_wedding: f.w,
      p_layout: f.layout,
      p_expected_revision: rev - 1,
    });
    expect(stale.error?.code).toBe("55000");
    await ok(
      owner.client.rpc("finalize_seating_layout", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_revision: rev,
      }),
    );
    const frozen = await layoutRow(f);
    expect(frozen.snapshot).toMatchObject({ accepted: 1, confirmedSeated: 1, tentativeSeated: 0 });
    await accept(f, 1);
    await ok(assign(f, 1, t));
    const later = await layoutRow(f);
    expect(later.snapshot).toEqual(frozen.snapshot);
    expect(later.revision).toBeGreaterThan(later.finalized_revision);
    expect(
      (
        await stranger.client.rpc("finalize_seating_layout", {
          p_wedding: f.w,
          p_layout: f.layout,
          p_expected_revision: later.revision,
        })
      ).error?.code,
    ).toBe("42501");
  });

  it("records audit events without guest names", async () => {
    const f = await setup(1);
    const t = await addTable(f, "A", 2);
    await accept(f, 0);
    await ok(assign(f, 0, t));
    const rows = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select action, safe_changes::text c from public.audit_events where wedding_id = $1 and action like 'seating.%'",
            [f.w],
          )
        ).rows,
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "seating.layout_created",
        "seating.table_added",
        "seating.guest_seated",
      ]),
    );
    expect(rows.every((r) => !String(r.c).includes("Example"))).toBe(true);
  });
});

const captainOf = async (table: string) =>
  withSuperuser(async (db) =>
    (
      await db.query(
        "select guest_id from public.seat_assignments where table_id = $1 and is_captain",
        [table],
      )
    ).rows.map((r) => r.guest_id as string),
  );
const setCaptain = (f: Fixture, table: string, guest?: number) =>
  owner.client.rpc("set_table_captain", {
    p_wedding: f.w,
    p_table: table,
    ...(guest !== undefined && { p_guest: f.guests[guest]! }),
  });
const seatGroup = (f: Fixture, table: string, guests: number[]) =>
  owner.client.rpc("assign_household_seats", {
    p_wedding: f.w,
    p_layout: f.layout,
    p_table: table,
    p_guests: guests.map((i) => f.guests[i]!),
  });

describe("table captains", () => {
  it("allows one captain per table, only from the seated guests, and is idempotent", async () => {
    const f = await setup(3);
    const t = await addTable(f, "A", 4);
    for (const i of [0, 1, 2]) await accept(f, i);
    await ok(assign(f, 0, t));
    await ok(assign(f, 1, t));

    expect((await setCaptain(f, t, 2)).error?.code).toBe("SE422"); // not seated here
    await ok(setCaptain(f, t, 0));
    expect(await captainOf(t)).toEqual([f.guests[0]]);
    const revision = (await layoutRow(f)).revision;
    await ok(setCaptain(f, t, 0)); // same again: no change, no revision bump
    expect((await layoutRow(f)).revision).toBe(revision);

    await ok(setCaptain(f, t, 1)); // replaces the first captain
    expect(await captainOf(t)).toEqual([f.guests[1]]);
    await ok(setCaptain(f, t)); // clears
    expect(await captainOf(t)).toEqual([]);
  });

  it("the database refuses a second captain at the same table", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 4);
    for (const i of [0, 1]) {
      await accept(f, i);
      await ok(assign(f, i, t));
    }
    await expect(
      withSuperuser((db) =>
        db.query("update public.seat_assignments set is_captain = true where table_id = $1", [t]),
      ),
    ).rejects.toThrow(/seat_assignments_captain_uq|duplicate key/);
  });

  it("clears automatically when the captain is unseated, moves, declines or the table is removed", async () => {
    const f = await setup(4);
    const a = await addTable(f, "A", 4);
    const b = await addTable(f, "B", 4);
    for (const i of [0, 1, 2, 3]) await accept(f, i);

    await ok(assign(f, 0, a));
    await ok(setCaptain(f, a, 0));
    await ok(
      owner.client.rpc("unassign_guest_seat", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_guest: f.guests[0]!,
      }),
    );
    expect(await captainOf(a)).toEqual([]);

    await ok(assign(f, 0, a));
    await ok(setCaptain(f, a, 0));
    await ok(assign(f, 0, a, 2)); // only the seat number changes: still captain
    expect(await captainOf(a)).toEqual([f.guests[0]]);
    await ok(assign(f, 0, b)); // moved to another table: not captain there
    expect(await captainOf(a)).toEqual([]);
    expect(await captainOf(b)).toEqual([]);

    await ok(assign(f, 1, b));
    await ok(setCaptain(f, b, 1));
    await ok(respond(f, 1, "declined"));
    expect(await captainOf(b)).toEqual([]);

    await ok(assign(f, 2, a));
    await ok(setCaptain(f, a, 2));
    await ok(
      owner.client.rpc("remove_seating_table", {
        p_wedding: f.w,
        p_table: a,
        p_expected_version: 1,
      }),
    );
    expect(await seatCount(f, a)).toBe(0);
  });

  it("changing a captain makes a finalized plan stale and is in the frozen copy", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 4);
    for (const i of [0, 1]) {
      await accept(f, i);
      await ok(assign(f, i, t));
    }
    await ok(setCaptain(f, t, 0));
    const before = await layoutRow(f);
    await ok(
      owner.client.rpc("finalize_seating_layout", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_revision: before.revision,
      }),
    );
    const frozen = (await layoutRow(f)).snapshot as {
      tables: { shape: string; guests: { name: string; captain: boolean }[] }[];
    };
    expect(frozen.tables[0]!.shape).toBe("round");
    expect(frozen.tables[0]!.guests.filter((g) => g.captain).map((g) => g.name)).toEqual([
      "Guest 0 Example",
    ]);
    await ok(setCaptain(f, t, 1));
    const after = await layoutRow(f);
    expect(after.revision).toBeGreaterThan(after.finalized_revision);
    expect(
      (
        after.snapshot as { tables: { guests: { name: string; captain: boolean }[] }[] }
      ).tables[0]!.guests.filter((g) => g.captain).map((g) => g.name),
    ).toEqual(["Guest 0 Example"]);
  });

  it("is limited to managers and cannot be written directly", async () => {
    const f = await setup(1);
    const t = await addTable(f, "A", 2);
    await accept(f, 0);
    await ok(assign(f, 0, t));
    expect(
      (
        await stranger.client.rpc("set_table_captain", {
          p_wedding: f.w,
          p_table: t,
          p_guest: f.guests[0]!,
        })
      ).error?.code,
    ).toBe("42501");
    expect(
      (
        await anonClient().rpc("set_table_captain", {
          p_wedding: f.w,
          p_table: t,
          p_guest: f.guests[0]!,
        })
      ).error,
    ).not.toBeNull();
    const direct = await owner.client
      .from("seat_assignments")
      .update({ is_captain: true })
      .eq("table_id", t);
    expect(direct.error).not.toBeNull();
    expect(await captainOf(t)).toEqual([]);
  });
});

describe("table shape and notes", () => {
  const rowOf = async (table: string) =>
    withSuperuser(
      async (db) =>
        (await db.query("select * from public.seating_tables where id = $1", [table])).rows[0],
    );

  it("creates with a shape, keeps it when omitted, and validates input", async () => {
    const f = await setup(1);
    const round = await addTable(f, "R", 4);
    expect((await rowOf(round)).shape).toBe("round");
    const rect = (await ok(
      owner.client.rpc("add_seating_table", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_label: "Long",
        p_capacity: 10,
        p_shape: "rectangle",
      }),
    )) as string;
    expect((await rowOf(rect)).shape).toBe("rectangle");
    expect(
      (
        await owner.client.rpc("add_seating_table", {
          p_wedding: f.w,
          p_layout: f.layout,
          p_label: "Odd",
          p_capacity: 4,
          p_shape: "hexagon",
        })
      ).error?.code,
    ).toBe("22023");

    await ok(
      owner.client.rpc("update_seating_table", {
        p_wedding: f.w,
        p_table: rect,
        p_expected_version: 1,
        p_label: "Long",
        p_capacity: 10,
        p_notes: "  Near   the door ",
      }),
    );
    const updated = await rowOf(rect);
    expect(updated).toMatchObject({ shape: "rectangle", notes: "Near the door", version: 2 });
    expect(
      (
        await owner.client.rpc("update_seating_table", {
          p_wedding: f.w,
          p_table: rect,
          p_expected_version: 2,
          p_label: "Long",
          p_capacity: 10,
          p_notes: "x".repeat(301),
        })
      ).error?.code,
    ).toBe("22023");
    await ok(
      owner.client.rpc("update_seating_table", {
        p_wedding: f.w,
        p_table: rect,
        p_expected_version: 2,
        p_label: "Long",
        p_capacity: 10,
        p_shape: "round",
        p_notes: "",
      }),
    );
    expect(await rowOf(rect)).toMatchObject({ shape: "round", notes: null, version: 3 });
    // A stale version is refused.
    expect(
      (
        await owner.client.rpc("update_seating_table", {
          p_wedding: f.w,
          p_table: rect,
          p_expected_version: 2,
          p_label: "Long",
          p_capacity: 10,
        })
      ).error?.code,
    ).toBe("55000");
  });
});

describe("seating a household together", () => {
  it("seats everyone at one table, counting only people who aren't already there", async () => {
    const f = await setup(4);
    const t = await addTable(f, "A", 3);
    for (const i of [0, 1, 2, 3]) await accept(f, i);
    await ok(assign(f, 0, t));
    const moved = (await ok(seatGroup(f, t, [0, 1, 2]))) as number;
    expect(moved).toBe(2); // guest 0 was already there
    expect(await seatCount(f, t)).toBe(3);
    expect(await ok(seatGroup(f, t, [0, 1, 2]))).toBe(0); // replay changes nothing
  });

  it("is all or nothing when the table is too small or someone is not eligible", async () => {
    const f = await setup(4);
    const t = await addTable(f, "A", 2);
    for (const i of [0, 1, 2]) await accept(f, i);
    await ok(respond(f, 3, "declined"));
    expect((await seatGroup(f, t, [0, 1, 2])).error?.code).toBe("SE409");
    expect(await seatCount(f)).toBe(0);
    expect((await seatGroup(f, t, [0, 3])).error?.code).toBe("SE422");
    expect(await seatCount(f)).toBe(0);
    // Waiting guests need tentative seating.
    await ok(respond(f, 2, "pending"));
    expect((await seatGroup(f, t, [0, 2])).error?.code).toBe("SE422");
    expect(await seatCount(f)).toBe(0);
  });

  it("holds waiting guests as tentative when allowed, and clears a moved captain", async () => {
    const f = await setup(3);
    const a = await addTable(f, "A", 3);
    const b = await addTable(f, "B", 3);
    await ok(
      owner.client.rpc("set_seating_tentative", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_version: (await layoutRow(f)).version,
        p_allow: true,
      }),
    );
    await accept(f, 0);
    await accept(f, 1);
    await ok(assign(f, 0, a));
    await ok(setCaptain(f, a, 0));
    await ok(seatGroup(f, b, [0, 1, 2]));
    expect(await captainOf(a)).toEqual([]);
    expect(await captainOf(b)).toEqual([]);
    const rows = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select guest_id, tentative from public.seat_assignments where table_id = $1",
            [b],
          )
        ).rows,
    );
    expect(rows.find((r) => r.guest_id === f.guests[2])?.tentative).toBe(true);
    expect(rows.find((r) => r.guest_id === f.guests[0])?.tentative).toBe(false);
  });

  it("validates the group and denies outsiders", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 4);
    for (const i of [0, 1]) await accept(f, i);
    expect((await seatGroup(f, t, [])).error?.code).toBe("22023");
    expect((await seatGroup(f, t, [0, 0])).error?.code).toBe("22023");
    expect(
      (
        await stranger.client.rpc("assign_household_seats", {
          p_wedding: f.w,
          p_layout: f.layout,
          p_table: t,
          p_guests: [f.guests[0]!],
        })
      ).error?.code,
    ).toBe("42501");
    expect(await seatCount(f)).toBe(0);
  });

  it("T10: two groups racing for the same table never exceed its capacity", async () => {
    for (let round = 0; round < 3; round++) {
      const f = await setup(4);
      const t = await addTable(f, "A", 3);
      for (const i of [0, 1, 2, 3]) await accept(f, i);
      const [x, y] = await Promise.all([seatGroup(f, t, [0, 1]), seatGroup(f, t, [2, 3])]);
      const errors = [x.error, y.error].filter(Boolean);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("SE409");
      expect(await seatCount(f, t)).toBe(2);
    }
  });
});

describe("floor plan", () => {
  const tableRow = async (id: string) =>
    withSuperuser(
      async (db) =>
        (await db.query("select * from public.seating_tables where id = $1", [id])).rows[0],
    );
  const elementRow = async (id: string) =>
    withSuperuser(
      async (db) =>
        (await db.query("select * from public.seating_elements where id = $1", [id])).rows[0],
    );
  const addElement = async (
    f: Fixture,
    over: Partial<{ kind: string; label: string; x: number; y: number; w: number; h: number }> = {},
  ) =>
    (await ok(
      owner.client.rpc("add_seating_element", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_kind: over.kind ?? "dance_floor",
        p_label: over.label ?? "  Dance   floor ",
        p_x: over.x ?? 10,
        p_y: over.y ?? 10,
        p_w: over.w ?? 20,
        p_h: over.h ?? 20,
      }),
    )) as string;

  it("starts unplaced, moves a table, is idempotent and can return it to unplaced", async () => {
    const f = await setup(1);
    const t = await addTable(f, "A", 8);
    expect(await tableRow(t)).toMatchObject({ pos_x: null, pos_y: null });
    await ok(
      owner.client.rpc("move_seating_table", { p_wedding: f.w, p_table: t, p_x: 40, p_y: 25 }),
    );
    expect(await tableRow(t)).toMatchObject({ pos_x: 40, pos_y: 25, version: 2 });
    await ok(
      owner.client.rpc("move_seating_table", { p_wedding: f.w, p_table: t, p_x: 40, p_y: 25 }),
    );
    await ok(
      owner.client.rpc("move_seating_table", {
        p_wedding: f.w,
        p_table: t,
        p_x: null as unknown as number,
        p_y: null as unknown as number,
      }),
    );
    expect(await tableRow(t)).toMatchObject({ pos_x: null, pos_y: null });
  });

  it("refuses positions outside the room or with only one coordinate", async () => {
    const f = await setup(1);
    const t = await addTable(f, "A", 8);
    for (const [x, y] of [
      [-1, 5],
      [121, 5],
      [5, 81],
      [5, -2],
    ] as const) {
      expect(
        (
          await owner.client.rpc("move_seating_table", {
            p_wedding: f.w,
            p_table: t,
            p_x: x,
            p_y: y,
          })
        ).error?.code,
      ).toBe("22023");
    }
    expect(
      (
        await owner.client.rpc("move_seating_table", {
          p_wedding: f.w,
          p_table: t,
          p_x: 5,
          p_y: null as unknown as number,
        })
      ).error?.code,
    ).toBe("22023");
    expect(await tableRow(t)).toMatchObject({ pos_x: null, pos_y: null });
  });

  it("moving things does not change the plan or make a finalized copy stale", async () => {
    const f = await setup(1);
    const t = await addTable(f, "A", 8);
    const revision = async () =>
      withSuperuser(
        async (db) =>
          (
            await db.query(
              "select revision, finalized_revision from public.seating_layouts where id = $1",
              [f.layout],
            )
          ).rows[0],
      );
    const before = await revision();
    await ok(
      owner.client.rpc("finalize_seating_layout", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_revision: before.revision,
      }),
    );
    const el = await addElement(f);
    await ok(
      owner.client.rpc("move_seating_table", { p_wedding: f.w, p_table: t, p_x: 60, p_y: 30 }),
    );
    await ok(
      owner.client.rpc("move_seating_element", { p_wedding: f.w, p_element: el, p_x: 30, p_y: 20 }),
    );
    const after = await revision();
    expect(after.revision).toBe(after.finalized_revision);
  });

  it("adds, edits, moves and removes room items with bounds and version checks", async () => {
    const f = await setup(1);
    const el = await addElement(f);
    expect(await elementRow(el)).toMatchObject({
      kind: "dance_floor",
      label: "Dance floor",
      x: 10,
      y: 10,
      w: 20,
      h: 20,
      version: 1,
    });
    await ok(
      owner.client.rpc("update_seating_element", {
        p_wedding: f.w,
        p_element: el,
        p_expected_version: 1,
        p_label: "Main floor",
        p_x: 100,
        p_y: 60,
        p_w: 20,
        p_h: 20,
      }),
    );
    expect(await elementRow(el)).toMatchObject({ label: "Main floor", x: 100, y: 60, version: 2 });
    // Stale version, and an edit that would leave the room, are both refused with nothing changed.
    const stale = await owner.client.rpc("update_seating_element", {
      p_wedding: f.w,
      p_element: el,
      p_expected_version: 1,
      p_label: "Old",
      p_x: 0,
      p_y: 0,
      p_w: 20,
      p_h: 20,
    });
    expect(stale.error?.code).toBe("55000");
    const outside = await owner.client.rpc("update_seating_element", {
      p_wedding: f.w,
      p_element: el,
      p_expected_version: 2,
      p_label: "Wide",
      p_x: 110,
      p_y: 0,
      p_w: 20,
      p_h: 20,
    });
    expect(outside.error?.code).toBe("22023");
    expect(await elementRow(el)).toMatchObject({ label: "Main floor", version: 2 });
    // A drag keeps the size and must keep the whole item inside.
    expect(
      (
        await owner.client.rpc("move_seating_element", {
          p_wedding: f.w,
          p_element: el,
          p_x: 101,
          p_y: 0,
        })
      ).error?.code,
    ).toBe("22023");
    await ok(
      owner.client.rpc("move_seating_element", { p_wedding: f.w, p_element: el, p_x: 5, p_y: 5 }),
    );
    expect(await elementRow(el)).toMatchObject({ x: 5, y: 5, version: 3 });
    expect(
      (
        await owner.client.rpc("remove_seating_element", {
          p_wedding: f.w,
          p_element: el,
          p_expected_version: 1,
        })
      ).error?.code,
    ).toBe("55000");
    await ok(
      owner.client.rpc("remove_seating_element", {
        p_wedding: f.w,
        p_element: el,
        p_expected_version: 3,
      }),
    );
    expect(await elementRow(el)).toBeUndefined();
  });

  it("validates kind, label, size and the 40 item limit", async () => {
    const f = await setup(1);
    const bad = async (over: Parameters<typeof addElement>[1]) =>
      (
        await owner.client.rpc("add_seating_element", {
          p_wedding: f.w,
          p_layout: f.layout,
          p_kind: over?.kind ?? "stage",
          p_label: over?.label ?? "Stage",
          p_x: over?.x ?? 0,
          p_y: over?.y ?? 0,
          p_w: over?.w ?? 10,
          p_h: over?.h ?? 10,
        })
      ).error?.code;
    expect(await bad({ kind: "fountain" })).toBe("22023");
    expect(await bad({ label: "   " })).toBe("22023");
    expect(await bad({ label: "x".repeat(61) })).toBe("22023");
    expect(await bad({ w: 1 })).toBe("22023");
    expect(await bad({ x: 115, w: 10 })).toBe("22023");
    for (let i = 0; i < 40; i++)
      await addElement(f, { label: `Item ${i}`, x: 0, y: 0, w: 2, h: 2 });
    expect(await bad({})).toBe("54000");
  });

  it("is limited to managers, scoped to the wedding, and cannot be written directly", async () => {
    const f = await setup(1);
    const other = await setup(1);
    const t = await addTable(f, "A", 4);
    const el = await addElement(f);
    expect(
      (
        await stranger.client.rpc("move_seating_table", {
          p_wedding: f.w,
          p_table: t,
          p_x: 5,
          p_y: 5,
        })
      ).error?.code,
    ).toBe("42501");
    expect(
      (
        await stranger.client.rpc("move_seating_element", {
          p_wedding: f.w,
          p_element: el,
          p_x: 5,
          p_y: 5,
        })
      ).error?.code,
    ).toBe("42501");
    expect(
      (
        await stranger.client.rpc("add_seating_element", {
          p_wedding: f.w,
          p_layout: f.layout,
          p_kind: "bar",
          p_label: "Bar",
          p_x: 0,
          p_y: 0,
          p_w: 5,
          p_h: 5,
        })
      ).error?.code,
    ).toBe("42501");
    expect(
      (await anonClient().rpc("move_seating_table", { p_wedding: f.w, p_table: t, p_x: 5, p_y: 5 }))
        .error,
    ).not.toBeNull();
    // Another wedding's ids are indistinguishable from missing ones, even for its own owner.
    expect(
      (
        await owner.client.rpc("move_seating_table", {
          p_wedding: other.w,
          p_table: t,
          p_x: 5,
          p_y: 5,
        })
      ).error?.code,
    ).toBe("42501");
    expect(
      (
        await owner.client.rpc("move_seating_element", {
          p_wedding: other.w,
          p_element: el,
          p_x: 5,
          p_y: 5,
        })
      ).error?.code,
    ).toBe("42501");
    // Strangers see no rows and cannot write the tables directly.
    expect((await stranger.client.from("seating_elements").select("id")).data).toEqual([]);
    expect(
      (await owner.client.from("seating_elements").update({ x: 1 }).eq("id", el)).error,
    ).not.toBeNull();
    expect(
      (await owner.client.from("seating_tables").update({ pos_x: 1, pos_y: 1 }).eq("id", t)).error,
    ).not.toBeNull();
    expect(await tableRow(t)).toMatchObject({ pos_x: null });
  });

  it("removes room items with the plan and records audit events without names", async () => {
    const f = await setup(1);
    const el = await addElement(f, { label: "Private Label Example" });
    await ok(
      owner.client.rpc("remove_seating_element", {
        p_wedding: f.w,
        p_element: el,
        p_expected_version: 1,
      }),
    );
    const events = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select action, safe_changes::text as changes from public.audit_events where wedding_id = $1 and entity_type = 'seating_element'",
            [f.w],
          )
        ).rows,
    );
    expect(events.map((e) => e.action).sort()).toEqual([
      "seating.element_added",
      "seating.element_removed",
    ]);
    expect(events.some((e) => String(e.changes).includes("Private Label"))).toBe(false);
  });
});

describe("numbered seats", () => {
  const swap = (f: Fixture, a: number, b: number, client = owner.client) =>
    client.rpc("swap_guest_seats", {
      p_wedding: f.w,
      p_layout: f.layout,
      p_guest_a: f.guests[a]!,
      p_guest_b: f.guests[b]!,
    });
  const number = (f: Fixture, table: string, client = owner.client) =>
    client.rpc("number_table_seats", { p_wedding: f.w, p_table: table });
  const seatsOf = async (table: string) =>
    withSuperuser(
      async (db) =>
        (
          await db.query(
            "select guest_id, seat_number, is_captain, table_id from public.seat_assignments where table_id = $1",
            [table],
          )
        ).rows as { guest_id: string; seat_number: number | null; is_captain: boolean }[],
    );
  const seatOfGuest = async (f: Fixture, i: number) =>
    withSuperuser(
      async (db) =>
        (
          await db.query(
            "select table_id, seat_number, is_captain, tentative from public.seat_assignments where guest_id = $1",
            [f.guests[i]!],
          )
        ).rows[0] as {
          table_id: string;
          seat_number: number | null;
          is_captain: boolean;
          tentative: boolean;
        },
    );

  it("swaps two numbered guests at one table in one step, keeping the captain", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 4);
    await accept(f, 0);
    await accept(f, 1);
    await ok(assign(f, 0, t, 1));
    await ok(assign(f, 1, t, 3));
    await ok(setCaptain(f, t, 0));
    const before = (await layoutRow(f)).revision;
    await ok(swap(f, 0, 1));
    expect(await seatOfGuest(f, 0)).toMatchObject({
      table_id: t,
      seat_number: 3,
      is_captain: true,
    });
    expect(await seatOfGuest(f, 1)).toMatchObject({
      table_id: t,
      seat_number: 1,
      is_captain: false,
    });
    expect((await layoutRow(f)).revision).toBeGreaterThan(before);
    expect(await seatCount(f, t)).toBe(2);
  });

  it("swaps a numbered guest with an unnumbered one and puts the numbers where they belong", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 3);
    await accept(f, 0);
    await accept(f, 1);
    await ok(assign(f, 0, t, 2));
    await ok(assign(f, 1, t));
    await ok(swap(f, 0, 1));
    expect((await seatOfGuest(f, 0)).seat_number).toBeNull();
    expect((await seatOfGuest(f, 1)).seat_number).toBe(2);
  });

  it("swaps across tables without changing either table's size, and a moved captain stops being captain", async () => {
    const f = await setup(3);
    const a = await addTable(f, "A", 2);
    const b = await addTable(f, "B", 2);
    for (const i of [0, 1, 2]) await accept(f, i);
    await ok(assign(f, 0, a, 1));
    await ok(assign(f, 1, a, 2));
    await ok(assign(f, 2, b, 1));
    await ok(setCaptain(f, a, 0));
    await ok(swap(f, 0, 2));
    expect(await seatOfGuest(f, 0)).toMatchObject({
      table_id: b,
      seat_number: 1,
      is_captain: false,
    });
    expect(await seatOfGuest(f, 2)).toMatchObject({
      table_id: a,
      seat_number: 1,
      is_captain: false,
    });
    expect(await seatCount(f, a)).toBe(2);
    expect(await seatCount(f, b)).toBe(1);
    expect(await captainOf(a)).toEqual([]);
  });

  it("keeps a waiting guest tentative when swapped", async () => {
    const f = await setup(2);
    const a = await addTable(f, "A", 2);
    await ok(
      owner.client.rpc("set_seating_tentative", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_version: (await layoutRow(f)).version,
        p_allow: true,
      }),
    );
    await accept(f, 0);
    await ok(assign(f, 0, a, 1));
    await ok(assign(f, 1, a, 2)); // guest 1 is still waiting
    await ok(swap(f, 0, 1));
    expect(await seatOfGuest(f, 0)).toMatchObject({ seat_number: 2, tentative: false });
    expect(await seatOfGuest(f, 1)).toMatchObject({ seat_number: 1, tentative: true });
  });

  it("refuses the same guest twice or a guest who is not seated, and changes nothing", async () => {
    const f = await setup(3);
    const t = await addTable(f, "A", 3);
    await accept(f, 0);
    await accept(f, 1);
    await ok(assign(f, 0, t, 1));
    const before = (await layoutRow(f)).revision;
    expect((await swap(f, 0, 0)).error?.code).toBe("22023");
    expect((await swap(f, 0, 1)).error?.code).toBe("SE404");
    expect((await swap(f, 1, 0)).error?.code).toBe("SE404");
    expect(await seatOfGuest(f, 0)).toMatchObject({ seat_number: 1 });
    expect((await layoutRow(f)).revision).toBe(before);
  });

  it("T10: concurrent swaps never lose or duplicate a seat", async () => {
    for (let round = 0; round < 3; round++) {
      const f = await setup(3);
      const t = await addTable(f, "A", 3);
      for (const i of [0, 1, 2]) {
        await accept(f, i);
        await ok(assign(f, i, t, i + 1));
      }
      await Promise.all([swap(f, 0, 1), swap(f, 1, 2), swap(f, 0, 2)]);
      const rows = await seatsOf(t);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.seat_number).sort()).toEqual([1, 2, 3]);
    }
  });

  it("numbers unnumbered guests with the lowest free seats in name order, and replays as no change", async () => {
    const f = await setup(4);
    const t = await addTable(f, "A", 5);
    for (const i of [0, 1, 2, 3]) await accept(f, i);
    await ok(assign(f, 2, t, 1)); // keeps seat 1
    await ok(assign(f, 3, t));
    await ok(assign(f, 0, t));
    await ok(assign(f, 1, t, 3)); // keeps seat 3
    const before = (await layoutRow(f)).revision;
    expect(await ok(number(f, t))).toBe(2);
    expect(await seatOfGuest(f, 2)).toMatchObject({ seat_number: 1 });
    expect(await seatOfGuest(f, 1)).toMatchObject({ seat_number: 3 });
    // "Guest 0 Example" sorts before "Guest 3 Example": seats 2 and 4.
    expect(await seatOfGuest(f, 0)).toMatchObject({ seat_number: 2 });
    expect(await seatOfGuest(f, 3)).toMatchObject({ seat_number: 4 });
    const after = (await layoutRow(f)).revision;
    expect(after).toBeGreaterThan(before);
    expect(await ok(number(f, t))).toBe(0);
    expect((await layoutRow(f)).revision).toBe(after);
  });

  it("makes a finalized plan stale and puts the numbers in the frozen copy", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 2);
    await accept(f, 0);
    await accept(f, 1);
    await ok(assign(f, 0, t, 1));
    await ok(assign(f, 1, t, 2));
    await ok(
      owner.client.rpc("finalize_seating_layout", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_revision: (await layoutRow(f)).revision,
      }),
    );
    const frozen = await layoutRow(f);
    const frozenSeats = (
      frozen.snapshot as { tables: { guests: { name: string; seat: number | null }[] }[] }
    ).tables[0]!.guests.map((g) => [g.name, g.seat]);
    expect(frozenSeats).toEqual([
      ["Guest 0 Example", 1],
      ["Guest 1 Example", 2],
    ]);
    await ok(swap(f, 0, 1));
    const after = await layoutRow(f);
    expect(after.finalized_revision).not.toBe(after.revision);
    // The frozen copy is not rewritten by the swap.
    expect(JSON.stringify(after.snapshot)).toBe(JSON.stringify(frozen.snapshot));
  });

  it("is limited to managers and the wedding's own tables, and audits without names", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 2);
    await accept(f, 0);
    await accept(f, 1);
    await ok(assign(f, 0, t, 1));
    await ok(assign(f, 1, t));
    expect((await swap(f, 0, 1, stranger.client)).error?.code).toBe("42501");
    expect((await number(f, t, stranger.client)).error?.code).toBe("42501");
    const other = await setup(1);
    expect((await number(other, t)).error?.code).toBe("42501"); // another wedding's table
    expect((await swap(other, 0, 0)).error?.code).toBe("22023");
    expect(
      (
        await anonClient().rpc("swap_guest_seats", {
          p_wedding: f.w,
          p_layout: f.layout,
          p_guest_a: f.guests[0]!,
          p_guest_b: f.guests[1]!,
        })
      ).error,
    ).not.toBeNull();
    await ok(swap(f, 0, 1));
    await ok(number(f, t));
    const events = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select action, safe_changes::text c from public.audit_events where wedding_id = $1 and action in ('seating.seats_swapped','seating.seats_numbered')",
            [f.w],
          )
        ).rows,
    );
    expect(events.map((e) => e.action)).toContain("seating.seats_swapped");
    expect(events.some((e) => String(e.c).includes("Guest"))).toBe(false);
  });
});

describe("suggested seating", () => {
  type Placement = { table: string; guests: string[] };
  const place = (f: Fixture, t: string, guests: number[]): Placement => ({
    table: t,
    guests: guests.map((i) => f.guests[i]!),
  });
  const apply = (
    f: Fixture,
    revision: number,
    placements: unknown,
    client = owner.client,
    layout = f.layout,
  ) =>
    client.rpc("apply_seating_suggestion", {
      p_wedding: f.w,
      p_layout: layout,
      p_expected_revision: revision,
      p_placements: placements as never,
    });
  const seated = async (f: Fixture) =>
    withSuperuser(
      async (db) =>
        (
          await db.query(
            "select guest_id, table_id, seat_number, tentative, is_captain from public.seat_assignments where layout_id = $1",
            [f.layout],
          )
        ).rows as {
          guest_id: string;
          table_id: string;
          seat_number: number | null;
          tentative: boolean;
          is_captain: boolean;
        }[],
    );

  it("seats every proposed guest at once, without seat numbers or captains, and bumps the revision once", async () => {
    const f = await setup(4);
    const a = await addTable(f, "A", 3);
    const b = await addTable(f, "B", 2);
    for (const i of [0, 1, 2, 3]) await accept(f, i);
    const before = (await layoutRow(f)).revision;
    expect(await ok(apply(f, before, [place(f, a, [0, 1, 2]), place(f, b, [3])]))).toBe(4);
    const rows = await seated(f);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.seat_number === null && !r.is_captain && !r.tentative)).toBe(true);
    expect(rows.filter((r) => r.table_id === a)).toHaveLength(3);
    expect((await layoutRow(f)).revision).toBe(before + 1);
  });

  it("is refused when the plan changed since the proposal, and changes nothing", async () => {
    const f = await setup(3);
    const a = await addTable(f, "A", 3);
    for (const i of [0, 1, 2]) await accept(f, i);
    const revision = (await layoutRow(f)).revision;
    await ok(assign(f, 2, a)); // someone seats a guest after the proposal was made
    const r = await apply(f, revision, [place(f, a, [0, 1])]);
    expect(r.error?.code).toBe("55000");
    expect(await seatCount(f)).toBe(1);
    // A fresh revision is accepted.
    expect(await ok(apply(f, (await layoutRow(f)).revision, [place(f, a, [0, 1])]))).toBe(2);
  });

  it("replaying an applied suggestion is refused rather than double seating", async () => {
    const f = await setup(2);
    const a = await addTable(f, "A", 2);
    for (const i of [0, 1]) await accept(f, i);
    const revision = (await layoutRow(f)).revision;
    await ok(apply(f, revision, [place(f, a, [0, 1])]));
    expect((await apply(f, revision, [place(f, a, [0, 1])])).error?.code).toBe("55000");
    expect(await seatCount(f)).toBe(2);
  });

  it("is all or nothing: a full table, an ineligible guest or an already seated guest rejects everything", async () => {
    const f = await setup(4);
    const a = await addTable(f, "A", 2);
    const b = await addTable(f, "B", 2);
    for (const i of [0, 1, 2]) await accept(f, i);
    await ok(respond(f, 3, "declined"));
    const rev = async () => (await layoutRow(f)).revision;
    // Over capacity at A, even though B's part is fine.
    expect(
      (await apply(f, await rev(), [place(f, b, [0]), place(f, a, [1, 2, 0])])).error?.code,
    ).toBe(
      "22023", // guest 0 twice
    );
    const r1 = await apply(f, await rev(), [
      place(f, b, [0]),
      place(f, a, [1, 2]),
      place(f, b, [3]),
    ]);
    expect(r1.error?.code).toBe("SE422"); // guest 3 declined
    expect(await seatCount(f)).toBe(0);
    const tooMany = await apply(f, await rev(), [place(f, a, [0, 1, 2])]);
    expect(tooMany.error?.code).toBe("SE409");
    expect(await seatCount(f)).toBe(0);
    await ok(assign(f, 0, a));
    expect((await apply(f, await rev(), [place(f, b, [0, 1])])).error?.code).toBe("SE422"); // already seated
    expect(await seatCount(f)).toBe(1);
  });

  it("counts people already at a table, and holds waiting guests tentatively only when allowed", async () => {
    const f = await setup(3);
    const a = await addTable(f, "A", 2);
    await accept(f, 0);
    await accept(f, 1);
    await ok(assign(f, 0, a));
    const rev = async () => (await layoutRow(f)).revision;
    expect((await apply(f, await rev(), [place(f, a, [1, 2])])).error?.code).toBe("SE422"); // 2 is waiting
    expect((await apply(f, await rev(), [place(f, a, [1])])).error).toBeNull();
    expect(await seatCount(f, a)).toBe(2);

    const g = await setup(2);
    const t = await addTable(g, "A", 2);
    await accept(g, 0);
    await ok(
      owner.client.rpc("set_seating_tentative", {
        p_wedding: g.w,
        p_layout: g.layout,
        p_expected_version: (await layoutRow(g)).version,
        p_allow: true,
      }),
    );
    await ok(apply(g, (await layoutRow(g)).revision, [place(g, t, [0, 1])]));
    const rows = await seated(g);
    expect(rows.find((r) => r.guest_id === g.guests[1])?.tentative).toBe(true);
    expect(rows.find((r) => r.guest_id === g.guests[0])?.tentative).toBe(false);
  });

  it("rejects malformed input and another wedding's tables or layout", async () => {
    const f = await setup(2);
    const a = await addTable(f, "A", 2);
    for (const i of [0, 1]) await accept(f, i);
    const rev = (await layoutRow(f)).revision;
    for (const bad of [
      null,
      [],
      {},
      [{ table: a }],
      [{ table: a, guests: [] }],
      [{ table: "nope", guests: [f.guests[0]!] }],
      [{ table: a, guests: [7] }],
    ]) {
      expect((await apply(f, rev, bad)).error?.code).toBe("22023");
    }
    expect(await seatCount(f)).toBe(0);

    const other = await setup(1);
    const foreignTable = await addTable(other, "X", 2);
    await accept(other, 0);
    // A table from another wedding named in this wedding's layout.
    expect(
      (await apply(f, rev, [{ table: foreignTable, guests: [f.guests[0]!] }])).error?.code,
    ).toBe("42501");
    // A foreign guest in this wedding's table: not eligible here.
    expect((await apply(f, rev, [{ table: a, guests: [other.guests[0]!] }])).error?.code).toBe(
      "SE422",
    );
    // Another wedding's layout under this wedding's id.
    expect((await apply(f, rev, [place(f, a, [0])], owner.client, other.layout)).error?.code).toBe(
      "42501",
    );
    expect(await seatCount(f)).toBe(0);
  });

  it("is limited to guest managers, and audits counts without names", async () => {
    const f = await setup(2);
    const a = await addTable(f, "A", 2);
    for (const i of [0, 1]) await accept(f, i);
    const rev = (await layoutRow(f)).revision;
    expect((await apply(f, rev, [place(f, a, [0, 1])], stranger.client)).error?.code).toBe("42501");
    expect(
      (
        await anonClient().rpc("apply_seating_suggestion", {
          p_wedding: f.w,
          p_layout: f.layout,
          p_expected_revision: rev,
          p_placements: [place(f, a, [0, 1])] as never,
        })
      ).error,
    ).not.toBeNull();
    expect(await seatCount(f)).toBe(0);
    await ok(apply(f, rev, [place(f, a, [0, 1])]));
    const events = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select action, safe_changes::text c from public.audit_events where wedding_id = $1 and action = 'seating.suggestion_applied'",
            [f.w],
          )
        ).rows,
    );
    expect(events).toHaveLength(1);
    expect(String(events[0]!.c)).toContain('"count": 2');
    expect(String(events[0]!.c)).not.toContain("Guest");
  });

  it("makes a finalized plan out of date, without rewriting the frozen copy", async () => {
    const f = await setup(2);
    const a = await addTable(f, "A", 2);
    for (const i of [0, 1]) await accept(f, i);
    await ok(
      owner.client.rpc("finalize_seating_layout", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_expected_revision: (await layoutRow(f)).revision,
      }),
    );
    const frozen = await layoutRow(f);
    await ok(apply(f, frozen.revision, [place(f, a, [0, 1])]));
    const after = await layoutRow(f);
    expect(after.finalized_revision).not.toBe(after.revision);
    expect(JSON.stringify(after.snapshot)).toBe(JSON.stringify(frozen.snapshot));
  });

  it("T10: two applies racing for the same revision seat once, and a competing seat never overfills", async () => {
    for (let round = 0; round < 3; round++) {
      const f = await setup(4);
      const a = await addTable(f, "A", 2);
      const b = await addTable(f, "B", 2);
      for (const i of [0, 1, 2, 3]) await accept(f, i);
      const rev = (await layoutRow(f)).revision;
      const [x, y] = await Promise.all([
        apply(f, rev, [place(f, a, [0, 1])]),
        apply(f, rev, [place(f, b, [2, 3])]),
      ]);
      const codes = [x.error?.code, y.error?.code].filter(Boolean);
      expect(codes).toEqual(["55000"]);
      expect(await seatCount(f)).toBe(2);
      // Racing a single seat against an apply: capacity holds either way.
      const g = await setup(3);
      const t = await addTable(g, "A", 2);
      for (const i of [0, 1, 2]) await accept(g, i);
      const grev = (await layoutRow(g)).revision;
      await Promise.all([apply(g, grev, [place(g, t, [0, 1])]), assign(g, 2, t)]);
      expect(await seatCount(g, t)).toBeLessThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------- REL-05 history
const submit = async (f: Fixture, responses: unknown[]) => {
  const client = `c-${randomUUID().slice(0, 12)}`;
  const view = (await ok(
    adminClient().rpc("rsvp_view", { p_token_hash: sha(f.invitation.raw), p_client: client }),
  )) as { version: number };
  return adminClient().rpc("rsvp_submit", {
    p_token_hash: sha(f.invitation.raw),
    p_client: client,
    p_expected_version: view.version,
    p_responses: responses,
  });
};
const changes = async (f: Fixture, guest: string) =>
  withSuperuser(
    async (db) =>
      (
        await db.query(
          "select * from public.rsvp_changes where wedding_id = $1 and guest_id = $2 order by occurred_at, id",
          [f.w, guest],
        )
      ).rows,
  );
const versions = async (f: Fixture) =>
  withSuperuser(
    async (db) =>
      (
        await db.query(
          "select * from public.seating_snapshots where layout_id = $1 order by finalized_at, id",
          [f.layout],
        )
      ).rows,
  );
const finalize = (f: Fixture, revision: number) =>
  owner.client.rpc("finalize_seating_layout", {
    p_wedding: f.w,
    p_layout: f.layout,
    p_expected_revision: revision,
  });

async function joinAs(f: Fixture, label: string, role: "editor" | "viewer" | "partner") {
  const user = await createUser(label);
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
  return user;
}

describe("reply history", () => {
  it("records each real change once, with the answer and meal before and after", async () => {
    const f = await setup(2);
    await ok(submit(f, [{ memberId: f.members[0], status: "accepted", mealOptionId: f.meals[0] }]));
    await ok(submit(f, [{ memberId: f.members[0], status: "accepted", mealOptionId: f.meals[1] }]));
    await ok(submit(f, [{ memberId: f.members[0], status: "declined" }]));
    const rows = await changes(f, f.guests[0]!);
    expect(
      rows.map((r) => [r.from_status, r.to_status, r.from_meal_option_id, r.to_meal_option_id]),
    ).toEqual([
      ["pending", "accepted", null, f.meals[0]],
      ["accepted", "accepted", f.meals[0], f.meals[1]],
      ["accepted", "declined", f.meals[1], null],
    ]);
    // A guest's own link has no signed-in actor.
    expect(rows.every((r) => r.source === "guest" && r.actor_id === null)).toBe(true);
    expect(await changes(f, f.guests[1]!)).toHaveLength(0);
  });

  it("writes nothing when a retry changes nothing", async () => {
    const f = await setup(1);
    await ok(submit(f, [{ memberId: f.members[0], status: "accepted", mealOptionId: f.meals[0] }]));
    await ok(submit(f, [{ memberId: f.members[0], status: "accepted", mealOptionId: f.meals[0] }]));
    await ok(submit(f, [{ memberId: f.members[0], status: "accepted", mealOptionId: f.meals[0] }]));
    expect(await changes(f, f.guests[0]!)).toHaveLength(1);
  });

  it("records the owner's override with who and why, and nothing for a no-op override", async () => {
    const f = await setup(1);
    await ok(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: f.w,
        p_member_id: f.members[0]!,
        p_status: "accepted",
        p_reason: "Phoned us on Sunday",
        p_meal_option_id: f.meals[0]!,
      }),
    );
    await ok(
      owner.client.rpc("override_rsvp_response", {
        p_wedding: f.w,
        p_member_id: f.members[0]!,
        p_status: "accepted",
        p_reason: "Same again",
        p_meal_option_id: f.meals[0]!,
      }),
    );
    const rows = await changes(f, f.guests[0]!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "couple",
      actor_id: owner.id,
      reason: "Phoned us on Sunday",
    });
  });

  it("records a plus-one's answer when the guest adds them", async () => {
    const f = await setup(1);
    await withSuperuser((db) =>
      db.query("update public.invitations set plus_one_quota = 1 where id = $1", [f.invitation.id]),
    );
    const client = `c-${randomUUID().slice(0, 12)}`;
    const view = (await ok(
      adminClient().rpc("rsvp_view", { p_token_hash: sha(f.invitation.raw), p_client: client }),
    )) as { version: number };
    await ok(
      adminClient().rpc("rsvp_submit", {
        p_token_hash: sha(f.invitation.raw),
        p_client: client,
        p_expected_version: view.version,
        p_responses: [],
        p_plus_one: { name: "Plus One Example", mealOptionId: f.meals[0] },
      }),
    );
    const rows = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select c.to_status from public.rsvp_changes c join public.guests g on g.id = c.guest_id where c.wedding_id = $1 and g.full_name = 'Plus One Example'",
            [f.w],
          )
        ).rows,
    );
    expect(rows).toEqual([{ to_status: "accepted" }]);
  });

  it("cannot be edited or deleted, by clients or by the database owner's ordinary statements", async () => {
    const f = await setup(1);
    await accept(f, 0, f.meals[0]);
    expect(
      (
        await owner.client
          .from("rsvp_changes")
          .update({ reason: "tamper" })
          .eq("wedding_id", f.w)
          .select()
      ).data ?? [],
    ).toHaveLength(0);
    expect(
      (await owner.client.from("rsvp_changes").delete().eq("wedding_id", f.w).select()).data ?? [],
    ).toHaveLength(0);
    expect(
      (
        await owner.client.from("rsvp_changes").insert({
          wedding_id: f.w,
          event_id: f.event,
          guest_id: f.guests[0]!,
          from_status: "pending",
          to_status: "declined",
          source: "couple",
        })
      ).error,
    ).not.toBeNull();
    await expect(
      withSuperuser((db) =>
        db.query("update public.rsvp_changes set reason = 'x' where wedding_id = $1", [f.w]),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      withSuperuser((db) =>
        db.query("delete from public.rsvp_changes where wedding_id = $1", [f.w]),
      ),
    ).rejects.toThrow(/append-only/);
    expect(await changes(f, f.guests[0]!)).toHaveLength(1);
  });

  it("is readable by owner and partner only, and only in their own wedding", async () => {
    const f = await setup(1);
    await accept(f, 0, f.meals[0]);
    const partner = await joinAs(f, "hist-partner", "partner");
    const editor = await joinAs(f, "hist-editor", "editor");
    const viewer = await joinAs(f, "hist-viewer", "viewer");
    const read = async (u: TestUser) =>
      (await u.client.from("rsvp_changes").select("id").eq("wedding_id", f.w)).data ?? [];
    expect(await read(owner)).toHaveLength(1);
    expect(await read(partner)).toHaveLength(1);
    expect(await read(editor)).toHaveLength(0);
    expect(await read(viewer)).toHaveLength(0);
    expect(await read(stranger)).toHaveLength(0);
    expect(
      (await anonClient().from("rsvp_changes").select("id").eq("wedding_id", f.w)).data ?? [],
    ).toHaveLength(0);
  });
});

describe("finalized seating versions", () => {
  it("keeps every finalization as its own row, and an older row is never rewritten", async () => {
    const f = await setup(2);
    const t = await addTable(f, "A", 2);
    await accept(f, 0, f.meals[0]);
    await ok(assign(f, 0, t));
    await ok(finalize(f, (await layoutRow(f)).revision));
    const first = await versions(f);
    expect(first).toHaveLength(1);
    expect(first[0]!.snapshot).toMatchObject({ accepted: 1, confirmedSeated: 1 });

    await accept(f, 1, f.meals[1]);
    await ok(assign(f, 1, t));
    const rev = (await layoutRow(f)).revision;
    await ok(finalize(f, rev));
    const both = await versions(f);
    expect(both).toHaveLength(2);
    expect(both[0]!.id).toBe(first[0]!.id);
    expect(JSON.stringify(both[0]!.snapshot)).toBe(JSON.stringify(first[0]!.snapshot));
    expect(both[1]!.snapshot).toMatchObject({ accepted: 2, confirmedSeated: 2 });
    expect(both[1]!.revision).toBe(rev);
    // The layout still holds the latest copy.
    expect((await layoutRow(f)).snapshot).toEqual(both[1]!.snapshot);
  });

  it("finalizing an unchanged plan again adds nothing", async () => {
    const f = await setup(1);
    const t = await addTable(f, "A", 2);
    await accept(f, 0);
    await ok(assign(f, 0, t));
    const rev = (await layoutRow(f)).revision;
    await ok(finalize(f, rev));
    const before = await layoutRow(f);
    await ok(finalize(f, rev));
    expect(await versions(f)).toHaveLength(1);
    expect((await layoutRow(f)).version).toBe(before.version);
  });

  it("a stale revision is still refused and writes no version", async () => {
    const f = await setup(1);
    const rev = (await layoutRow(f)).revision as number;
    expect((await finalize(f, rev - 1)).error?.code).toBe("55000");
    expect(await versions(f)).toHaveLength(0);
  });

  it("staleness still follows the plan: a change after finalizing keeps the version and flags it", async () => {
    const f = await setup(1);
    const t = await addTable(f, "A", 2);
    await accept(f, 0);
    await ok(assign(f, 0, t));
    await ok(finalize(f, (await layoutRow(f)).revision));
    await ok(submit(f, [{ memberId: f.members[0], status: "declined" }]));
    const layout = await layoutRow(f);
    expect(layout.revision).toBeGreaterThan(layout.finalized_revision);
    const rows = await versions(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snapshot).toMatchObject({ confirmedSeated: 1 });
  });

  it("cannot be edited or deleted", async () => {
    const f = await setup(1);
    await ok(finalize(f, (await layoutRow(f)).revision));
    await expect(
      withSuperuser((db) =>
        db.query("update public.seating_snapshots set snapshot = '{}' where layout_id = $1", [
          f.layout,
        ]),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      withSuperuser((db) =>
        db.query("delete from public.seating_snapshots where layout_id = $1", [f.layout]),
      ),
    ).rejects.toThrow(/append-only/);
    expect(
      (await owner.client.from("seating_snapshots").delete().eq("layout_id", f.layout).select())
        .data ?? [],
    ).toHaveLength(0);
    expect(await versions(f)).toHaveLength(1);
  });

  it("is readable by owner and partner only", async () => {
    const f = await setup(1);
    await ok(finalize(f, (await layoutRow(f)).revision));
    const partner = await joinAs(f, "ver-partner", "partner");
    const editor = await joinAs(f, "ver-editor", "editor");
    const viewer = await joinAs(f, "ver-viewer", "viewer");
    const read = async (u: TestUser) =>
      (await u.client.from("seating_snapshots").select("id").eq("wedding_id", f.w)).data ?? [];
    expect(await read(owner)).toHaveLength(1);
    expect(await read(partner)).toHaveLength(1);
    expect(await read(editor)).toHaveLength(0);
    expect(await read(viewer)).toHaveLength(0);
    expect(await read(stranger)).toHaveLength(0);
  });

  it("a layout with no finalization has no versions, and others' versions stay separate", async () => {
    const f = await setup(1);
    const other = await setup(1);
    await ok(finalize(other, (await layoutRow(other)).revision));
    expect(await versions(f)).toHaveLength(0);
    expect(await versions(other)).toHaveLength(1);
  });
});
