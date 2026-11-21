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
