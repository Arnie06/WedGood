import { randomBytes, randomUUID, createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  anonClient,
  createUser,
  createWedding,
  withSuperuser,
  type TestUser,
} from "./helpers";

// REL-10: needs attention (ADR-031 D6). One stored kind: seats released after the seating plan was
// finalized. One open item per event, an increment per real release, nothing on a retry; finalizing
// again closes it; marking it handled is idempotent. Computed conditions are dismissed with a
// fingerprint. Roles: owner and partner act; reply-derived rows are readable by them only.

let owner: TestUser;
let other: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("at-owner");
  other = await createUser("at-other");
  stranger = await createUser("at-stranger");
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

type Fixture = {
  w: string;
  event: string;
  guests: string[];
  members: string[];
  invitation: { id: string; raw: string };
  layout: string;
  table: string;
};

/** One event, n invited guests, a seating layout with one big table. Nobody has answered yet. */
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
  const layout = (await ok(
    owner.client.rpc("ensure_seating_layout", { p_wedding: w, p_event_id: event }),
  )) as string;
  const table = (await ok(
    owner.client.rpc("add_seating_table", {
      p_wedding: w,
      p_layout: layout,
      p_label: "A",
      p_capacity: 12,
    }),
  )) as string;
  return {
    w,
    event,
    guests,
    members: guests.map((g) => rows.find((r) => r.guest_id === g)!.id as string),
    invitation: { id: invitationId, raw },
    layout,
    table,
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

/** Everyone accepts and takes a seat, then the plan is finalized. */
async function seatAndFinalize(f: Fixture) {
  for (let i = 0; i < f.guests.length; i++) await respond(f, i, "accepted");
  for (const g of f.guests) {
    await ok(
      owner.client.rpc("assign_guest_seat", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_guest: g,
        p_table: f.table,
      }),
    );
  }
  await finalize(f);
}
async function finalize(f: Fixture) {
  const rev = await withSuperuser(
    async (db) =>
      (await db.query("select revision from public.seating_layouts where id = $1", [f.layout]))
        .rows[0].revision as number,
  );
  await ok(
    owner.client.rpc("finalize_seating_layout", {
      p_wedding: f.w,
      p_layout: f.layout,
      p_expected_revision: rev,
    }),
  );
}

type Item = {
  id: string;
  kind: string;
  status: string;
  occurrences: number;
  resolved_by: string | null;
};
const items = (f: Fixture) =>
  withSuperuser(
    async (db) =>
      (
        await db.query<Item>(
          "select id, kind, status, occurrences, resolved_by from public.attention_items where wedding_id = $1 order by created_at, id",
          [f.w],
        )
      ).rows,
  );
const audits = (f: Fixture, action: string) =>
  withSuperuser(
    async (db) =>
      (
        await db.query(
          "select safe_changes, entity_id from public.audit_events where wedding_id = $1 and action = $2 order by occurred_at, id",
          [f.w, action],
        )
      ).rows,
  );
const dismissals = (w: string) =>
  withSuperuser(
    async (db) =>
      (
        await db.query(
          "select kind, subject_id, fingerprint, guest_data from public.attention_dismissals where wedding_id = $1 order by kind",
          [w],
        )
      ).rows as { kind: string; subject_id: string; fingerprint: string; guest_data: boolean }[],
  );

describe("seats released after finalizing", () => {
  it("makes nothing while the plan was never finalized", async () => {
    const f = await setup(2);
    await respond(f, 0, "accepted");
    await ok(
      owner.client.rpc("assign_guest_seat", {
        p_wedding: f.w,
        p_layout: f.layout,
        p_guest: f.guests[0]!,
        p_table: f.table,
      }),
    );
    await respond(f, 0, "declined");
    expect(await items(f)).toEqual([]);
  });

  it("makes one open item when a seated guest declines after finalizing, and adds to it, not a second", async () => {
    const f = await setup(4);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    const one = await items(f);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ kind: "seats_released", status: "open", occurrences: 1 });

    await respond(f, 1, "declined");
    const two = await items(f);
    expect(two).toHaveLength(1);
    expect(two[0]).toMatchObject({ id: one[0]!.id, status: "open", occurrences: 2 });
  });

  it("adds nothing on a retried reply or a no-op change", async () => {
    const f = await setup(3);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    await respond(f, 0, "declined");
    await respond(f, 0, "declined");
    expect((await items(f))[0]).toMatchObject({ occurrences: 1 });
    expect((await items(f))[0]).toMatchObject({ occurrences: 1 });
  });

  it("counts a guest who answers through their own link", async () => {
    const f = await setup(3);
    await seatAndFinalize(f);
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
    expect(await items(f)).toMatchObject([{ status: "open", occurrences: 1 }]);
  });

  it("counts every seat released by revoking an invitation", async () => {
    const f = await setup(3);
    await seatAndFinalize(f);
    const version = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.invitations where id = $1", [f.invitation.id]))
          .rows[0].version as number,
    );
    await ok(
      owner.client.rpc("revoke_invitation", {
        p_wedding: f.w,
        p_invitation_id: f.invitation.id,
        p_expected_version: version,
      }),
    );
    expect(await items(f)).toMatchObject([{ status: "open", occurrences: 3 }]);
  });

  it("closes by itself when the plan is finalized again, and a later release starts a new item", async () => {
    const f = await setup(3);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    await finalize(f);
    const after = await items(f);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      status: "refinalized",
      occurrences: 1,
      resolved_by: owner.id,
    });

    await respond(f, 1, "declined");
    const again = await items(f);
    expect(again.map((i) => [i.status, i.occurrences])).toEqual([
      ["refinalized", 1],
      ["open", 1],
    ]);
  });

  it("counts every release exactly once when three guests decline at the same time", async () => {
    const f = await setup(4);
    await seatAndFinalize(f);
    await Promise.all([
      respond(f, 0, "declined"),
      respond(f, 1, "declined"),
      respond(f, 2, "declined"),
    ]);
    const rows = await items(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open", occurrences: 3 });
  });

  it("keeps the database to one open item per event and kind", async () => {
    const f = await setup(2);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.attention_items (wedding_id, event_id, kind) values ($1,$2,'seats_released')",
          [f.w, f.event],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("leaves seating exactly as it was before this feature: the seat is released and the plan is stale", async () => {
    const f = await setup(2);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    const layout = await withSuperuser(
      async (db) =>
        (await db.query("select * from public.seating_layouts where id = $1", [f.layout])).rows[0],
    );
    expect(layout.revision).toBeGreaterThan(layout.finalized_revision);
    const seats = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select count(*)::int as n from public.seat_assignments where layout_id = $1",
            [f.layout],
          )
        ).rows[0].n as number,
    );
    expect(seats).toBe(1);
  });
});

describe("handle_attention_item", () => {
  it("marks it handled once, audits once and stores no names or numbers", async () => {
    const f = await setup(3);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    const [item] = await items(f);
    await ok(owner.client.rpc("handle_attention_item", { p_wedding: f.w, p_item: item!.id }));
    await ok(owner.client.rpc("handle_attention_item", { p_wedding: f.w, p_item: item!.id }));
    expect(await items(f)).toMatchObject([{ status: "handled", resolved_by: owner.id }]);
    const a = await audits(f, "attention.handled");
    expect(a).toHaveLength(1);
    expect(a[0]!.safe_changes).toEqual({ kind: "seats_released" });
    expect(JSON.stringify(a[0])).not.toMatch(/Guest \d/);
  });

  it("starts a new open item for the next release after one was handled", async () => {
    const f = await setup(3);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    const [item] = await items(f);
    await ok(owner.client.rpc("handle_attention_item", { p_wedding: f.w, p_item: item!.id }));
    await respond(f, 1, "declined");
    expect((await items(f)).map((i) => [i.status, i.occurrences])).toEqual([
      ["handled", 1],
      ["open", 1],
    ]);
  });

  it("is refused for editors, viewers, strangers, other weddings and anonymous callers", async () => {
    const f = await setup(2);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    const [item] = await items(f);
    const editor = await addMember(f.w, "editor", "at-editor");
    const viewer = await addMember(f.w, "viewer", "at-viewer");
    for (const who of [editor, viewer, stranger]) {
      const r = await who.client.rpc("handle_attention_item", { p_wedding: f.w, p_item: item!.id });
      expect(r.error?.code).toBe("42501");
    }
    // The owner of another wedding cannot reach this item through their own wedding id either.
    const otherWedding = await createWedding(other);
    const cross = await other.client.rpc("handle_attention_item", {
      p_wedding: otherWedding,
      p_item: item!.id,
    });
    expect(cross.error?.code).toBe("42501");
    const anon = await anonClient().rpc("handle_attention_item", {
      p_wedding: f.w,
      p_item: item!.id,
    });
    expect(anon.error).not.toBeNull();
    expect(await items(f)).toMatchObject([{ status: "open" }]);
  });

  it("lets a partner mark it handled", async () => {
    const f = await setup(2);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    const [item] = await items(f);
    const partner = await addMember(f.w, "partner", "at-partner");
    await ok(partner.client.rpc("handle_attention_item", { p_wedding: f.w, p_item: item!.id }));
    expect(await items(f)).toMatchObject([{ status: "handled", resolved_by: partner.id }]);
  });
});

describe("reading stored items", () => {
  it("is for owner and partner only; editors, viewers and strangers read nothing", async () => {
    const f = await setup(2);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    const partner = await addMember(f.w, "partner", "at-partner-r");
    const editor = await addMember(f.w, "editor", "at-editor-r");
    const viewer = await addMember(f.w, "viewer", "at-viewer-r");
    const read = async (u: TestUser) =>
      (await ok(u.client.from("attention_items").select("id").eq("wedding_id", f.w))) as unknown[];
    expect(await read(owner)).toHaveLength(1);
    expect(await read(partner)).toHaveLength(1);
    for (const u of [editor, viewer, stranger]) expect(await read(u)).toHaveLength(0);
  });

  it("cannot be written directly by anyone signed in", async () => {
    const f = await setup(2);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    const [item] = await items(f);
    const insert = await owner.client
      .from("attention_items")
      .insert({ wedding_id: f.w, event_id: f.event, kind: "seats_released" });
    expect(insert.error).not.toBeNull();
    const update = await owner.client
      .from("attention_items")
      .update({ status: "handled", resolved_at: new Date().toISOString() })
      .eq("id", item!.id)
      .select("id");
    expect(update.data ?? []).toHaveLength(0);
    const del = await owner.client.from("attention_items").delete().eq("id", item!.id).select("id");
    expect(del.data ?? []).toHaveLength(0);
    expect(await items(f)).toMatchObject([{ status: "open" }]);
  });

  it("goes away with the event", async () => {
    const f = await setup(2);
    await seatAndFinalize(f);
    await respond(f, 0, "declined");
    await withSuperuser((db) => db.query("delete from public.events where id = $1", [f.event]));
    expect(await items(f)).toEqual([]);
  });
});

describe("dismiss_attention and restore_attention", () => {
  async function wedding() {
    const f = await setup(2);
    const venue = (await ok(
      owner.client.rpc("create_candidate", {
        p_wedding: f.w,
        p_kind: "venue",
        p_category: "venue",
        p_name: "Old Barn",
      }),
    )) as string;
    const vendor = (await ok(
      owner.client.rpc("create_candidate", {
        p_wedding: f.w,
        p_kind: "vendor",
        p_category: "photographer",
        p_name: "Lens Co",
      }),
    )) as string;
    return { f, venue, vendor };
  }
  const dismiss = (u: TestUser, w: string, kind: string, subject: string, fp = "130|120") =>
    u.client.rpc("dismiss_attention", {
      p_wedding: w,
      p_kind: kind,
      p_subject: subject,
      p_fingerprint: fp,
    });

  it("records one dismissal per condition, audits once, and updates only when the fingerprint changes", async () => {
    const { f } = await wedding();
    await ok(dismiss(owner, f.w, "over_capacity", f.event));
    await ok(dismiss(owner, f.w, "over_capacity", f.event));
    expect(await dismissals(f.w)).toEqual([
      { kind: "over_capacity", subject_id: f.event, fingerprint: "130|120", guest_data: true },
    ]);
    expect(await audits(f, "attention.dismissed")).toHaveLength(1);

    await ok(dismiss(owner, f.w, "over_capacity", f.event, "135|120"));
    expect(await dismissals(f.w)).toMatchObject([{ fingerprint: "135|120" }]);
    expect(await audits(f, "attention.dismissed")).toHaveLength(2);
    const a = await audits(f, "attention.dismissed");
    expect(a.every((r) => JSON.stringify(r.safe_changes) === '{"kind":"over_capacity"}')).toBe(
      true,
    );
  });

  it("checks the subject belongs to this wedding and matches the kind", async () => {
    const { f, venue, vendor } = await wedding();
    const foreign = await setup(1);
    const bad: [string, string][] = [
      ["over_capacity", foreign.event],
      ["over_capacity", randomUUID()],
      ["venue_unused", f.event],
      ["venue_unused", vendor],
      ["vendor_unassigned", venue],
      ["invoice_due", randomUUID()],
    ];
    for (const [kind, subject] of bad) {
      const r = await dismiss(owner, f.w, kind, subject);
      expect(r.error?.code, `${kind} ${subject}`).toBe("42501");
    }
    expect(await dismissals(f.w)).toEqual([]);
    await ok(dismiss(owner, f.w, "venue_unused", venue, "open"));
    await ok(dismiss(owner, f.w, "vendor_unassigned", vendor, "open"));
    expect((await dismissals(f.w)).map((d) => d.kind)).toEqual([
      "vendor_unassigned",
      "venue_unused",
    ]);
  });

  it("refuses unknown kinds and empty or over-long fingerprints", async () => {
    const { f } = await wedding();
    expect((await dismiss(owner, f.w, "seats_released", f.event)).error?.code).toBe("22023");
    expect((await dismiss(owner, f.w, "nonsense", f.event)).error?.code).toBe("22023");
    expect((await dismiss(owner, f.w, "over_capacity", f.event, "  ")).error?.code).toBe("22023");
    expect((await dismiss(owner, f.w, "over_capacity", f.event, "x".repeat(81))).error?.code).toBe(
      "22023",
    );
    expect(await dismissals(f.w)).toEqual([]);
  });

  it("is for owner and partner; editors, viewers, strangers and anonymous callers are refused", async () => {
    const { f } = await wedding();
    const editor = await addMember(f.w, "editor", "at-editor-d");
    const viewer = await addMember(f.w, "viewer", "at-viewer-d");
    for (const u of [editor, viewer, stranger]) {
      expect((await dismiss(u, f.w, "over_capacity", f.event)).error?.code).toBe("42501");
      expect(
        (
          await u.client.rpc("restore_attention", {
            p_wedding: f.w,
            p_kind: "over_capacity",
            p_subject: f.event,
          })
        ).error?.code,
      ).toBe("42501");
    }
    const anon = await anonClient().rpc("dismiss_attention", {
      p_wedding: f.w,
      p_kind: "over_capacity",
      p_subject: f.event,
      p_fingerprint: "x",
    });
    expect(anon.error).not.toBeNull();
    const partner = await addMember(f.w, "partner", "at-partner-d");
    await ok(dismiss(partner, f.w, "over_capacity", f.event));
    expect(await dismissals(f.w)).toHaveLength(1);
  });

  it("shows reply-derived dismissals to owner and partner only, and the rest to every member", async () => {
    const { f, venue } = await wedding();
    const editor = await addMember(f.w, "editor", "at-editor-v");
    await ok(dismiss(owner, f.w, "over_capacity", f.event));
    await ok(dismiss(owner, f.w, "venue_unused", venue, "open"));
    const read = async (u: TestUser) =>
      (
        (await ok(u.client.from("attention_dismissals").select("kind").eq("wedding_id", f.w))) as {
          kind: string;
        }[]
      )
        .map((r) => r.kind)
        .sort();
    expect(await read(owner)).toEqual(["over_capacity", "venue_unused"]);
    expect(await read(editor)).toEqual(["venue_unused"]);
    expect(await read(stranger)).toEqual([]);
  });

  it("restores once, audits once, and a second restore does nothing", async () => {
    const { f } = await wedding();
    await ok(dismiss(owner, f.w, "over_capacity", f.event));
    const restore = () =>
      ok(
        owner.client.rpc("restore_attention", {
          p_wedding: f.w,
          p_kind: "over_capacity",
          p_subject: f.event,
        }),
      );
    await restore();
    await restore();
    expect(await dismissals(f.w)).toEqual([]);
    expect(await audits(f, "attention.restored")).toHaveLength(1);
  });

  it("keeps one row when the same condition is dismissed three times at once", async () => {
    const { f } = await wedding();
    const results = await Promise.all([
      dismiss(owner, f.w, "over_capacity", f.event),
      dismiss(owner, f.w, "over_capacity", f.event),
      dismiss(owner, f.w, "over_capacity", f.event),
    ]);
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(await dismissals(f.w)).toHaveLength(1);
    expect(await audits(f, "attention.dismissed")).toHaveLength(1);
  });

  it("caps a wedding at 500 dismissals and still lets an existing one change", async () => {
    const { f } = await wedding();
    await withSuperuser((db) =>
      db.query(
        "insert into public.attention_dismissals (wedding_id, kind, subject_id, fingerprint) select $1, 'invoice_due', gen_random_uuid(), 'x' from generate_series(1, 499)",
        [f.w],
      ),
    );
    await ok(dismiss(owner, f.w, "over_capacity", f.event));
    const over = await dismiss(owner, f.w, "caterer_count", f.event);
    expect(over.error?.code).toBe("22023");
    await ok(dismiss(owner, f.w, "over_capacity", f.event, "140|120"));
  });

  it("dismissing never changes the wedding", async () => {
    const { f } = await wedding();
    const snapshot = () =>
      withSuperuser(
        async (db) =>
          (
            await db.query(
              "select (select revision from public.weddings where id = $1) as rev, (select count(*) from public.events where wedding_id = $1)::int as events, (select count(*) from public.seat_assignments where layout_id = $2)::int as seats",
              [f.w, f.layout],
            )
          ).rows[0],
      );
    const before = await snapshot();
    await ok(dismiss(owner, f.w, "over_capacity", f.event));
    expect(await snapshot()).toEqual(before);
  });

  it("goes away with the wedding", async () => {
    // A wedding with an event but no guests, so nothing else stands in the way of the delete.
    const w = await createWedding(owner);
    const event = (await ok(
      owner.client.rpc("create_event", {
        p_wedding: w,
        p_event: { name: "Reception", kind: "reception" },
      }),
    )) as string;
    await ok(dismiss(owner, w, "over_capacity", event));
    expect(await dismissals(w)).toHaveLength(1);
    await withSuperuser((db) => db.query("delete from public.weddings where id = $1", [w]));
    expect(await dismissals(w)).toEqual([]);
  });
});

describe("a dismissed condition and an invoice", () => {
  it("can be dismissed for an invoice of this wedding and not for another's", async () => {
    const w = await createWedding(owner, { guests: 100 });
    const candidate = (await ok(
      owner.client.rpc("create_candidate", {
        p_wedding: w,
        p_kind: "venue",
        p_category: "venue",
        p_name: "Garden House",
      }),
    )) as string;
    const cat = await ok(
      owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Venue" }),
    );
    const item = await ok(
      owner.client.rpc("create_budget_item", {
        p_wedding: w,
        p_category: cat,
        p_name: "Venue fee",
        p_amount_minor: 900_000,
      }),
    );
    const commitment = (await ok(
      owner.client.rpc("book_commitment", {
        p_wedding: w,
        p_candidate: candidate,
        p_expected_candidate_version: 1,
        p_title: "Venue contract",
        p_amount_minor: 1_000_000,
        p_allocations: [{ itemId: item, amountMinor: 1_000_000 }],
        p_installments: [{ dueOn: "2027-01-15", amountMinor: 1_000_000 }],
        p_confirmed: true,
      }),
    )) as string;
    const invoice = (await ok(
      owner.client.rpc("create_invoice", {
        p_wedding: w,
        p_commitment: commitment,
        p_amount_minor: 600_000,
        p_due_on: "2027-02-01",
      }),
    )) as string;
    await ok(
      owner.client.rpc("dismiss_attention", {
        p_wedding: w,
        p_kind: "invoice_due",
        p_subject: invoice,
        p_fingerprint: "2027-02-01|600000",
      }),
    );
    const otherWedding = await createWedding(other);
    const cross = await other.client.rpc("dismiss_attention", {
      p_wedding: otherWedding,
      p_kind: "invoice_due",
      p_subject: invoice,
      p_fingerprint: "x",
    });
    expect(cross.error?.code).toBe("42501");
    // An invoice is not reply data, so its dismissal is not marked as guest data.
    expect(await dismissals(w)).toMatchObject([{ kind: "invoice_due", guest_data: false }]);
  });
});
