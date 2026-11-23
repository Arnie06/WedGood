import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-07: guests tell the couple about dietary needs and accessibility through their RSVP link.
// Real local Postgres, PostgREST and RLS. Every sentinel below is synthetic.

let owner: TestUser;
let stranger: TestUser;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const newToken = () => {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha(raw) };
};
const client = () => `c-${randomUUID().slice(0, 12)}`;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const DIET = "SENTINEL-diet no peanuts";
const ACCESS = "SENTINEL-access step-free route";

beforeAll(async () => {
  owner = await createUser("details-owner");
  stranger = await createUser("details-stranger");
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows as T[]);
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}
const mkGuest = async (w: string, name: string, extra: Record<string, unknown> = {}) =>
  (await ok(
    owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name, ...extra } }),
  )) as string;
const mkEvent = async (w: string, name: string) =>
  (await ok(
    owner.client.rpc("create_event", { p_wedding: w, p_event: { name, kind: "other" } }),
  )) as string;
async function invite(w: string, e: string, guestIds: string[], quota = 0) {
  const t = newToken();
  const rows = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: e,
      p_groups: [{ guestIds, householdId: null }],
      p_plus_one_quota: quota,
      p_expires_at: future(30),
      p_token_hashes: [t.hash],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  return { id: rows[0]!.o_invitation_id, token: t };
}

type Member = {
  id: string;
  name: string;
  status: string;
  isPlusOne: boolean;
  detailsSaved: boolean;
  personKey: string;
};
type View = { version: number; members: Member[]; plusOneRemaining: number };

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
/**
 * The guest's words (`dietary`, `accessibility` here) live in their own columns; the couple's text
 * is returned as `couple_*` so tests can check it is never touched by a guest.
 */
const details = (guestId: string) =>
  q<{
    dietary: string | null;
    accessibility: string | null;
    couple_dietary: string | null;
    couple_accessibility: string | null;
    notes: string | null;
    guest_answered_at: string | null;
  }>(
    `select guest_dietary as dietary, guest_accessibility as accessibility,
            dietary as couple_dietary, accessibility as couple_accessibility,
            notes, guest_answered_at
       from public.guest_private_details where guest_id=$1`,
    [guestId],
  );

/** Ada and Bo invited to one event; Ada has a couple-entered private note already. */
async function setup(quota = 0) {
  const w = await createWedding(owner);
  const e = await mkEvent(w, "Reception");
  const ada = await mkGuest(w, "Ada Example");
  const bo = await mkGuest(w, "Bo Example");
  const inv = await invite(w, e, [ada, bo], quota);
  const v = await view(inv.token.raw);
  const m = (name: string) => v.members.find((x) => x.name === name)!;
  return { w, e, ada, bo, inv, v, adaM: m("Ada Example"), boM: m("Bo Example") };
}

describe("saving a guest's notes", () => {
  it("stores them on the guest's private row, trimmed, and marks them guest-answered", async () => {
    const s = await setup();
    const res = await submit(s.inv.token.raw, s.v.version, [
      {
        memberId: s.adaM.id,
        status: "accepted",
        mealOptionId: null,
        dietary: `  ${DIET}  `,
        accessibility: ACCESS,
      },
    ]);
    expect(res.error).toBeNull();
    const [row] = await details(s.ada);
    expect(row?.dietary).toBe(DIET);
    expect(row?.accessibility).toBe(ACCESS);
    expect(row?.notes).toBeNull();
    expect(row?.guest_answered_at).not.toBeNull();
    // Bo said nothing: no row at all.
    expect(await details(s.bo)).toEqual([]);
  });

  it("never returns the text, to anyone holding the link, and only says it is saved", async () => {
    const s = await setup();
    const sent = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", dietary: DIET, accessibility: ACCESS },
    ]);
    expect(sent.error).toBeNull();
    const again = await view(s.inv.token.raw);
    expect(again.members.find((m) => m.name === "Ada Example")?.detailsSaved).toBe(true);
    expect(again.members.find((m) => m.name === "Bo Example")?.detailsSaved).toBe(false);
    // The submit response and a fresh read: neither contains a trace of the text.
    for (const body of [JSON.stringify(sent.data), JSON.stringify(again)]) {
      expect(body).not.toContain("SENTINEL");
      expect(body).not.toContain("diet");
      expect(body).not.toContain("access");
    }
    expect(Object.keys(again.members[0]!).sort()).toEqual([
      "answered",
      "detailsSaved",
      "id",
      "isPlusOne",
      "mealOptionId",
      "name",
      "personKey",
      "status",
    ]);
  });

  it("keeps the text out of the audit trail and reply history", async () => {
    const s = await setup();
    await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", dietary: DIET, accessibility: ACCESS },
    ]);
    const audit = await q<{ t: string }>(
      "select safe_changes::text t from public.audit_events where wedding_id=$1",
      [s.w],
    );
    const history = await q<{ t: string }>(
      "select to_jsonb(c)::text t from public.rsvp_changes c where wedding_id=$1",
      [s.w],
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(history.length).toBeGreaterThan(0);
    for (const r of [...audit, ...history]) expect(r.t).not.toContain("SENTINEL");
  });

  it("is idempotent: the same answers again change nothing", async () => {
    const s = await setup();
    const body = [{ memberId: s.adaM.id, status: "accepted", dietary: DIET }];
    expect((await submit(s.inv.token.raw, s.v.version, body)).error).toBeNull();
    const after = await view(s.inv.token.raw);
    const audits = await q<{ n: string }>(
      "select count(*) n from public.audit_events where wedding_id=$1 and action='rsvp.responded'",
      [s.w],
    );
    const [before] = await details(s.ada);
    expect((await submit(s.inv.token.raw, after.version, body)).error).toBeNull();
    expect((await view(s.inv.token.raw)).version).toBe(after.version);
    expect(
      (
        await q<{ n: string }>(
          "select count(*) n from public.audit_events where wedding_id=$1 and action='rsvp.responded'",
          [s.w],
        )
      )[0]?.n,
    ).toBe(audits[0]?.n);
    expect((await details(s.ada))[0]?.guest_answered_at).toEqual(before?.guest_answered_at);
  });

  it("can be sent on its own for someone who already answered, and moves the version", async () => {
    const s = await setup();
    await submit(s.inv.token.raw, s.v.version, [{ memberId: s.adaM.id, status: "accepted" }]);
    const mid = await view(s.inv.token.raw);
    const res = await submit(s.inv.token.raw, mid.version, [
      { memberId: s.adaM.id, status: "accepted", dietary: DIET },
    ]);
    expect(res.error).toBeNull();
    expect((await view(s.inv.token.raw)).version).toBe(mid.version + 1);
    expect((await details(s.ada))[0]?.dietary).toBe(DIET);
  });

  it("a stale tab cannot overwrite newer notes", async () => {
    const s = await setup();
    await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", dietary: DIET },
    ]);
    const stale = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", dietary: "SENTINEL-other" },
    ]);
    expect(stale.error?.code).toBe("55000");
    expect((await details(s.ada))[0]?.dietary).toBe(DIET);
  });

  it("never replaces what the couple wrote: the guest's words are kept beside it", async () => {
    const w = await createWedding(owner);
    const e = await mkEvent(w, "Reception");
    const ada = await mkGuest(w, "Ada Example", {
      dietary: "COUPLE-diet",
      accessibility: "COUPLE-access",
      notes: "COUPLE-private note",
    });
    const inv = await invite(w, e, [ada]);
    const v = await view(inv.token.raw);
    // The couple's own note alone is not "saved by the guest".
    expect(v.members[0]!.detailsSaved).toBe(false);
    const res = await submit(inv.token.raw, v.version, [
      { memberId: v.members[0]!.id, status: "accepted", dietary: DIET },
    ]);
    expect(res.error).toBeNull();
    expect((await details(ada))[0]).toMatchObject({
      dietary: DIET,
      accessibility: null,
      couple_dietary: "COUPLE-diet",
      couple_accessibility: "COUPLE-access",
      notes: "COUPLE-private note",
    });
    // A later answer replaces only the guest's own earlier words.
    const v2 = await view(inv.token.raw);
    await submit(inv.token.raw, v2.version, [
      { memberId: v2.members[0]!.id, status: "accepted", accessibility: ACCESS },
    ]);
    expect((await details(ada))[0]).toMatchObject({
      dietary: DIET,
      accessibility: ACCESS,
      couple_dietary: "COUPLE-diet",
      couple_accessibility: "COUPLE-access",
    });
  });

  it("the couple clearing their own notes keeps the guest's words", async () => {
    const w = await createWedding(owner);
    const e = await mkEvent(w, "Reception");
    const ada = await mkGuest(w, "Ada Example", { dietary: "COUPLE-diet" });
    const inv = await invite(w, e, [ada]);
    const v = await view(inv.token.raw);
    await submit(inv.token.raw, v.version, [
      { memberId: v.members[0]!.id, status: "accepted", dietary: DIET },
    ]);
    const version = (
      await q<{ version: number }>("select version from public.guests where id=$1", [ada])
    )[0]!.version;
    await ok(
      owner.client.rpc("update_guest", {
        p_wedding: w,
        p_guest_id: ada,
        p_expected_version: version,
        p_guest: { name: "Ada Example" },
      }),
    );
    expect((await details(ada))[0]).toMatchObject({
      dietary: DIET,
      couple_dietary: null,
      couple_accessibility: null,
      notes: null,
    });
  });

  it("stores nothing for a decline, and blank text counts as nothing", async () => {
    const s = await setup();
    const res = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "declined", dietary: DIET, accessibility: ACCESS },
      { memberId: s.boM.id, status: "accepted", dietary: "   ", accessibility: null },
    ]);
    expect(res.error).toBeNull();
    expect(await details(s.ada)).toEqual([]);
    expect(await details(s.bo)).toEqual([]);
  });

  it("refuses over-long and non-text answers and writes nothing at all", async () => {
    const s = await setup();
    const bad: unknown[] = ["x".repeat(501), 42, { a: 1 }, ["x"], true];
    for (const dietary of bad) {
      const res = await submit(s.inv.token.raw, s.v.version, [
        { memberId: s.boM.id, status: "accepted" },
        { memberId: s.adaM.id, status: "accepted", dietary },
      ]);
      expect(res.error?.code).toBe("22023");
    }
    const live = await view(s.inv.token.raw);
    expect(live.version).toBe(s.v.version);
    expect(live.members.every((m) => m.status === "pending")).toBe(true);
    expect(await details(s.ada)).toEqual([]);
    // Exactly at the limit is fine (and counts characters, not bytes).
    const edge = await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", dietary: "é".repeat(500) },
    ]);
    expect(edge.error).toBeNull();
  });

  it("refuses notes for someone outside the invitation", async () => {
    const s = await setup();
    const other = await setup();
    const res = await submit(s.inv.token.raw, s.v.version, [
      { memberId: other.adaM.id, status: "accepted", dietary: DIET },
    ]);
    expect(res.error?.code).toBe("22023");
    expect(await details(other.ada)).toEqual([]);
  });

  it("a guest's answer makes an owner's older edit form stale instead of being overwritten", async () => {
    const s = await setup();
    const before = (
      await q<{ version: number }>("select version from public.guests where id=$1", [s.ada])
    )[0]!.version;
    await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", dietary: DIET },
    ]);
    const edit = await owner.client.rpc("update_guest", {
      p_wedding: s.w,
      p_guest_id: s.ada,
      p_expected_version: before,
      p_guest: { name: "Ada Example" },
    });
    expect(edit.error?.code).toBe("55000");
    expect((await details(s.ada))[0]?.dietary).toBe(DIET);
  });
});

describe("a guest the couple adds as a plus-one", () => {
  it("saves their notes with them, once, even if the request is repeated", async () => {
    const s = await setup(1);
    const plus = { name: "Cy Guest", mealOptionId: null, dietary: DIET, accessibility: ACCESS };
    const first = await submit(
      s.inv.token.raw,
      s.v.version,
      [{ memberId: s.adaM.id, status: "accepted" }],
      plus,
    );
    expect(first.error).toBeNull();
    const cy = (
      await q<{ id: string }>(
        "select id from public.guests where wedding_id=$1 and full_name='Cy Guest'",
        [s.w],
      )
    ).map((r) => r.id);
    expect(cy).toHaveLength(1);
    expect((await details(cy[0]!))[0]).toMatchObject({ dietary: DIET, accessibility: ACCESS });
    const live = await view(s.inv.token.raw);
    expect(live.members.find((m) => m.name === "Cy Guest")).toMatchObject({
      isPlusOne: true,
      detailsSaved: true,
    });
    const again = await submit(
      s.inv.token.raw,
      live.version,
      [{ memberId: s.adaM.id, status: "accepted" }],
      plus,
    );
    expect(again.error).toBeNull();
    expect(
      await q("select 1 from public.guests where wedding_id=$1 and full_name='Cy Guest'", [s.w]),
    ).toHaveLength(1);
    expect((await view(s.inv.token.raw)).version).toBe(live.version);
  });

  it("an over-long plus-one note refuses the whole send, including the guest", async () => {
    const s = await setup(1);
    const res = await submit(
      s.inv.token.raw,
      s.v.version,
      [{ memberId: s.adaM.id, status: "accepted" }],
      { name: "Cy Guest", mealOptionId: null, dietary: "x".repeat(501) },
    );
    expect(res.error?.code).toBe("22023");
    expect(
      await q("select 1 from public.guests where wedding_id=$1 and full_name='Cy Guest'", [s.w]),
    ).toEqual([]);
  });
});

describe("who can read the answers", () => {
  it("the couple can; a stranger and an anonymous caller cannot", async () => {
    const s = await setup();
    await submit(s.inv.token.raw, s.v.version, [
      { memberId: s.adaM.id, status: "accepted", dietary: DIET },
    ]);
    const mine = await owner.client
      .from("guest_private_details")
      .select("guest_dietary, guest_answered_at")
      .eq("guest_id", s.ada);
    expect(mine.data).toHaveLength(1);
    expect(mine.data?.[0]?.guest_dietary).toBe(DIET);
    const theirs = await stranger.client
      .from("guest_private_details")
      .select("dietary, guest_dietary")
      .eq("guest_id", s.ada);
    expect(theirs.data).toEqual([]);
  });

  it("the helper and the new column are not callable by signed-in or anonymous callers", async () => {
    const s = await setup();
    const call = await owner.client.rpc(
      "rsvp_save_details" as never,
      {
        p_member: s.adaM.id,
        p_src: { dietary: DIET },
      } as never,
    );
    expect(call.error).not.toBeNull();
    expect(await details(s.ada)).toEqual([]);
    const write = await owner.client
      .from("guest_private_details")
      .insert({ guest_id: s.ada, wedding_id: s.w, dietary: DIET });
    expect(write.error).not.toBeNull();
  });
});

describe("a party link", () => {
  async function party() {
    const w = await createWedding(owner, { name: "Party (example)" });
    const hh = (
      await q<{ id: string }>(
        "insert into public.households (wedding_id, name) values ($1,'The Examples') returning id",
        [w],
      )
    )[0]!.id;
    const g = async (name: string) =>
      (await ok(
        owner.client.rpc("create_guest", {
          p_wedding: w,
          p_guest: { name },
          p_household: hh,
        }),
      )) as string;
    const ada = await g("Ada Example");
    const bo = await g("Bo Example");
    const ceremony = await mkEvent(w, "Ceremony");
    const reception = await mkEvent(w, "Reception");
    const inv = async (e: string) => {
      const t = newToken();
      const rows = (await ok(
        owner.client.rpc("create_invitations", {
          p_wedding: w,
          p_event_id: e,
          p_groups: [{ guestIds: [ada, bo], householdId: hh }],
          p_plus_one_quota: 1,
          p_expires_at: future(30),
          p_token_hashes: [t.hash],
          p_idempotency_key: `key-${randomUUID()}`,
        }),
      )) as { o_invitation_id: string }[];
      return { id: rows[0]!.o_invitation_id, token: t };
    };
    const c = await inv(ceremony);
    const r = await inv(reception);
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
    type PEvent = {
      invitationId: string;
      version: number;
      event: { name: string };
      members: Member[];
    };
    const read = async () =>
      (
        await adminClient().rpc("rsvp_party_view", {
          p_token_hash: token.hash,
          p_client: client(),
        })
      ).data as { events: PEvent[] };
    return { w, ada, bo, token, read, c, r };
  }

  it("shows the same opaque person key on every event, and never the text", async () => {
    const p = await party();
    const v = await p.read();
    const keys = (name: string) =>
      v.events.map((e) => e.members.find((m) => m.name === name)!.personKey);
    expect(new Set(keys("Ada Example")).size).toBe(1);
    expect(new Set(keys("Bo Example")).size).toBe(1);
    expect(keys("Ada Example")[0]).not.toBe(keys("Bo Example")[0]);
    expect(JSON.stringify(v)).not.toContain(p.ada);
    expect(JSON.stringify(v)).not.toContain(p.bo);
  });

  it("saves notes from one send, marks the person saved on both events, and shows no text", async () => {
    const p = await party();
    const v = await p.read();
    const entry = (e: (typeof v.events)[number]) => ({
      invitationId: e.invitationId,
      expectedVersion: e.version,
      responses: e.members.map((m) => ({
        memberId: m.id,
        status: "accepted",
        mealOptionId: null,
        ...(m.name === "Ada Example" && { dietary: DIET, accessibility: ACCESS }),
      })),
      plusOne: null,
    });
    const res = await adminClient().rpc("rsvp_party_submit", {
      p_token_hash: p.token.hash,
      p_client: client(),
      p_replies: v.events.map(entry),
    });
    expect(res.error).toBeNull();
    expect(JSON.stringify(res.data)).not.toContain("SENTINEL");
    const after = await p.read();
    for (const e of after.events) {
      expect(e.members.find((m) => m.name === "Ada Example")?.detailsSaved).toBe(true);
      expect(e.members.find((m) => m.name === "Bo Example")?.detailsSaved).toBe(false);
    }
    expect(JSON.stringify(after)).not.toContain("SENTINEL");
    const rows = await details(p.ada);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dietary: DIET, accessibility: ACCESS });
    const audit = await q<{ t: string }>(
      "select safe_changes::text t from public.audit_events where wedding_id=$1",
      [p.w],
    );
    for (const r of audit) expect(r.t).not.toContain("SENTINEL");
  });

  it("a bad note on one event refuses the whole send", async () => {
    const p = await party();
    const v = await p.read();
    const res = await adminClient().rpc("rsvp_party_submit", {
      p_token_hash: p.token.hash,
      p_client: client(),
      p_replies: v.events.map((e, i) => ({
        invitationId: e.invitationId,
        expectedVersion: e.version,
        responses: e.members.map((m) => ({
          memberId: m.id,
          status: "accepted",
          mealOptionId: null,
          ...(i === 1 && m.name === "Ada Example" && { dietary: "x".repeat(501) }),
        })),
        plusOne: null,
      })),
    });
    expect(res.error?.code).toBe("22023");
    const after = await p.read();
    expect(after.events.every((e) => e.members.every((m) => m.status === "pending"))).toBe(true);
    expect(await details(p.ada)).toEqual([]);
  });
});
