import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-09: a guest can remove a plus-one they added. Real local Postgres and PostgREST.
// Every name below is synthetic.

let owner: TestUser;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const newToken = () => {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha(raw) };
};
const client = () => `c-${randomUUID().slice(0, 12)}`;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  owner = await createUser("remove-owner");
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows as T[]);
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}
const mkGuest = async (w: string, name: string, household: string | null = null) =>
  (await ok(
    owner.client.rpc("create_guest", {
      p_wedding: w,
      p_guest: { name },
      ...(household && { p_household: household }),
    }),
  )) as string;
const mkHousehold = async (w: string, name: string) =>
  (
    await q<{ id: string }>(
      "insert into public.households (wedding_id, name) values ($1,$2) returning id",
      [w, name],
    )
  )[0]!.id;
const mkEvent = async (w: string, name: string) =>
  (await ok(
    owner.client.rpc("create_event", { p_wedding: w, p_event: { name, kind: "other" } }),
  )) as string;
async function invite(w: string, e: string, guestIds: string[], hh: string | null, quota: number) {
  const t = newToken();
  const rows = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: e,
      p_groups: [{ guestIds, householdId: hh }],
      p_plus_one_quota: quota,
      p_expires_at: future(30),
      p_token_hashes: [t.hash],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  return { id: rows[0]!.o_invitation_id, token: t };
}

type Member = { id: string; name: string; status: string; isPlusOne: boolean };
type View = { version: number; plusOneRemaining: number; members: Member[] };
async function view(raw: string) {
  const r = await adminClient().rpc("rsvp_view", { p_token_hash: sha(raw), p_client: client() });
  return r.data as View;
}
function submit(raw: string, version: number, responses: unknown[], plusOne?: unknown) {
  return adminClient().rpc("rsvp_submit", {
    p_token_hash: sha(raw),
    p_client: client(),
    p_expected_version: version,
    p_responses: responses,
    ...(plusOne ? { p_plus_one: plusOne } : {}),
  });
}
type PEvent = {
  invitationId: string;
  version: number;
  plusOneRemaining: number;
  event: { name: string };
  members: Member[];
};
async function partyView(raw: string) {
  const r = await adminClient().rpc("rsvp_party_view", {
    p_token_hash: sha(raw),
    p_client: client(),
  });
  return r.data as { events: PEvent[] };
}
const partySubmit = (raw: string, replies: unknown) =>
  adminClient().rpc("rsvp_party_submit", {
    p_token_hash: sha(raw),
    p_client: client(),
    p_replies: replies,
  });

const accept = (m: Member) => ({ memberId: m.id, status: "accepted", mealOptionId: null });
const remove = (m: Member) => ({
  memberId: m.id,
  status: "declined",
  mealOptionId: null,
  remove: true,
});

const guestRow = async (id: string) =>
  (
    await q<{ archived_at: string | null; full_name: string }>(
      "select archived_at, full_name from public.guests where id=$1",
      [id],
    )
  )[0]!;
const memberRow = async (id: string) =>
  (
    await q<{
      active: boolean;
      rsvp_status: string;
      guest_id: string;
      meal_option_id: string | null;
    }>(
      "select active, rsvp_status, guest_id, meal_option_id from public.invitation_members where id=$1",
      [id],
    )
  )[0]!;
const usedOf = async (inv: string) =>
  (
    await q<{ plus_ones_used: number; plus_one_quota: number }>(
      "select plus_ones_used, plus_one_quota from public.invitations where id=$1",
      [inv],
    )
  )[0]!;
const countGuests = async (w: string) =>
  Number(
    (
      await q<{ n: string }>(
        "select count(*) n from public.guests where wedding_id=$1 and archived_at is null",
        [w],
      )
    )[0]!.n,
  );

/** Ada invited with one plus-one place; she has named Cy, who is attending. */
async function withCy(quota = 1) {
  const w = await createWedding(owner);
  const hh = await mkHousehold(w, "The Examples");
  const e = await mkEvent(w, "Reception");
  const ada = await mkGuest(w, "Ada Example", hh);
  const inv = await invite(w, e, [ada], hh, quota);
  const v0 = await view(inv.token.raw);
  const adaM = v0.members.find((m) => m.name === "Ada Example")!;
  const sent = await submit(inv.token.raw, v0.version, [accept(adaM)], {
    name: "Cy Plusone",
    mealOptionId: null,
  });
  expect(sent.error).toBeNull();
  const v = await view(inv.token.raw);
  const cyM = v.members.find((m) => m.name === "Cy Plusone")!;
  return { w, hh, e, ada, inv, adaM, cyM, v };
}

describe("removing a plus-one the guest added", () => {
  it("declines them, ends their place, frees the quota and archives the guest", async () => {
    const s = await withCy();
    expect(s.cyM.isPlusOne).toBe(true);
    expect(s.v.plusOneRemaining).toBe(0);
    const cyGuest = (await memberRow(s.cyM.id)).guest_id;
    const guestsBefore = await countGuests(s.w);

    const sent = await submit(s.inv.token.raw, s.v.version, [remove(s.cyM)]);
    expect(sent.error).toBeNull();

    const after = sent.data as View;
    expect(after.members.map((m) => m.name)).toEqual(["Ada Example"]);
    expect(after.plusOneRemaining).toBe(1);
    expect(await memberRow(s.cyM.id)).toMatchObject({ active: false, rsvp_status: "declined" });
    expect(await usedOf(s.inv.id)).toMatchObject({ plus_ones_used: 0, plus_one_quota: 1 });
    expect((await guestRow(cyGuest)).archived_at).not.toBeNull();
    expect(await countGuests(s.w)).toBe(guestsBefore - 1);
    // The couple's own guest is untouched.
    expect((await guestRow(s.ada)).archived_at).toBeNull();
  });

  it("keeps the history: the reply is recorded as a guest decline, with an audit row and a submission", async () => {
    const s = await withCy();
    const cyGuest = (await memberRow(s.cyM.id)).guest_id;
    const sent = await submit(s.inv.token.raw, s.v.version, [remove(s.cyM)]);
    expect(sent.error).toBeNull();

    const changes = await q<{ from_status: string; to_status: string; source: string }>(
      "select from_status, to_status, source from public.rsvp_changes where guest_id=$1 order by occurred_at, id",
      [cyGuest],
    );
    expect(changes.map((c) => [c.from_status, c.to_status, c.source])).toEqual([
      ["pending", "accepted", "guest"],
      ["accepted", "declined", "guest"],
    ]);
    const audit = await q<{ safe_changes: Record<string, unknown> }>(
      "select safe_changes from public.audit_events where wedding_id=$1 and action='rsvp.responded' order by revision desc limit 1",
      [s.w],
    );
    expect(audit[0]!.safe_changes).toEqual({
      accepted: 0,
      declined: 1,
      plus_one_added: false,
      plus_ones_removed: 1,
    });
    const rows = await q<{ declined_count: number; plus_ones_removed: number }>(
      "select declined_count, plus_ones_removed from public.rsvp_submissions where wedding_id=$1 order by submitted_at desc, id desc",
      [s.w],
    );
    expect(rows[0]).toEqual({ declined_count: 1, plus_ones_removed: 1 });
    // The earlier send, which added Cy, removed nobody.
    expect(rows[1]).toMatchObject({ plus_ones_removed: 0 });
  });

  it("gives the removal its own fingerprint, so a decline and a removal are not the same send", async () => {
    const a = await withCy();
    const b = await withCy();
    // Same shape, but b's plus-one is only declined (the old behaviour), a's is removed.
    expect((await submit(a.inv.token.raw, a.v.version, [remove(a.cyM)])).error).toBeNull();
    expect(
      (
        await submit(b.inv.token.raw, b.v.version, [
          { memberId: b.cyM.id, status: "declined", mealOptionId: null },
        ])
      ).error,
    ).toBeNull();
    const hash = async (w: string) =>
      (
        await q<{ payload_hash: string }>(
          "select payload_hash from public.rsvp_submissions where wedding_id=$1 order by submitted_at desc, id desc limit 1",
          [w],
        )
      )[0]!.payload_hash;
    expect(await hash(a.w)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hash(a.w)).not.toBe(await hash(b.w));
    // A plain decline leaves the place used and the guest in place, as before.
    expect(await usedOf(b.inv.id)).toMatchObject({ plus_ones_used: 1 });
    expect((await memberRow(b.cyM.id)).active).toBe(true);
  });

  it("lets the guest name someone else in the same send, using the place just freed", async () => {
    const s = await withCy();
    const sent = await submit(s.inv.token.raw, s.v.version, [remove(s.cyM)], {
      name: "Dee Plusone",
      mealOptionId: null,
    });
    expect(sent.error).toBeNull();
    const after = sent.data as View;
    expect(after.members.map((m) => `${m.name}:${m.status}`)).toEqual([
      "Ada Example:accepted",
      "Dee Plusone:accepted",
    ]);
    expect(await usedOf(s.inv.id)).toMatchObject({ plus_ones_used: 1 });
    const [r] = await q<{ plus_one_added: boolean; plus_ones_removed: number }>(
      "select plus_one_added, plus_ones_removed from public.rsvp_submissions where wedding_id=$1 order by submitted_at desc, id desc limit 1",
      [s.w],
    );
    expect(r).toEqual({ plus_one_added: true, plus_ones_removed: 1 });
  });

  it("still refuses a second new guest when the removal did not free a place", async () => {
    const s = await withCy(1);
    const sent = await submit(s.inv.token.raw, s.v.version, [accept(s.adaM)], {
      name: "Dee Plusone",
      mealOptionId: null,
    });
    expect(sent.error?.code).toBe("RS422");
    expect(await usedOf(s.inv.id)).toMatchObject({ plus_ones_used: 1 });
  });

  it("frees a place that an old decline still held", async () => {
    const s = await withCy();
    expect(
      (
        await submit(s.inv.token.raw, s.v.version, [
          { memberId: s.cyM.id, status: "declined", mealOptionId: null },
        ])
      ).error,
    ).toBeNull();
    const v2 = await view(s.inv.token.raw);
    expect(v2.plusOneRemaining).toBe(0);
    const sent = await submit(s.inv.token.raw, v2.version, [remove(s.cyM)]);
    expect(sent.error).toBeNull();
    expect((sent.data as View).plusOneRemaining).toBe(1);
    expect(await usedOf(s.inv.id)).toMatchObject({ plus_ones_used: 0 });
  });

  it("never lets the quota go below zero or above its limit", async () => {
    const s = await withCy(2);
    expect((await submit(s.inv.token.raw, s.v.version, [remove(s.cyM)])).error).toBeNull();
    const row = await usedOf(s.inv.id);
    expect(row.plus_ones_used).toBe(0);
    expect(row.plus_ones_used).toBeLessThanOrEqual(row.plus_one_quota);
  });

  it("releases a seat the plus-one held", async () => {
    const s = await withCy();
    const layout = (await ok(
      owner.client.rpc("ensure_seating_layout", { p_wedding: s.w, p_event_id: s.e }),
    )) as string;
    const table = (await ok(
      owner.client.rpc("add_seating_table", {
        p_wedding: s.w,
        p_layout: layout,
        p_label: "Table 1",
        p_capacity: 4,
      }),
    )) as string;
    const cyGuest = (await memberRow(s.cyM.id)).guest_id;
    await ok(
      owner.client.rpc("assign_guest_seat", {
        p_wedding: s.w,
        p_layout: layout,
        p_guest: cyGuest,
        p_table: table,
      }),
    );
    const seats = () =>
      q<{ n: string }>("select count(*) n from public.seat_assignments where layout_id=$1", [
        layout,
      ]).then((r) => Number(r[0]!.n));
    expect(await seats()).toBe(1);
    expect((await submit(s.inv.token.raw, s.v.version, [remove(s.cyM)])).error).toBeNull();
    expect(await seats()).toBe(0);
  });
});

describe("what a guest cannot remove", () => {
  it("refuses to remove a person the couple invited, and writes nothing", async () => {
    const s = await withCy();
    const before = await usedOf(s.inv.id);
    const sent = await submit(s.inv.token.raw, s.v.version, [remove(s.adaM)]);
    expect(sent.error?.code).toBe("22023");
    expect((await memberRow(s.adaM.id)).active).toBe(true);
    expect((await guestRow(s.ada)).archived_at).toBeNull();
    expect(await usedOf(s.inv.id)).toEqual(before);
    expect((await view(s.inv.token.raw)).version).toBe(s.v.version);
  });

  it("refuses 'remove' unless the answer is a decline", async () => {
    const s = await withCy();
    const sent = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.cyM.id, status: "accepted", mealOptionId: null, remove: true },
    ]);
    expect(sent.error?.code).toBe("22023");
    expect((await memberRow(s.cyM.id)).active).toBe(true);
  });

  it("refuses a remove flag that is not true or false", async () => {
    const s = await withCy();
    for (const bad of ["yes", 1, [], {}]) {
      const sent = await submit(s.inv.token.raw, s.v.version, [
        { memberId: s.cyM.id, status: "declined", mealOptionId: null, remove: bad },
      ]);
      expect(sent.error?.code).toBe("22023");
    }
    expect((await memberRow(s.cyM.id)).active).toBe(true);
    // An explicit false is an ordinary decline.
    const plain = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.cyM.id, status: "declined", mealOptionId: null, remove: false },
    ]);
    expect(plain.error).toBeNull();
    expect((await memberRow(s.cyM.id)).active).toBe(true);
  });

  it("refuses another invitation's plus-one", async () => {
    const a = await withCy();
    const b = await withCy();
    const sent = await submit(a.inv.token.raw, a.v.version, [remove(b.cyM)]);
    expect(sent.error?.code).toBe("22023");
    expect((await memberRow(b.cyM.id)).active).toBe(true);
    expect(await usedOf(b.inv.id)).toMatchObject({ plus_ones_used: 1 });
  });

  it("refuses to remove the same person twice, and a stale tab is told to reload", async () => {
    const s = await withCy();
    expect((await submit(s.inv.token.raw, s.v.version, [remove(s.cyM)])).error).toBeNull();
    const v2 = await view(s.inv.token.raw);
    // Same stale form: the version has moved on.
    expect((await submit(s.inv.token.raw, s.v.version, [remove(s.cyM)])).error?.code).toBe("55000");
    // Current version, but the person is already gone.
    expect((await submit(s.inv.token.raw, v2.version, [remove(s.cyM)])).error?.code).toBe("22023");
    expect(await usedOf(s.inv.id)).toMatchObject({ plus_ones_used: 0 });
  });

  it("is refused after the reply date, like any other change", async () => {
    const s = await withCy();
    await q("update public.invitations set deadline = now() - interval '1 hour' where id=$1", [
      s.inv.id,
    ]);
    const sent = await submit(s.inv.token.raw, s.v.version, [remove(s.cyM)]);
    expect(sent.error?.code).toBe("RS410");
    expect((await memberRow(s.cyM.id)).active).toBe(true);
    expect(await usedOf(s.inv.id)).toMatchObject({ plus_ones_used: 1 });
  });

  it("stops add-and-remove from piling up guest rows: ten plus-one rows ever per invitation", async () => {
    const s = await withCy();
    let version = s.v.version;
    let current = s.cyM;
    // Cy was the first row. Remove and re-add nine more times to reach ten.
    for (let i = 0; i < 9; i++) {
      const removed = await submit(s.inv.token.raw, version, [remove(current)], {
        name: `Guest ${i} Plusone`,
        mealOptionId: null,
      });
      expect(removed.error).toBeNull();
      const v = removed.data as View;
      version = v.version;
      current = v.members.find((m) => m.isPlusOne)!;
    }
    const rows = await q<{ n: string }>(
      "select count(*) n from public.invitation_members where invitation_id=$1 and is_plus_one",
      [s.inv.id],
    );
    expect(Number(rows[0]!.n)).toBe(10);
    // The tenth person can be removed, but nobody new can be added after.
    const sent = await submit(s.inv.token.raw, version, [remove(current)], {
      name: "One Too Many",
      mealOptionId: null,
    });
    expect(sent.error?.code).toBe("RS422");
    // That refusal wrote nothing: the person is still there.
    expect((await memberRow(current.id)).active).toBe(true);
  });
});

describe("a party link", () => {
  /** Ada invited to Ceremony and Reception, each with a place; Di is named on both. */
  async function partyWithDi() {
    const w = await createWedding(owner);
    const hh = await mkHousehold(w, "The Examples");
    const ada = await mkGuest(w, "Ada Example", hh);
    const ceremony = await mkEvent(w, "Ceremony");
    const reception = await mkEvent(w, "Reception");
    const c = await invite(w, ceremony, [ada], hh, 1);
    const r = await invite(w, reception, [ada], hh, 1);
    const token = newToken();
    await ok(
      owner.client.rpc("create_party_link", {
        p_wedding: w,
        p_invitation_ids: [c.id, r.id],
        p_expires_at: future(30),
        p_token_hash: token.hash,
        p_idempotency_key: `party-${randomUUID()}`,
      }),
    );
    const v = await partyView(token.raw);
    const ev = (name: string) => v.events.find((e) => e.event.name === name)!;
    const reply = (e: PEvent) => ({
      invitationId: e.invitationId,
      expectedVersion: e.version,
      responses: e.members.map((m) => ({ memberId: m.id, status: "accepted", mealOptionId: null })),
      plusOne: { name: "Di Plusone", mealOptionId: null },
    });
    const sent = await partySubmit(token.raw, [reply(ev("Ceremony")), reply(ev("Reception"))]);
    expect(sent.error).toBeNull();
    const after = await partyView(token.raw);
    const aev = (name: string) => after.events.find((e) => e.event.name === name)!;
    const di = (e: PEvent) => e.members.find((m) => m.isPlusOne)!;
    return { w, token, c, r, aev, di };
  }

  it("keeps the guest while they still attend another event, and archives them once none is left", async () => {
    const s = await partyWithDi();
    const cev = s.aev("Ceremony");
    const rev = s.aev("Reception");
    const diC = s.di(cev);
    const diR = s.di(rev);
    // One person across both events.
    const guestId = (await memberRow(diC.id)).guest_id;
    expect((await memberRow(diR.id)).guest_id).toBe(guestId);

    const first = await partySubmit(s.token.raw, [
      {
        invitationId: cev.invitationId,
        expectedVersion: cev.version,
        responses: [remove(diC)],
        plusOne: null,
      },
    ]);
    expect(first.error).toBeNull();
    expect((await memberRow(diC.id)).active).toBe(false);
    expect((await memberRow(diR.id)).active).toBe(true);
    expect((await guestRow(guestId)).archived_at).toBeNull();
    expect(await usedOf(s.c.id)).toMatchObject({ plus_ones_used: 0 });
    expect(await usedOf(s.r.id)).toMatchObject({ plus_ones_used: 1 });

    const rev2 = (await partyView(s.token.raw)).events.find(
      (e) => e.invitationId === rev.invitationId,
    )!;
    const second = await partySubmit(s.token.raw, [
      {
        invitationId: rev2.invitationId,
        expectedVersion: rev2.version,
        responses: [remove(diR)],
        plusOne: null,
      },
    ]);
    expect(second.error).toBeNull();
    expect((await guestRow(guestId)).archived_at).not.toBeNull();
    expect(await usedOf(s.r.id)).toMatchObject({ plus_ones_used: 0 });
  });

  it("brings the same person back to an event they were removed from, as one guest", async () => {
    const s = await partyWithDi();
    const cev = s.aev("Ceremony");
    const diC = s.di(cev);
    const guestId = (await memberRow(diC.id)).guest_id;
    expect(
      (
        await partySubmit(s.token.raw, [
          {
            invitationId: cev.invitationId,
            expectedVersion: cev.version,
            responses: [remove(diC)],
            plusOne: null,
          },
        ])
      ).error,
    ).toBeNull();

    const cev2 = (await partyView(s.token.raw)).events.find(
      (e) => e.invitationId === cev.invitationId,
    )!;
    const again = await partySubmit(s.token.raw, [
      {
        invitationId: cev2.invitationId,
        expectedVersion: cev2.version,
        responses: cev2.members.map((m) => accept(m)),
        plusOne: { name: "di plusone", mealOptionId: null },
      },
    ]);
    expect(again.error).toBeNull();
    // The earlier row for this person is used again; no second row and no second guest.
    const rows = await q<{ id: string; active: boolean; rsvp_status: string }>(
      "select id, active, rsvp_status from public.invitation_members where invitation_id=$1 and guest_id=$2",
      [cev.invitationId, guestId],
    );
    expect(rows).toEqual([{ id: diC.id, active: true, rsvp_status: "accepted" }]);
    expect(await usedOf(s.c.id)).toMatchObject({ plus_ones_used: 1 });
    const guests = await q<{ n: string }>(
      "select count(*) n from public.guests where wedding_id=$1 and lower(full_name)='di plusone'",
      [s.w],
    );
    expect(Number(guests[0]!.n)).toBe(1);
  });

  it("applies the same refusals to a party send, and writes nothing for any event", async () => {
    const s = await partyWithDi();
    const cev = s.aev("Ceremony");
    const rev = s.aev("Reception");
    const ada = rev.members.find((m) => !m.isPlusOne)!;
    const sent = await partySubmit(s.token.raw, [
      {
        invitationId: cev.invitationId,
        expectedVersion: cev.version,
        responses: [remove(s.di(cev))],
        plusOne: null,
      },
      // The couple's own invitee cannot be removed; the whole send is refused.
      {
        invitationId: rev.invitationId,
        expectedVersion: rev.version,
        responses: [remove(ada)],
        plusOne: null,
      },
    ]);
    expect(sent.error?.code).toBe("22023");
    expect((await memberRow(s.di(cev).id)).active).toBe(true);
    expect(await usedOf(s.c.id)).toMatchObject({ plus_ones_used: 1 });
  });
});
