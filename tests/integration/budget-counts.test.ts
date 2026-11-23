import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { buildDemand, isPlanningBasis, planningNumber } from "@/domain/events/demand";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// REL-03: budget items count from replies (ADR-031 D1, D2). The count comes from the database
// (budget_item_counts), built on the same population as event_demand and seating.

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("bcount-owner");
  stranger = await createUser("bcount-stranger");
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
  guests: string[];
  members: string[];
  invitation: string;
};

/** One event and n invited guests who have not answered. */
async function setup(n = 4, quota = 0, eventName = "Reception"): Promise<Fixture> {
  const w = await createWedding(owner);
  const event = await addEvent(w, eventName);
  return { w, event, ...(await invite(w, event, n, quota)) };
}
async function addEvent(w: string, name: string) {
  return (await ok(
    owner.client.rpc("create_event", { p_wedding: w, p_event: { name, kind: "reception" } }),
  )) as string;
}
async function invite(w: string, event: string, n: number, quota = 0) {
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
      p_plus_one_quota: quota,
      p_expires_at: future(30),
      p_token_hashes: [sha(randomBytes(32).toString("base64url"))],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  const invitation = created[0]!.o_invitation_id;
  const rows = await withSuperuser(
    async (db) =>
      (
        await db.query(
          "select id, guest_id from public.invitation_members where invitation_id = $1",
          [invitation],
        )
      ).rows,
  );
  return {
    guests,
    invitation,
    members: guests.map((g) => rows.find((r) => r.guest_id === g)!.id as string),
  };
}

const respond = (f: Fixture, i: number, status: "accepted" | "declined" | "pending") =>
  ok(
    owner.client.rpc("override_rsvp_response", {
      p_wedding: f.w,
      p_member_id: f.members[i]!,
      p_status: status,
      p_reason: "test",
    }),
  );

async function category(w: string) {
  return (await ok(
    owner.client.rpc("create_budget_category", {
      p_wedding: w,
      p_name: `Food ${randomUUID().slice(0, 6)}`,
    }),
  )) as string;
}
function item(user: TestUser, w: string, cat: string, extra: Record<string, unknown> = {}) {
  return user.client.rpc("create_budget_item", {
    p_wedding: w,
    p_category: cat,
    p_name: "Dinner",
    p_cost_mode: "per_guest",
    p_amount_minor: 9_500,
    ...extra,
  });
}
async function newItem(w: string, cat: string, extra: Record<string, unknown> = {}) {
  return (await ok(item(owner, w, cat, extra))) as string;
}
const plan = (event: string) => ({ p_count_source: "event_plan", p_count_event: event });

type CountRow = {
  item_id: string;
  event_id: string;
  item_count: number | null;
  plan_count: number | null;
  actual_count: number | null;
  invitations_final: boolean;
};
const counts = async (u: TestUser, w: string) =>
  (await ok(u.client.rpc("budget_item_counts", { p_wedding: w }))) as CountRow[];
const countOf = async (u: TestUser, w: string, id: string) =>
  (await counts(u, w)).find((r) => r.item_id === id)?.item_count;

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

describe("count source on a cost", () => {
  it("defaults to the guest target and has no reply-based count", async () => {
    const f = await setup(2);
    const cat = await category(f.w);
    // Exactly what a caller that predates REL-03 sends.
    const id = await newItem(f.w, cat);
    const row = await withSuperuser(
      async (db) =>
        (await db.query("select * from public.budget_items where id = $1", [id])).rows[0],
    );
    expect(row).toMatchObject({
      count_source: "guest_target",
      count_event_id: null,
      count_typed: null,
    });
    expect(await counts(owner, f.w)).toEqual([]);
  });

  it("stores an event source and a typed source, and audits a change of source", async () => {
    const f = await setup(2);
    const cat = await category(f.w);
    const a = await newItem(f.w, cat, plan(f.event));
    const b = await newItem(f.w, cat, { p_count_source: "typed", p_count_typed: 80 });
    expect(await countOf(owner, f.w, a)).toBe(2);
    expect((await counts(owner, f.w)).map((r) => r.item_id)).toEqual([a]);
    const typed = await withSuperuser(
      async (db) =>
        (await db.query("select count_typed from public.budget_items where id = $1", [b])).rows[0],
    );
    expect(typed.count_typed).toBe(80);

    const version = (id: string) =>
      withSuperuser(
        async (db) =>
          (await db.query("select version from public.budget_items where id = $1", [id])).rows[0]
            .version as number,
      );
    const update = (v: number, extra: Record<string, unknown>) =>
      owner.client.rpc("update_budget_item", {
        p_wedding: f.w,
        p_item: a,
        p_expected_version: v,
        p_category: cat,
        p_name: "Dinner",
        p_cost_mode: "per_guest",
        p_amount_minor: 9_500,
        ...extra,
      });
    // Same values again: no new version, no audit noise.
    const v1 = await version(a);
    expect((await update(v1, plan(f.event))).error).toBeNull();
    expect(await version(a)).toBe(v1);
    // Switch to the guest target: one audit entry naming the change, nothing else.
    expect((await update(v1, { p_count_source: "guest_target" })).error).toBeNull();
    expect(await version(a)).toBe(v1 + 1);
    const audit = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select safe_changes from public.audit_events where entity_id = $1 and action = 'budget.item_updated'",
            [a],
          )
        ).rows,
    );
    expect(audit.map((r) => r.safe_changes)).toEqual([{ changed: ["countSource"] }]);
    expect(await countOf(owner, f.w, a)).toBeUndefined();
  });

  it("refuses combinations that do not make sense", async () => {
    const f = await setup(1);
    const cat = await category(f.w);
    const bad: Record<string, unknown>[] = [
      // reply source without an event, or a typed source carrying an event
      { p_count_source: "event_plan" },
      { p_count_source: "typed", p_count_event: f.event },
      // a typed number on a source that does not use one
      { p_count_source: "guest_target", p_count_typed: 5 },
      { p_count_source: "typed", p_count_typed: 0 },
      { p_count_source: "typed", p_count_typed: 100001 },
      { p_count_source: "nonsense" },
      // only per-guest items may follow a count
      { p_cost_mode: "fixed", ...plan(f.event) },
      { p_cost_mode: "quantity", p_quantity: 3, p_count_source: "typed", p_count_typed: 3 },
    ];
    for (const extra of bad) {
      const r = await item(owner, f.w, cat, extra);
      expect(r.error?.code, JSON.stringify(extra)).toBe("22023");
    }
    // The table's own constraint holds even if a function were bypassed.
    const raw = await withSuperuser(async (db) => {
      try {
        await db.query(
          "insert into public.budget_items (wedding_id, category_id, name, cost_mode, count_source) values ($1,$2,'x','fixed','typed')",
          [f.w, cat],
        );
        return "inserted";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    });
    expect(raw).toBe("23514");
  });

  it("refuses an event from another wedding and a stranger's request", async () => {
    const f = await setup(1);
    const other = await setup(1, 0, "Other");
    const cat = await category(f.w);
    expect((await item(owner, f.w, cat, plan(other.event))).error?.code).toBe("22023");
    expect((await item(stranger, f.w, cat, plan(f.event))).error?.code).toBe("42501");
  });
});

describe("the count follows replies", () => {
  it("moves with accept, decline and revert, using the event's planning rule", async () => {
    const f = await setup(4);
    const cat = await category(f.w);
    const planItem = await newItem(f.w, cat, plan(f.event));
    const yesItem = await newItem(f.w, cat, {
      p_count_source: "event_yes",
      p_count_event: f.event,
    });
    const both = async () => [
      await countOf(owner, f.w, planItem),
      await countOf(owner, f.w, yesItem),
    ];

    // Everyone still deciding: planning counts them (reply window open), attending does not.
    expect(await both()).toEqual([4, 0]);
    await respond(f, 0, "accepted");
    await respond(f, 1, "declined");
    expect(await both()).toEqual([3, 1]);
    await respond(f, 1, "accepted");
    expect(await both()).toEqual([4, 2]);
    await respond(f, 0, "declined");
    expect(await both()).toEqual([3, 1]);
  });

  it("stops counting people who did not answer by the reply date, and obeys the event's basis", async () => {
    const f = await setup(3, 2);
    const cat = await category(f.w);
    const id = await newItem(f.w, cat, plan(f.event));
    await respond(f, 0, "accepted");
    expect(await countOf(owner, f.w, id)).toBe(3);
    await withSuperuser((db) =>
      db.query("update public.invitations set deadline = now() - interval '1 day' where id = $1", [
        f.invitation,
      ]),
    );
    // Reply date passed: only the guest who said yes.
    expect(await countOf(owner, f.w, id)).toBe(1);

    const setBasis = async (basis: string, plus = false) => {
      const e = await withSuperuser(
        async (db) =>
          (await db.query("select version from public.events where id = $1", [f.event])).rows[0]
            .version as number,
      );
      await ok(
        owner.client.rpc("update_event", {
          p_wedding: f.w,
          p_event_id: f.event,
          p_expected_version: e,
          p_event: {
            name: "Reception",
            kind: "reception",
            planningBasis: basis,
            planOpenPlusOnes: plus,
          },
        }),
      );
    };
    await setBasis("yes_waiting");
    expect(await countOf(owner, f.w, id)).toBe(3);
    await setBasis("yes");
    expect(await countOf(owner, f.w, id)).toBe(1);
  });

  it("adds unnamed plus-ones only when the event opts in", async () => {
    const f = await setup(2, 2);
    const cat = await category(f.w);
    const id = await newItem(f.w, cat, plan(f.event));
    expect(await countOf(owner, f.w, id)).toBe(2);
    const v = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.events where id = $1", [f.event])).rows[0]
          .version as number,
    );
    await ok(
      owner.client.rpc("update_event", {
        p_wedding: f.w,
        p_event_id: f.event,
        p_expected_version: v,
        p_event: { name: "Reception", kind: "reception", planOpenPlusOnes: true },
      }),
    );
    expect(await countOf(owner, f.w, id)).toBe(4);
  });

  it("is unknown (null), not zero, while nobody is invited to the event", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(w, "Brunch");
    const cat = await category(w);
    const id = await newItem(w, cat, plan(event));
    expect(await countOf(owner, w, id)).toBeNull();
    // A known zero stays zero: everyone invited has declined.
    const f = { w, event, ...(await invite(w, event, 1)) };
    await respond(f, 0, "declined");
    const yes = await newItem(w, cat, { p_count_source: "event_yes", p_count_event: event });
    expect(await countOf(owner, w, yes)).toBe(0);
  });

  it("leaves out archived guests and revoked invitations, as seating does", async () => {
    const f = await setup(3);
    const cat = await category(f.w);
    const id = await newItem(f.w, cat, plan(f.event));
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
    expect(await countOf(owner, f.w, id)).toBe(2);
  });

  it("matches the pure planning number for every basis, deadline and plus-one choice", async () => {
    // The SQL mirrors src/domain/events/demand.ts; this keeps the two from drifting.
    const f = await setup(4, 2);
    const cat = await category(f.w);
    const id = await newItem(f.w, cat, plan(f.event));
    await respond(f, 0, "accepted");
    await respond(f, 1, "declined");
    const event = async () => {
      const rows = (await ok(owner.client.rpc("event_demand", { p_wedding: f.w }))) as {
        event_id: string;
        planning_basis: string;
        plan_open_plus_ones: boolean;
        yes: number;
        waiting_open: number;
        waiting_closed: number;
        open_plus_ones: number;
      }[];
      return rows.find((r) => r.event_id === f.event)!;
    };
    for (const closed of [false, true]) {
      await withSuperuser((db) =>
        db.query(
          closed
            ? "update public.invitations set deadline = now() - interval '1 day' where id = $1"
            : "update public.invitations set deadline = null where id = $1",
          [f.invitation],
        ),
      );
      for (const basis of ["auto", "yes", "yes_waiting"]) {
        for (const plus of [false, true]) {
          const v = await withSuperuser(
            async (db) =>
              (await db.query("select version from public.events where id = $1", [f.event])).rows[0]
                .version as number,
          );
          await ok(
            owner.client.rpc("update_event", {
              p_wedding: f.w,
              p_event_id: f.event,
              p_expected_version: v,
              p_event: {
                name: "Reception",
                kind: "reception",
                planningBasis: basis,
                planOpenPlusOnes: plus,
              },
            }),
          );
          const d = await event();
          const expected = planningNumber(
            {
              yes: d.yes,
              waitingOpen: d.waiting_open,
              waitingClosed: d.waiting_closed,
              openPlusOnes: d.open_plus_ones,
            },
            {
              basis: isPlanningBasis(d.planning_basis) ? d.planning_basis : "auto",
              includeOpenPlusOnes: d.plan_open_plus_ones,
            },
          ).total;
          expect(await countOf(owner, f.w, id), `${basis} plus=${plus} closed=${closed}`).toBe(
            expected,
          );
        }
      }
    }
    expect(buildDemand).toBeTypeOf("function");
  });

  it("stays consistent when replies and reads happen together", async () => {
    const f = await setup(4);
    const cat = await category(f.w);
    const id = await newItem(f.w, cat, plan(f.event));
    const reads = await Promise.all([
      respond(f, 0, "accepted"),
      countOf(owner, f.w, id),
      respond(f, 1, "declined"),
      countOf(owner, f.w, id),
    ]);
    // Each read is a snapshot between 4 (nobody declined yet) and 3 (one declined).
    for (const r of [reads[1], reads[3]]) expect([3, 4]).toContain(r);
    expect(await countOf(owner, f.w, id)).toBe(3);
  });
});

async function setEvent(f: { w: string; event: string }, extra: Record<string, unknown>) {
  const v = await withSuperuser(
    async (db) =>
      (
        await db.query(
          "select version, target_attendance, invitations_final from public.events where id = $1",
          [f.event],
        )
      ).rows[0],
  );
  await ok(
    owner.client.rpc("update_event", {
      p_wedding: f.w,
      p_event_id: f.event,
      p_expected_version: v.version,
      p_event: {
        name: "Reception",
        kind: "reception",
        targetAttendance: v.target_attendance,
        invitationsFinal: v.invitations_final,
        ...extra,
      },
    }),
  );
}
const rowOf = async (u: TestUser, w: string, id: string) =>
  (await counts(u, w)).find((r) => r.item_id === id);

describe("a permanent plan with replies tracked against it", () => {
  it("prices at the plan before anyone is invited, and keeps the plan as replies arrive", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(w, "Reception");
    const f = { w, event };
    await setEvent(f, { targetAttendance: 120 });
    const cat = await category(w);
    const id = await newItem(w, cat, plan(event));
    expect(await rowOf(owner, w, id)).toMatchObject({
      item_count: 120,
      plan_count: 120,
      actual_count: null,
      invitations_final: false,
    });

    // 3 guests invited: still priced at the plan, with the tally visible beside it.
    const g = await invite(w, event, 3);
    const full = { ...f, ...g };
    expect(await rowOf(owner, w, id)).toMatchObject({
      item_count: 120,
      plan_count: 120,
      actual_count: 3,
    });
    await respond(full, 0, "declined");
    expect(await rowOf(owner, w, id)).toMatchObject({
      item_count: 120,
      plan_count: 120,
      actual_count: 2,
    });
  });

  it("goes above the plan when replies do", async () => {
    const f = await setup(5);
    await setEvent(f, { targetAttendance: 3 });
    const cat = await category(f.w);
    const id = await newItem(f.w, cat, plan(f.event));
    expect(await rowOf(owner, f.w, id)).toMatchObject({
      item_count: 5,
      plan_count: 3,
      actual_count: 5,
    });
  });

  it("follows replies alone once invitations are complete, and the plan stays", async () => {
    const f = await setup(3);
    await setEvent(f, { targetAttendance: 120 });
    const cat = await category(f.w);
    const id = await newItem(f.w, cat, plan(f.event));
    await respond(f, 0, "accepted");
    const yes = await newItem(f.w, cat, { p_count_source: "event_yes", p_count_event: f.event });
    expect(await rowOf(owner, f.w, id)).toMatchObject({ item_count: 120 });
    // "Attending" is the attending count alone; the plan-or-replies rule is for the planning number.
    expect(await rowOf(owner, f.w, yes)).toMatchObject({
      item_count: 1,
      plan_count: 120,
      actual_count: 1,
    });

    await setEvent(f, { invitationsFinal: true });
    expect(await rowOf(owner, f.w, id)).toMatchObject({
      item_count: 3,
      plan_count: 120,
      actual_count: 3,
      invitations_final: true,
    });
    expect(await rowOf(owner, f.w, yes)).toMatchObject({ item_count: 1, plan_count: 120 });

    // Final with nobody invited is unknown, not the plan and not zero.
    const w = await createWedding(owner);
    const event = await addEvent(w, "Reception");
    await setEvent({ w, event }, { targetAttendance: 50, invitationsFinal: true });
    const item2 = await newItem(w, await category(w), plan(event));
    expect(await rowOf(owner, w, item2)).toMatchObject({ item_count: null, plan_count: 50 });
  });

  it("shows members the plan and the priced count but never the replies until totals are shared", async () => {
    const f = await setup(3);
    await setEvent(f, { targetAttendance: 120 });
    const cat = await category(f.w);
    const id = await newItem(f.w, cat, plan(f.event));
    const viewer = await createUser("bcount-plan-viewer");
    await join(f, viewer, "viewer");
    expect(await rowOf(viewer, f.w, id)).toMatchObject({
      item_count: 120,
      plan_count: 120,
      actual_count: null,
    });
    await ok(owner.client.rpc("set_share_guest_totals", { p_wedding: f.w, p_enabled: true }));
    expect(await rowOf(viewer, f.w, id)).toMatchObject({ plan_count: 120, actual_count: 3 });
  });

  it("records the old and new plan in the audit log, so the original is never lost", async () => {
    const f = await setup(1);
    await setEvent(f, { targetAttendance: 120 });
    await setEvent(f, { targetAttendance: 140 });
    await setEvent(f, { targetAttendance: 140, capacity: 200 }); // plan untouched: no plan detail
    const rows = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select safe_changes from public.audit_events where entity_id = $1 and action = 'event.updated' order by occurred_at, id",
            [f.event],
          )
        ).rows,
    );
    expect(rows.map((r) => r.safe_changes.plannedAttendance)).toEqual([
      { from: null, to: 120 },
      { from: 120, to: 140 },
      undefined,
    ]);
  });

  it("rejects a non-boolean invitationsFinal", async () => {
    const f = await setup(1);
    const v = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.events where id = $1", [f.event])).rows[0]
          .version as number,
    );
    const r = await owner.client.rpc("update_event", {
      p_wedding: f.w,
      p_event_id: f.event,
      p_expected_version: v,
      p_event: { name: "Reception", kind: "reception", invitationsFinal: "yes" },
    });
    expect(r.error?.code).toBe("22023");
  });
});

describe("who can read the count (D2)", () => {
  it("gives every member the one number, and never the breakdown", async () => {
    const f = await setup(3);
    const cat = await category(f.w);
    const id = await newItem(f.w, cat, plan(f.event));
    await respond(f, 0, "accepted");
    const partner = await createUser("bcount-partner");
    const editor = await createUser("bcount-editor");
    const viewer = await createUser("bcount-viewer");
    await join(f, partner, "partner");
    await join(f, editor, "editor");
    await join(f, viewer, "viewer");

    for (const u of [owner, partner, editor, viewer]) {
      const rows = await counts(u, f.w);
      // Priced count and plan for everyone; the actual count only for those who may read totals.
      const sees = u === owner || u === partner;
      expect(rows).toEqual([
        {
          item_id: id,
          event_id: f.event,
          item_count: 3,
          plan_count: null,
          actual_count: sees ? 3 : null,
          invitations_final: false,
        },
      ]);
    }
    // Sharing is off, so the breakdown stays with owner and partner.
    expect(await ok(editor.client.rpc("event_demand", { p_wedding: f.w }))).toEqual([]);
    expect(await ok(viewer.client.rpc("event_demand", { p_wedding: f.w }))).toEqual([]);
    expect(
      ((await ok(partner.client.rpc("event_demand", { p_wedding: f.w }))) as unknown[]).length,
    ).toBe(1);
  });

  it("refuses strangers and other weddings", async () => {
    const f = await setup(1);
    expect((await stranger.client.rpc("budget_item_counts", { p_wedding: f.w })).error?.code).toBe(
      "42501",
    );
    const mine = await createWedding(stranger);
    expect(await counts(stranger, mine)).toEqual([]);
    expect(
      (await adminClient().rpc("budget_item_counts", { p_wedding: f.w })).error,
    ).not.toBeNull();
  });

  it("keeps event_demand's own rules after moving its query", async () => {
    const f = await setup(2);
    expect((await stranger.client.rpc("event_demand", { p_wedding: f.w })).error?.code).toBe(
      "42501",
    );
    const rows = (await ok(owner.client.rpc("event_demand", { p_wedding: f.w }))) as {
      invited: number;
    }[];
    expect(rows[0]?.invited).toBe(2);
  });
});
