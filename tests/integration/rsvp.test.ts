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

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const newToken = () => {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha(raw) };
};
const client = () => `c-${randomUUID().slice(0, 12)}`;

beforeAll(async () => {
  owner = await createUser("rsvp-owner");
  stranger = await createUser("rsvp-stranger");
});

async function mkGuest(u: TestUser, w: string, name: string, household?: string) {
  const { data, error } = await u.client.rpc("create_guest", {
    p_wedding: w,
    p_guest: { name },
    ...(household && { p_household: household }),
  });
  if (error) throw new Error(error.message);
  return data as string;
}
async function mkEvent(u: TestUser, w: string, name = "Reception") {
  const { data, error } = await u.client.rpc("create_event", {
    p_wedding: w,
    p_event: { name, kind: "reception" },
  });
  if (error) throw new Error(error.message);
  return data as string;
}
async function mkMeal(u: TestUser, w: string, e: string, name: string) {
  const { data, error } = await u.client.rpc("add_meal_option", {
    p_wedding: w,
    p_event_id: e,
    p_name: name,
  });
  if (error) throw new Error(error.message);
  return data as string;
}
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function invite(
  u: TestUser,
  w: string,
  e: string,
  guestIds: string[],
  opts: { quota?: number; deadline?: string; expires?: string; key?: string } = {},
) {
  const t = newToken();
  const res = await u.client.rpc("create_invitations", {
    p_wedding: w,
    p_event_id: e,
    p_groups: [{ guestIds, householdId: null }],
    p_plus_one_quota: opts.quota ?? 0,
    p_expires_at: opts.expires ?? future(30),
    p_token_hashes: [t.hash],
    p_idempotency_key: opts.key ?? `key-${randomUUID()}`,
    ...(opts.deadline && { p_deadline: opts.deadline }),
  });
  return { ...res, token: t };
}
type View = {
  version: number;
  members: {
    id: string;
    name: string;
    status: string;
    mealOptionId: string | null;
    isPlusOne: boolean;
  }[];
  plusOneRemaining: number;
  closed: boolean;
};
async function view(raw: string, c = client()) {
  const r = await adminClient().rpc("rsvp_view", { p_token_hash: sha(raw), p_client: c });
  return { ...r, view: r.data as View | null };
}
function submit(
  raw: string,
  version: number,
  responses: unknown[],
  plusOne?: unknown,
  c = client(),
) {
  return adminClient().rpc("rsvp_submit", {
    p_token_hash: sha(raw),
    p_client: c,
    p_expected_version: version,
    p_responses: responses,
    ...(plusOne ? { p_plus_one: plusOne } : {}),
  });
}
async function count(sql: string, params: unknown[]) {
  return withSuperuser(async (db) => Number((await db.query(sql, params)).rows[0].n));
}

async function setup(quota = 0) {
  const w = await createWedding(owner);
  const e = await mkEvent(owner, w);
  const ada = await mkGuest(owner, w, "Ada Example");
  const bo = await mkGuest(owner, w, "Bo Example");
  const inv = await invite(owner, w, e, [ada, bo], { quota });
  if (inv.error) throw new Error(inv.error.message);
  const v = (await view(inv.token.raw)).view!;
  return { w, e, ada, bo, inv, token: inv.token, v, invId: inv.data![0].o_invitation_id as string };
}

describe("owner commands", () => {
  it("creates events, meals and invitations; replay returns the same invitations flagged", async () => {
    const w = await createWedding(owner);
    const e = await mkEvent(owner, w);
    const g = await mkGuest(owner, w, "Cy Example");
    const key = `key-${randomUUID()}`;
    const expires = future(30);
    const a = await invite(owner, w, e, [g], { key, expires });
    const b = await invite(owner, w, e, [g], { key, expires });
    expect(a.error).toBeNull();
    expect(a.data![0].o_replayed).toBe(false);
    expect(b.data![0].o_replayed).toBe(true);
    expect(b.data![0].o_invitation_id).toBe(a.data![0].o_invitation_id);
    expect(await count("select count(*) n from public.invitations where wedding_id=$1", [w])).toBe(
      1,
    );
  });

  it("refuses inviting a guest twice to the same event, and writes nothing", async () => {
    const w = await createWedding(owner);
    const e = await mkEvent(owner, w);
    const g1 = await mkGuest(owner, w, "Di Example");
    const g2 = await mkGuest(owner, w, "Ed Example");
    expect((await invite(owner, w, e, [g1])).error).toBeNull();
    const dup = await invite(owner, w, e, [g2, g1]);
    expect(dup.error?.code).toBe("23505");
    expect(await count("select count(*) n from public.invitations where wedding_id=$1", [w])).toBe(
      1,
    );
    expect(
      await count("select count(*) n from public.invitation_members where wedding_id=$1", [w]),
    ).toBe(1);
  });

  it("allows the same guest in two different events", async () => {
    const w = await createWedding(owner);
    const e1 = await mkEvent(owner, w, "Ceremony");
    const e2 = await mkEvent(owner, w, "Rehearsal");
    const g = await mkGuest(owner, w, "Flo Example");
    expect((await invite(owner, w, e1, [g])).error).toBeNull();
    expect((await invite(owner, w, e2, [g])).error).toBeNull();
  });

  it("rejects invalid payloads without side effects", async () => {
    const w = await createWedding(owner);
    const e = await mkEvent(owner, w);
    const g = await mkGuest(owner, w, "Gus Example");
    const bad = [
      invite(owner, w, e, [g], { quota: 6 }),
      invite(owner, w, e, [g], { expires: future(-1) }),
      invite(owner, w, e, [g], { deadline: future(40), expires: future(30) }),
      invite(owner, w, e, [randomUUID()]),
      invite(owner, w, e, [g, g]),
    ];
    for (const r of await Promise.all(bad)) expect(r.error?.code).toBe("22023");
    expect(await count("select count(*) n from public.invitations where wedding_id=$1", [w])).toBe(
      0,
    );
  });

  it("denies outsiders and forbids foreign guests/events", async () => {
    const w = await createWedding(owner);
    const e = await mkEvent(owner, w);
    const g = await mkGuest(owner, w, "Hal Example");
    expect((await invite(stranger, w, e, [g])).error?.code).toBe("42501");
    const other = await createWedding(stranger);
    expect((await invite(stranger, other, e, [g])).error).not.toBeNull();
    expect(
      (await stranger.client.rpc("create_event", { p_wedding: w, p_event: { name: "X" } })).error
        ?.code,
    ).toBe("42501");
    const anon = await anonClient().rpc("create_event", { p_wedding: w, p_event: { name: "X" } });
    expect(anon.error).not.toBeNull();
  });

  it("hides token_hash and denies direct writes and cross-tenant reads", async () => {
    const s = await setup();
    const sel = await owner.client.from("invitations").select("token_hash").eq("wedding_id", s.w);
    expect(sel.error).not.toBeNull();
    const ok = await owner.client.from("invitations").select("id, label").eq("wedding_id", s.w);
    expect(ok.data).toHaveLength(1);
    const foreign = await stranger.client.from("invitations").select("id").eq("wedding_id", s.w);
    expect(foreign.data).toEqual([]);
    const members = await stranger.client
      .from("invitation_members")
      .select("id")
      .eq("wedding_id", s.w);
    expect(members.data).toEqual([]);
    const write = await owner.client
      .from("invitation_members")
      .update({ rsvp_status: "accepted" })
      .eq("wedding_id", s.w);
    expect(write.error).not.toBeNull();
  });

  it("public RPCs are not callable by signed-in users or anon", async () => {
    const s = await setup();
    for (const c of [owner.client, anonClient()]) {
      const r = await c.rpc("rsvp_view", { p_token_hash: sha(s.token.raw), p_client: "x" });
      expect(r.error).not.toBeNull();
      const r2 = await c.rpc("rsvp_submit", {
        p_token_hash: sha(s.token.raw),
        p_client: "x",
        p_expected_version: 1,
        p_responses: [],
      });
      expect(r2.error).not.toBeNull();
    }
  });
});

describe("accountless response", () => {
  it("shows only this invitation's members and no contact details", async () => {
    const s = await setup();
    const other = await mkGuest(owner, s.w, "Zed Other");
    await invite(owner, s.w, s.e, [other]);
    expect(s.v.members.map((m) => m.name)).toEqual(["Ada Example", "Bo Example"]);
    expect(JSON.stringify(s.v)).not.toContain("Zed");
    expect(Object.keys(s.v.members[0]!).sort()).toEqual([
      "id",
      "isPlusOne",
      "mealOptionId",
      "name",
      "status",
    ]);
  });

  it("records per-person answers and meal; counts follow", async () => {
    const s = await setup();
    const meal = await mkMeal(owner, s.w, s.e, "Chicken");
    const [ada, bo] = s.v.members;
    const r = await submit(s.token.raw, s.v.version, [
      { memberId: ada!.id, status: "accepted", mealOptionId: meal },
      { memberId: bo!.id, status: "declined", mealOptionId: meal },
    ]);
    expect(r.error).toBeNull();
    const after = (r.data as View).members;
    expect(after.find((m) => m.name === "Ada Example")).toMatchObject({
      status: "accepted",
      mealOptionId: meal,
    });
    // A decline never keeps a meal.
    expect(after.find((m) => m.name === "Bo Example")).toMatchObject({
      status: "declined",
      mealOptionId: null,
    });
  });

  it("T09: answers are per event and do not cross events", async () => {
    const s = await setup();
    const e2 = await mkEvent(owner, s.w, "Rehearsal");
    const inv2 = await invite(owner, s.w, e2, [s.ada, s.bo]);
    const v2 = (await view(inv2.token.raw)).view!;
    await submit(s.token.raw, s.v.version, [{ memberId: s.v.members[0]!.id, status: "accepted" }]);
    await submit(inv2.token.raw, v2.version, [{ memberId: v2.members[0]!.id, status: "declined" }]);
    expect((await view(s.token.raw)).view!.members[0]!.status).toBe("accepted");
    expect((await view(inv2.token.raw)).view!.members[0]!.status).toBe("declined");
  });

  it("T16: forged member ids, other invitations' members and bad meals are refused", async () => {
    const s = await setup();
    const other = await mkGuest(owner, s.w, "Ivy Other");
    const inv2 = await invite(owner, s.w, s.e, [other]);
    const v2 = (await view(inv2.token.raw)).view!;
    for (const id of [v2.members[0]!.id, randomUUID()]) {
      const r = await submit(s.token.raw, s.v.version, [{ memberId: id, status: "accepted" }]);
      expect(r.error?.code).toBe("22023");
    }
    const mealElsewhere = await mkMeal(owner, s.w, await mkEvent(owner, s.w, "Brunch"), "Waffles");
    const r = await submit(s.token.raw, s.v.version, [
      { memberId: s.v.members[0]!.id, status: "accepted", mealOptionId: mealElsewhere },
    ]);
    expect(r.error?.code).toBe("22023");
    for (const status of ["pending", "maybe", ""]) {
      const bad = await submit(s.token.raw, s.v.version, [
        { memberId: s.v.members[0]!.id, status },
      ]);
      expect(bad.error?.code).toBe("22023");
    }
    expect((await view(s.token.raw)).view!.members.every((m) => m.status === "pending")).toBe(true);
  });

  it("detects stale versions and concurrent edits; exactly one of two same-version writes wins", async () => {
    const s = await setup();
    const id = s.v.members[0]!.id;
    const results = await Promise.all([
      submit(s.token.raw, s.v.version, [{ memberId: id, status: "accepted" }]),
      submit(s.token.raw, s.v.version, [{ memberId: id, status: "declined" }]),
    ]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(1);
  });

  it("T08: plus-one is created once; a repeat does not duplicate; quota is enforced", async () => {
    const s = await setup(1);
    const before = await count("select count(*) n from public.guests where wedding_id=$1", [s.w]);
    const first = await submit(s.token.raw, s.v.version, [], { name: "  Taylor   Example " });
    expect(first.error).toBeNull();
    const v1 = first.data as View;
    expect(v1.plusOneRemaining).toBe(0);
    expect(v1.members.filter((m) => m.isPlusOne)).toEqual([
      expect.objectContaining({ name: "Taylor Example", status: "accepted" }),
    ]);
    // Same request again with the fresh version: finds the same plus-one, creates nothing.
    const again = await submit(s.token.raw, v1.version, [], { name: "taylor example" });
    expect(again.error).toBeNull();
    // A different plus-one is over quota.
    const over = await submit(s.token.raw, (again.data as View).version, [], {
      name: "Someone Else",
    });
    expect(over.error?.code).toBe("RS422");
    // A stale replay of the very first request is refused outright.
    const stale = await submit(s.token.raw, s.v.version, [], { name: "Taylor Example" });
    expect(stale.error?.code).toBe("55000");
    expect(await count("select count(*) n from public.guests where wedding_id=$1", [s.w])).toBe(
      before + 1,
    );
    expect(
      await count("select plus_ones_used n from public.invitations where id=$1", [s.invId]),
    ).toBe(1);
  });

  it("concurrent plus-one requests respect the quota", async () => {
    const s = await setup(1);
    const rs = await Promise.all(
      ["Pat A", "Pat B", "Pat C"].map((name) => submit(s.token.raw, s.v.version, [], { name })),
    );
    expect(rs.filter((r) => r.error === null)).toHaveLength(1);
    expect(
      await count(
        "select count(*) n from public.guests where wedding_id=$1 and 'plus-one' = any(tags)",
        [s.w],
      ),
    ).toBe(1);
  });

  it("zero quota refuses a plus-one", async () => {
    const s = await setup(0);
    const r = await submit(s.token.raw, s.v.version, [], { name: "Nope Example" });
    expect(r.error?.code).toBe("RS422");
  });

  it("empty submissions are invalid", async () => {
    const s = await setup();
    expect((await submit(s.token.raw, s.v.version, [])).error?.code).toBe("22023");
  });

  it("deadline closes guest edits; owner override with a reason still works and is audited", async () => {
    const w = await createWedding(owner);
    const e = await mkEvent(owner, w);
    const g = await mkGuest(owner, w, "Jo Example");
    const inv = await invite(owner, w, e, [g], { deadline: future(1) });
    const v = (await view(inv.token.raw)).view!;
    await withSuperuser((db) =>
      db.query("update public.invitations set deadline = now() - interval '1 minute'"),
    );
    expect((await view(inv.token.raw)).view!.closed).toBe(true);
    const late = await submit(inv.token.raw, v.version, [
      { memberId: v.members[0]!.id, status: "accepted" },
    ]);
    expect(late.error?.code).toBe("RS410");
    const noReason = await owner.client.rpc("override_rsvp_response", {
      p_wedding: w,
      p_member_id: v.members[0]!.id,
      p_status: "accepted",
      p_reason: " ",
    });
    expect(noReason.error?.code).toBe("22023");
    const ok = await owner.client.rpc("override_rsvp_response", {
      p_wedding: w,
      p_member_id: v.members[0]!.id,
      p_status: "accepted",
      p_reason: "Told me by phone",
    });
    expect(ok.error).toBeNull();
    expect((await view(inv.token.raw)).view!.members[0]!.status).toBe("accepted");
    expect(
      await count(
        "select count(*) n from public.audit_events where wedding_id=$1 and action='rsvp.overridden'",
        [w],
      ),
    ).toBe(1);
    const denied = await stranger.client.rpc("override_rsvp_response", {
      p_wedding: w,
      p_member_id: v.members[0]!.id,
      p_status: "declined",
      p_reason: "x",
    });
    expect(denied.error?.code).toBe("42501");
  });

  it("T12: changing a meal updates counts once and a decline clears it", async () => {
    const s = await setup();
    const m1 = await mkMeal(owner, s.w, s.e, "Fish");
    const m2 = await mkMeal(owner, s.w, s.e, "Pasta");
    const id = s.v.members[0]!.id;
    const a = await submit(s.token.raw, s.v.version, [
      { memberId: id, status: "accepted", mealOptionId: m1 },
    ]);
    const b = await submit(s.token.raw, (a.data as View).version, [
      { memberId: id, status: "accepted", mealOptionId: m2 },
    ]);
    expect(b.error).toBeNull();
    const rows = await withSuperuser((db) =>
      db.query("select meal_option_id, rsvp_status from public.invitation_members where id=$1", [
        id,
      ]),
    );
    expect(rows.rows[0]).toEqual({ meal_option_id: m2, rsvp_status: "accepted" });
    const c = await submit(s.token.raw, (b.data as View).version, [
      { memberId: id, status: "declined" },
    ]);
    expect(c.error).toBeNull();
    const after = await withSuperuser((db) =>
      db.query("select meal_option_id from public.invitation_members where id=$1", [id]),
    );
    expect(after.rows[0].meal_option_id).toBeNull();
  });
});

describe("token lifecycle (T23)", () => {
  it("revoked, expired and unknown tokens are indistinguishable and cannot read or write", async () => {
    const s = await setup();
    const exp = await invite(owner, s.w, s.e, [await mkGuest(owner, s.w, "Kit Example")]);
    await withSuperuser((db) =>
      db.query(
        "update public.invitations set expires_at = now() - interval '1 second' where token_hash=$1",
        [sha(exp.token.raw)],
      ),
    );
    const rev = await owner.client.rpc("revoke_invitation", {
      p_wedding: s.w,
      p_invitation_id: s.invId,
      p_expected_version: 1,
    });
    expect(rev.error).toBeNull();
    for (const raw of [s.token.raw, exp.token.raw, newToken().raw]) {
      const r = await view(raw);
      expect(r.error).toBeNull();
      expect(r.data).toBeNull();
      const w = await submit(raw, 1, [{ memberId: s.v.members[0]!.id, status: "accepted" }]);
      expect(w.error).toBeNull();
      expect(w.data).toBeNull();
    }
    expect(
      await count(
        "select count(*) n from public.invitation_members where invitation_id=$1 and active",
        [s.invId],
      ),
    ).toBe(0);
  });

  it("revoking frees guests for a new invitation; reissue kills the old link", async () => {
    const s = await setup();
    const t2 = newToken();
    const re = await owner.client.rpc("reissue_invitation", {
      p_wedding: s.w,
      p_invitation_id: s.invId,
      p_expected_version: 1,
      p_token_hash: t2.hash,
    });
    expect(re.error).toBeNull();
    expect((await view(s.token.raw)).data).toBeNull();
    expect((await view(t2.raw)).view).not.toBeNull();
    expect((await invite(owner, s.w, s.e, [s.ada])).error?.code).toBe("23505");
    const stale = await owner.client.rpc("revoke_invitation", {
      p_wedding: s.w,
      p_invitation_id: s.invId,
      p_expected_version: 1,
    });
    expect(stale.error?.code).toBe("55000");
    await owner.client.rpc("revoke_invitation", {
      p_wedding: s.w,
      p_invitation_id: s.invId,
      p_expected_version: 2,
    });
    expect((await invite(owner, s.w, s.e, [s.ada])).error).toBeNull();
  });

  it("throttles repeated failures per client but not other clients", async () => {
    const c = client();
    for (let i = 0; i < 20; i++) expect((await view(newToken().raw, c)).data).toBeNull();
    expect((await view(newToken().raw, c)).error?.code).toBe("RS429");
    const s = await setup();
    expect((await view(s.token.raw, c)).error?.code).toBe("RS429");
    expect((await view(s.token.raw)).view).not.toBeNull();
  });

  it("audit entries for responses hold counts only, no names", async () => {
    const s = await setup(1);
    await submit(s.token.raw, s.v.version, [{ memberId: s.v.members[0]!.id, status: "accepted" }], {
      name: "Secret Plusone",
    });
    const rows = await withSuperuser((db) =>
      db.query(
        "select safe_changes from public.audit_events where wedding_id=$1 and action='rsvp.responded'",
        [s.w],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows[0])).not.toMatch(/Secret|Ada/);
  });
});
