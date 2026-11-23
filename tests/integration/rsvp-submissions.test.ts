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

// UX-08: an append-only record of every guest send. Real local Postgres, PostgREST and RLS.
// Every name and note below is synthetic.

let owner: TestUser;
let stranger: TestUser;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const newToken = () => {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha(raw) };
};
const client = () => `c-${randomUUID().slice(0, 12)}`;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const DIET = "SENTINEL-diet no shellfish";
const ACCESS = "SENTINEL-access ground floor";

beforeAll(async () => {
  owner = await createUser("subm-owner");
  stranger = await createUser("subm-stranger");
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
async function invite(w: string, e: string, guestIds: string[], hh: string | null, quota = 0) {
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

type Member = { id: string; name: string; status: string };
type View = { version: number; members: Member[] };
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
type PEvent = { invitationId: string; version: number; event: { name: string }; members: Member[] };
async function partyView(raw: string) {
  const r = await adminClient().rpc("rsvp_party_view", {
    p_token_hash: sha(raw),
    p_client: client(),
  });
  return r.data as { events: PEvent[] };
}
function partySubmit(raw: string, replies: unknown) {
  return adminClient().rpc("rsvp_party_submit", {
    p_token_hash: sha(raw),
    p_client: client(),
    p_replies: replies,
  });
}

type Row = {
  id: string;
  wedding_id: string;
  send_id: string;
  invitation_id: string;
  event_id: string;
  party_id: string | null;
  form_version: number;
  payload_hash: string;
  invitation_version: number;
  accepted_revision: number;
  accepted_count: number;
  declined_count: number;
  plus_one_added: boolean;
  details_count: number;
};
const rows = (w: string) =>
  q<Row>("select * from public.rsvp_submissions where wedding_id=$1 order by submitted_at, id", [
    w,
  ]);
const revisionOf = async (w: string) =>
  (await q<{ revision: number }>("select revision from public.weddings where id=$1", [w]))[0]!
    .revision;

/** Ada and Bo (one household) invited to one event, one plus-one place. */
async function single() {
  const w = await createWedding(owner);
  const hh = await mkHousehold(w, "The Examples");
  const e = await mkEvent(w, "Reception");
  const ada = await mkGuest(w, "Ada Example", hh);
  const bo = await mkGuest(w, "Bo Example", hh);
  const inv = await invite(w, e, [ada, bo], hh, 1);
  const v = await view(inv.token.raw);
  const m = (name: string) => v.members.find((x) => x.name === name)!;
  return { w, hh, e, ada, bo, inv, v, adaM: m("Ada Example"), boM: m("Bo Example") };
}

/** The same two guests invited to Ceremony and Reception behind one party link. */
async function party() {
  const w = await createWedding(owner);
  const hh = await mkHousehold(w, "The Examples");
  const ada = await mkGuest(w, "Ada Example", hh);
  const bo = await mkGuest(w, "Bo Example", hh);
  const ceremony = await mkEvent(w, "Ceremony");
  const reception = await mkEvent(w, "Reception");
  const c = await invite(w, ceremony, [ada, bo], hh);
  const r = await invite(w, reception, [ada, bo], hh);
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
  return { w, c, r, token, ceremony, reception, cev: ev("Ceremony"), rev: ev("Reception") };
}
const answer = (e: PEvent, status: "accepted" | "declined", extra: object = {}) => ({
  invitationId: e.invitationId,
  expectedVersion: e.version,
  responses: e.members.map((m) => ({ memberId: m.id, status, mealOptionId: null, ...extra })),
  plusOne: null,
});

describe("a single-event send", () => {
  it("records one row with the facts of the send and nothing else", async () => {
    const s = await single();
    expect(await rows(s.w)).toEqual([]);
    const sent = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", mealOptionId: null },
      { memberId: s.boM.id, status: "declined", mealOptionId: null },
    ]);
    expect(sent.error).toBeNull();
    const [r, ...rest] = await rows(s.w);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({
      wedding_id: s.w,
      invitation_id: s.inv.id,
      event_id: s.e,
      party_id: null,
      form_version: 1,
      accepted_count: 1,
      declined_count: 1,
      plus_one_added: false,
      details_count: 0,
    });
    expect(r!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    // The invitation's version and the workspace revision as they stood once the send was accepted.
    expect(r!.invitation_version).toBe((await view(s.inv.token.raw)).version);
    expect(r!.accepted_revision).toBe(await revisionOf(s.w));
    const audit = await q<{ revision: number }>(
      "select revision from public.audit_events where wedding_id=$1 and action='rsvp.responded'",
      [s.w],
    );
    expect(audit.map((a) => a.revision)).toEqual([r!.accepted_revision]);
  });

  it("records a plus-one and notes as counts only, and never the text", async () => {
    const s = await single();
    const sent = await submit(
      s.inv.token.raw,
      s.v.version,
      [{ memberId: s.adaM.id, status: "accepted", dietary: DIET, accessibility: ACCESS }],
      { name: "Cy Plusone", mealOptionId: null, dietary: DIET },
    );
    expect(sent.error).toBeNull();
    const [r] = await rows(s.w);
    expect(r).toMatchObject({ accepted_count: 2, plus_one_added: true, details_count: 2 });
    // Sentinel search over the whole row, as the database would hand it out.
    const [raw] = await q<{ j: string }>(
      "select to_jsonb(s)::text as j from public.rsvp_submissions s where wedding_id=$1",
      [s.w],
    );
    expect(raw!.j).not.toContain("SENTINEL");
    expect(raw!.j).not.toContain("Cy Plusone");
    expect(raw!.j).not.toContain("Ada Example");
  });

  it("writes one row for each send that changed something, and none for a retry", async () => {
    const s = await single();
    const first = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", mealOptionId: null },
    ]);
    expect(first.error).toBeNull();
    const v2 = await view(s.inv.token.raw);
    // The same answers again: nothing changes, so nothing is recorded.
    const retry = await submit(s.inv.token.raw, v2.version, [
      { memberId: s.adaM.id, status: "accepted", mealOptionId: null },
    ]);
    expect(retry.error).toBeNull();
    expect(await rows(s.w)).toHaveLength(1);
    // A real change is a second, separate send.
    const change = await submit(s.inv.token.raw, v2.version, [
      { memberId: s.adaM.id, status: "declined", mealOptionId: null },
    ]);
    expect(change.error).toBeNull();
    const all = await rows(s.w);
    expect(all).toHaveLength(2);
    expect(all[0]!.send_id).not.toBe(all[1]!.send_id);
    expect(all[1]!.accepted_revision).toBeGreaterThan(all[0]!.accepted_revision);
    expect(all[1]!.invitation_version).toBeGreaterThan(all[0]!.invitation_version);
  });

  it("writes nothing when the send is refused", async () => {
    const s = await single();
    const ok1 = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", mealOptionId: null },
    ]);
    expect(ok1.error).toBeNull();
    expect(await rows(s.w)).toHaveLength(1);
    // Stale version, a forged member id and a bad status are each refused with nothing recorded.
    const stale = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.boM.id, status: "accepted", mealOptionId: null },
    ]);
    expect(stale.error).not.toBeNull();
    const fresh = (await view(s.inv.token.raw)).version;
    const forged = await submit(s.inv.token.raw, fresh, [
      { memberId: randomUUID(), status: "accepted", mealOptionId: null },
    ]);
    expect(forged.error).not.toBeNull();
    const bad = await submit(s.inv.token.raw, fresh, [
      { memberId: s.boM.id, status: "maybe", mealOptionId: null },
    ]);
    expect(bad.error).not.toBeNull();
    // An unknown link records nothing anywhere.
    const unknown = await submit(newToken().raw, 1, [
      { memberId: s.boM.id, status: "accepted", mealOptionId: null },
    ]);
    expect(unknown.data).toBeNull();
    expect(await rows(s.w)).toHaveLength(1);
  });

  it("writes nothing when the reply-by date has passed", async () => {
    const s = await single();
    await q("update public.invitations set deadline = now() - interval '1 hour' where id=$1", [
      s.inv.id,
    ]);
    const closed = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", mealOptionId: null },
    ]);
    expect(closed.error).not.toBeNull();
    expect(await rows(s.w)).toEqual([]);
  });
});

describe("a party send", () => {
  it("writes one row per event it changed, under one send, with the party noted", async () => {
    const s = await party();
    const sent = await partySubmit(s.token.raw, [
      answer(s.cev, "accepted"),
      answer(s.rev, "declined"),
    ]);
    expect(sent.error).toBeNull();
    const all = await rows(s.w);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.send_id)).size).toBe(1);
    expect(new Set(all.map((r) => r.invitation_id))).toEqual(new Set([s.c.id, s.r.id]));
    expect(all.every((r) => r.party_id !== null)).toBe(true);
    expect(new Set(all.map((r) => r.accepted_revision)).size).toBe(1);
    expect(all[0]!.accepted_revision).toBe(await revisionOf(s.w));
    const byInv = new Map(all.map((r) => [r.invitation_id, r]));
    expect(byInv.get(s.c.id)).toMatchObject({ accepted_count: 2, declined_count: 0 });
    expect(byInv.get(s.r.id)).toMatchObject({ accepted_count: 0, declined_count: 2 });
    // The two events were different answers, so different fingerprints.
    expect(all[0]!.payload_hash).not.toBe(all[1]!.payload_hash);
  });

  it("skips an event whose answers did not change, and a whole send that changed nothing", async () => {
    const s = await party();
    expect((await partySubmit(s.token.raw, [answer(s.cev, "accepted")])).error).toBeNull();
    expect(await rows(s.w)).toHaveLength(1);
    const v = await partyView(s.token.raw);
    const cev = v.events.find((e) => e.event.name === "Ceremony")!;
    const rev = v.events.find((e) => e.event.name === "Reception")!;
    // Ceremony again (no change) with Reception new: only Reception is recorded.
    expect(
      (await partySubmit(s.token.raw, [answer(cev, "accepted"), answer(rev, "accepted")])).error,
    ).toBeNull();
    const all = await rows(s.w);
    expect(all).toHaveLength(2);
    expect(all[1]!.invitation_id).toBe(s.r.id);
    // Everything again: nothing is recorded.
    const v2 = await partyView(s.token.raw);
    expect(
      (
        await partySubmit(
          s.token.raw,
          v2.events.map((e) => answer(e, "accepted")),
        )
      ).error,
    ).toBeNull();
    expect(await rows(s.w)).toHaveLength(2);
  });

  it("records nothing when one event is stale, because the whole send is refused", async () => {
    const s = await party();
    const stale = { ...answer(s.rev, "accepted"), expectedVersion: s.rev.version + 5 };
    const sent = await partySubmit(s.token.raw, [answer(s.cev, "accepted"), stale]);
    expect(sent.error).not.toBeNull();
    expect(await rows(s.w)).toEqual([]);
  });

  it("keeps the record when the party link is revoked afterwards", async () => {
    const s = await party();
    expect((await partySubmit(s.token.raw, [answer(s.cev, "accepted")])).error).toBeNull();
    const partyId = (await rows(s.w))[0]!.party_id!;
    const pv = (
      await q<{ version: number }>("select version from public.invitation_parties where id=$1", [
        partyId,
      ])
    )[0]!;
    await ok(
      owner.client.rpc("revoke_party_link", {
        p_wedding: s.w,
        p_party_id: partyId,
        p_expected_version: pv.version,
      }),
    );
    expect(await rows(s.w)).toHaveLength(1);
  });
});

describe("the fingerprint", () => {
  const hash = async (responses: unknown, plusOne: unknown = null) =>
    (
      await q<{ h: string }>("select app_private.rsvp_payload_hash($1::jsonb, $2::jsonb) as h", [
        JSON.stringify(responses),
        JSON.stringify(plusOne),
      ])
    )[0]!.h;
  const A = randomUUID();
  const B = randomUUID();
  const MEAL = randomUUID();
  const base = [
    { memberId: A, status: "accepted", mealOptionId: MEAL },
    { memberId: B, status: "declined", mealOptionId: null },
  ];

  it("does not depend on the order answers were sent in, or on how a name is spaced and cased", async () => {
    expect(await hash([...base].reverse())).toBe(await hash(base));
    expect(await hash(base, { name: "Cy  Plusone ", mealOptionId: null })).toBe(
      await hash(base, { name: "cy plusone", mealOptionId: null }),
    );
  });

  it("changes when an answer, a meal or the plus-one changes", async () => {
    const h = await hash(base);
    expect(await hash([{ ...base[0], status: "declined" }, base[1]])).not.toBe(h);
    expect(await hash([{ ...base[0], mealOptionId: randomUUID() }, base[1]])).not.toBe(h);
    expect(await hash(base, { name: "Cy Plusone", mealOptionId: null })).not.toBe(h);
    expect(await hash(base, { name: "Di Plusone", mealOptionId: null })).not.toBe(
      await hash(base, { name: "Cy Plusone", mealOptionId: null }),
    );
  });

  it("knows whether a note was filled in but never what it said", async () => {
    const h = await hash(base);
    const one = await hash([{ ...base[0], dietary: DIET }, base[1]]);
    const other = await hash([
      { ...base[0], dietary: "SENTINEL-something else entirely" },
      base[1],
    ]);
    expect(one).toBe(other);
    expect(one).not.toBe(h);
    // A blank note is the same as none.
    expect(await hash([{ ...base[0], dietary: "   " }, base[1]])).toBe(h);
    // A note on dietary is not a note on accessibility.
    expect(await hash([{ ...base[0], accessibility: DIET }, base[1]])).not.toBe(one);
  });
});

describe("who can read and write the record", () => {
  it("is readable by the owner and nobody outside the workspace", async () => {
    const s = await single();
    await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", mealOptionId: null },
    ]);
    const mine = await owner.client.from("rsvp_submissions").select("id").eq("wedding_id", s.w);
    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);
    const theirs = await stranger.client
      .from("rsvp_submissions")
      .select("id")
      .eq("wedding_id", s.w);
    expect(theirs.data ?? []).toEqual([]);
    const anon = await anonClient().from("rsvp_submissions").select("id");
    expect(anon.data ?? []).toEqual([]);
  });

  it("cannot be written, changed or deleted by any client", async () => {
    const s = await single();
    await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", mealOptionId: null },
    ]);
    const [r] = await rows(s.w);
    const insert = await owner.client.from("rsvp_submissions").insert({
      wedding_id: s.w,
      send_id: randomUUID(),
      invitation_id: s.inv.id,
      event_id: s.e,
      payload_hash: "0".repeat(64),
      invitation_version: 1,
      accepted_revision: 0,
    });
    expect(insert.error).not.toBeNull();
    const update = await owner.client
      .from("rsvp_submissions")
      .update({ accepted_count: 99 })
      .eq("id", r!.id);
    expect(update.error).not.toBeNull();
    const del = await owner.client.from("rsvp_submissions").delete().eq("id", r!.id);
    expect(del.error).not.toBeNull();
    expect((await rows(s.w))[0]).toEqual(r);
  });

  it("refuses an update or delete even from a database superuser", async () => {
    const s = await single();
    await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", mealOptionId: null },
    ]);
    await expect(
      q("update public.rsvp_submissions set accepted_count = 9 where wedding_id=$1", [s.w]),
    ).rejects.toThrow(/append-only/);
    await expect(
      q("delete from public.rsvp_submissions where wedding_id=$1", [s.w]),
    ).rejects.toThrow(/append-only/);
    expect(await rows(s.w)).toHaveLength(1);
  });

  it("cannot be called by clients: the recording and fingerprint helpers are internal", async () => {
    const s = await single();
    const direct = await owner.client.rpc("rsvp_record_submission", {
      p_send: randomUUID(),
      p_invitation: s.inv.id,
      p_party: null,
      p_responses: [],
      p_plus_one: null,
      p_res: {},
      p_revision: 1,
    });
    expect(direct.error).not.toBeNull();
    expect(await rows(s.w)).toEqual([]);
    const anonSubmit = await anonClient().rpc("rsvp_submit", {
      p_token_hash: s.inv.token.hash,
      p_client: client(),
      p_expected_version: s.v.version,
      p_responses: [{ memberId: s.adaM.id, status: "accepted", mealOptionId: null }],
    });
    expect(anonSubmit.error).not.toBeNull();
    expect(await rows(s.w)).toEqual([]);
  });

  it("is erased with its event, which is the only deletion allowed", async () => {
    const s = await single();
    await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", mealOptionId: null },
    ]);
    expect(await rows(s.w)).toHaveLength(1);
    await q("delete from public.events where id=$1", [s.e]);
    expect(await rows(s.w)).toEqual([]);
  });
});
